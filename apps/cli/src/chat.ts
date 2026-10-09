import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { stdin } from 'node:process';
import { stderr, stdout } from './terminal-out.js';

import {
  approvalUpdatedAt,
  commitmentUpdatedAt,
  describeAnsweredVia,
  describeDenialFollowUp,
  describeManagerState,
  describeQuestionLines,
  describeReportDriftMark,
  describeSessionMissingKind,
  describeToolUseStall,
  describeTurnEnd,
  describeUnobservedOutcome,
  isFoldedTurnReport,
  JOURNAL_ENTRY_TYPES,
  jobStatusSchema,
  renderApprovalTrace,
  summarizeQuestions,
  usageLayerSchema,
  usageSiteSchema,
  type ApprovalSelection,
  type ApprovalTrace,
  type Commitment,
  type UnreadableApproval,
  type UnreadableCommitment,
  type UnreadableJob,
  type UnreadableSchedule,
  type UsageLayer,
  type UsageSite,
} from '@alteroid/core';
import {
  ARCHIVE_REMOVED_BYTES_UNIT_NOTE,
  describeGithubCi,
  codePointBoundary,
  JOURNAL_SEARCH_UNCOVERED_LIST,
} from '@alteroid/core/cli-light';
import {
  CGROUP_EVENTS_UNKNOWN_NOTE,
  formatCgroupEventsNote,
} from '@alteroid/core/cgroup-events-format';
import {
  JOURNAL_DIAGNOSTICS_TYPES,
  summarizeJournalDiagnosticsEntry,
  type JournalDiagnosticsEntryLike,
} from '@alteroid/core/journal-diagnostics-format';
import {
  formatSystemErrorFacts,
  formatSystemErrorUnknownNote,
} from '@alteroid/core/system-error-format';
import {
  describeUnpushedWorkObservationIncompleteness,
  describeUnpushedWorkObservationProvenance,
  describeUnpushedWorkObservationSource,
  isEmptyCompleteUnpushedWorkObservation,
} from '@alteroid/core/unpushed-work-observation-format';
import type { InferResponseType } from 'hono/client';

import { NON_TTY_HOW_TO, confirmInRepl } from './confirm.js';
import {
  AttachmentDraft,
  attachmentMissingMessageOf,
  createAttachmentDraft,
  expireUploads,
  type DraftFile,
  attachmentLinesOf,
  interpretAttachPath,
  describeAttachment,
  uploadAttachment,
  uploadDraft,
} from './attachments.js';
import { createClient, type DaemonClient } from './client.js';
import {
  fetchUnreadTotalLine,
  markConversationReadAfterReply,
  unreadMark,
} from './conversations.js';
import {
  approvalLine,
  approvalNoticeLines,
  fetchConversationApprovals,
  interleaveApprovals,
} from './conversation-approvals.js';
import { describeCliFailure, isConnectionFailure } from './failure-message.js';
import { formatElapsedAgo } from './format.js';
import {
  describeInterruptOutcome,
  requestInterruptOutcome,
  type InterruptTarget,
} from './interrupt.js';
import { redactBody, redactError } from './redact.js';
import { turnFailureHint } from './turn-failure.js';
import { withdrawnMessageText } from './withdrawn-message.js';
import { formatCreatedAt, freshnessMarker } from './memory.js';
import { parseSSEChunk, type SSEEvent } from './sse-frame.js';
import { describeAuthFailure, resolveTarget, type Target } from './target.js';
import { describeUsageDateOrder, narrowUsageAxis, renderUsage } from './usage.js';

type Activity =
  | { kind: 'clone'; turn?: TurnHandle }
  | {
      kind: 'local';
      abort: AbortController;
      notice: string;
      cancel: () => void;
      cancelled: Promise<typeof CANCELLED>;
    };

const CANCELLED = Symbol('cancelled');

const READ_CANCELLED_NOTICE =
  '（既読付けを取り消しました。返答は表示済みです。クローンのターンには触れていません）';

/** `clientMessageId` が `null` の間は Ctrl+C で対象を省かない: 省くと先客のターンを止めるため。 */
export interface TurnHandle {
  clientMessageId: string | null;
  conversationId: string | null;
  withdrawn: boolean;
  withdraw: () => void;
}

export interface ReplHooks {
  toTurn?: (turn?: TurnHandle) => void;
  toLocal?: (notice: string) => AbortSignal;
}

export async function chatCommand(): Promise<void> {
  const target = await resolveTarget();
  if (target.note !== null) {
    stdout.write(`${target.note}\n`);
    return;
  }
  const base = target.baseUrl;
  const client = createClient(base, target.headers);
  // コマンドは失敗を文にして書くだけで例外にしないので、非対話の失敗は通信の口で見る。
  let slashFailure: string | null = null;
  const interactive = stdin.isTTY === true;
  let activity: Activity | null = null;
  const localFetch =
    (countFailure: boolean, resultStatuses: readonly number[] = []): typeof fetch =>
    async (input, init) => {
      const current = activity?.kind === 'local' ? activity : null;
      const signal =
        current === null
          ? init?.signal
          : init?.signal == null
            ? current.abort.signal
            : AbortSignal.any([init.signal, current.abort.signal]);
      try {
        const response = await fetch(input, signal == null ? init : { ...init, signal });
        if (
          countFailure &&
          !response.ok &&
          !interactive &&
          !resultStatuses.includes(response.status)
        ) {
          slashFailure ??= `HTTP ${String(response.status)}`;
        }
        return response;
      } catch (error) {
        if (countFailure && !interactive && current?.abort.signal.aborted !== true) {
          slashFailure ??= error instanceof Error ? error.message : String(error);
        }
        throw error;
      }
    };
  const slashClient = createClient(base, target.headers, localFetch(true));
  // 付随の取得は失敗を数えない: 数えると、本体が成功したコマンドまで止まる。
  const auxClient = createClient(base, target.headers, localFetch(false));
  // 指した会話・承認・マネージャーが見つからない 404 は使い手の指定の誤りなので、これでなく `slashClient` のまま数える。
  const absentOkClient = createClient(base, target.headers, localFetch(true, [404, 410]));
  const removedOkClient = createClient(base, target.headers, localFetch(true, [410]));

  const rl = createInterface({ input: stdin, output: process.stdout });
  // `question()` を使わない: 待っていない間に届いた行（パイプの2行目以降）を捨てるため。
  // 積むのはパイプだけ。端末で積むと、読む前に打った行が送られ、確認の答えにもなる。
  const pendingLines: string[] = [];
  const typeahead: string[] = [];
  let heldDraft = false;
  let waiter: {
    resolve: (line: string) => void;
    reject: (error: Error) => void;
    cancelOnSigint: boolean;
  } | null = null;
  let inputClosed = false;
  const deliver = (text: string): void => {
    if (waiter === null) {
      if (interactive) typeahead.push(text);
      else pendingLines.push(text);
      return;
    }
    const { resolve } = waiter;
    waiter = null;
    resolve(text);
  };
  let pasting = false;
  const pasteLines: string[] = [];
  const continued: string[] = [];
  const onKeypress = (_: unknown, key: { name?: string } | undefined): void => {
    if (key?.name === 'paste-start') pasting = true;
    else if (key?.name === 'paste-end') {
      pasting = false;
      const partial = (rl as { line?: unknown }).line;
      const count = pasteLines.length + (typeof partial === 'string' && partial !== '' ? 1 : 0);
      if (pasteLines.length > 0) {
        stdout.write(`\n（貼り付けた ${String(count)} 行。まだ送っていません。Enter で送信）\n`);
        if (waiter !== null && stdin.isTTY === true) rl.prompt(true);
      }
    }
  };
  stdin.on('keypress', onKeypress);
  // 入力が閉じたとき readline が書きかけ（`refilled`）を最後の行として流すことがあるので、送らない。readline の `end` より先に印を付ける。
  let refilled: string | null = null;
  let inputEnded = false;
  stdin.prependListener('end', () => {
    inputEnded = true;
  });
  rl.on('line', (text) => {
    const wasRefilled = refilled;
    refilled = null;
    if (inputEnded && wasRefilled !== null && text === wasRefilled) return;
    if (pasting) {
      pasteLines.push(text);
      return;
    }
    const segment = [...pasteLines.splice(0), text].join('\n');
    if (heldDraft) {
      heldDraft = false;
      if (segment === '') {
        deliver(continued.splice(0).join('\n'));
        return;
      }
    }
    const head = (continued[0] ?? segment).trimStart();
    // コマンドの行は `\` を畳まない: パスの `\` がそのまま要る。
    if (!head.startsWith('/') || head.startsWith('//')) {
      const folded = foldTrailingBackslashes(segment);
      if (folded.continues) {
        continued.push(folded.text);
        if (waiter !== null && stdin.isTTY === true) {
          rl.setPrompt('… ');
          rl.prompt();
        }
        return;
      }
      deliver([...continued.splice(0), folded.text].join('\n'));
      return;
    }
    deliver([...continued.splice(0), segment].join('\n'));
  });
  const discardDraft = (): void => {
    const discarded = continued.length + pasteLines.length;
    continued.splice(0);
    pasteLines.splice(0);
    if (discarded > 0) stderr.write('\n（書きかけの入力を捨てました。送っていません）\n');
  };
  // node v22 は、パイプの EOF で `question()` を resolve も reject もしないので、自分で打ち切る。
  rl.once('close', () => {
    if (heldDraft) {
      continued.splice(0);
      heldDraft = false;
    }
    if (stdin.isTTY === true) {
      discardDraft();
      inputClosed = true;
      waiter?.reject(new Error('input closed'));
      waiter = null;
      return;
    }
    const rest = [
      ...continued.splice(0),
      ...(pasteLines.length > 0 ? [pasteLines.splice(0).join('\n')] : []),
    ];
    if (rest.length > 0) deliver(rest.join('\n'));
    inputClosed = true;
    waiter?.reject(new Error('input closed'));
    waiter = null;
  });
  // `SIGINT` を購読すると readline は自分では閉じなくなるので、閉じる側はここで担う。
  let interrupting = false;
  rl.on('SIGINT', () => {
    // 確認の Ctrl+C で入力ごと閉じない: 「やめる」つもりの1回で chat が終わり、終了時の送信と蒸留まで走る。
    if (waiter?.cancelOnSigint === true) {
      const { reject } = waiter;
      waiter = null;
      (rl as { write?: (data: null, key: { ctrl: boolean; name: string }) => void }).write?.(null, {
        ctrl: true,
        name: 'u',
      });
      stdout.write('\n');
      reject(new Error('confirm cancelled'));
      return;
    }
    if (waiter !== null || inputClosed) {
      // close の後始末が書きかけを渡してしまうので、先に空にする。
      discardDraft();
      rl.close();
      return;
    }
    if (activity?.kind === 'local') {
      if (activity.abort.signal.aborted) return;
      activity.abort.abort();
      activity.cancel();
      flushRenderedText?.();
      stdout.write(`\n${activity.notice}\n`);
      return;
    }
    if (interrupting) return;
    const turn = activity?.kind === 'clone' ? activity.turn : undefined;
    let aim: InterruptTarget | undefined;
    if (turn !== undefined) {
      if (turn.conversationId === null) {
        flushRenderedText?.();
        stdout.write(
          '\n会話がまだ確定していないので、何も止めていません。少し待ってから、もう一度 Ctrl+C を押してください。\n',
        );
        return;
      }
      if (turn.clientMessageId === null) {
        flushRenderedText?.();
        stdout.write(
          '\n止める対象が分からないので、何も止めていません（走っているのが、この会話の別の起点のターンかもしれません）。\n',
        );
        return;
      }
      aim = { conversationId: turn.conversationId, clientMessageId: turn.clientMessageId };
    }
    interrupting = true;
    void requestInterruptOutcome(client, target, aim)
      .then(
        (outcome) => {
          // 取り下げた発言の SSE には終端が流れないので、自分で閉じる。
          if (outcome === 'withdrawn') turn?.withdraw();
          flushRenderedText?.();
          stdout.write(`\n${describeInterruptOutcome(outcome)}\n`);
        },
        (error: unknown) => {
          flushRenderedText?.();
          stdout.write(`\nエラー: ${describeCliFailure(error)}\n`);
        },
      )
      .finally(() => {
        interrupting = false;
      });
  });
  const bracketedPaste = stdin.isTTY === true && process.stdout.isTTY === true;
  if (bracketedPaste) process.stdout.write('\x1b[?2004h');
  let abortReason: string | null = null;
  const ask = (
    question: string,
    options?: { restoreTyped?: boolean; cancelOnSigint?: boolean },
  ): Promise<string> => {
    const queued = pendingLines.shift();
    if (queued !== undefined) {
      stdout.write(question);
      return Promise.resolve(queued);
    }
    if (inputClosed) {
      if (typeahead.length > 0) {
        stderr.write('\n（応答中に打った入力は、送らないまま終わりました）\n');
        typeahead.splice(0);
      }
      return Promise.reject(new Error('input closed'));
    }
    if (options?.restoreTyped !== false && typeahead.length > 0) {
      const lines = typeahead.splice(0).join('\n').split('\n');
      stdout.write(
        `\n（応答中に打った ${String(lines.length)} 行は、まだ送っていません。Enter で送信）\n`,
      );
      if (lines.length > 1 || continued.length > 0) {
        stdout.write(`${[...lines, ...continued].join('\n')}\n`);
        continued.unshift(...lines);
        heldDraft = true;
        rl.setPrompt('… ');
        rl.prompt();
        return new Promise((resolve, reject) => {
          waiter = { resolve, reject, cancelOnSigint: options?.cancelOnSigint === true };
        });
      }
      rl.setPrompt(question);
      rl.prompt();
      const promise = new Promise<string>((resolve, reject) => {
        waiter = { resolve, reject, cancelOnSigint: options?.cancelOnSigint === true };
      });
      refilled = lines[0] ?? '';
      rl.write(refilled);
      return promise;
    }
    rl.setPrompt(continued.length > 0 ? '… ' : question);
    rl.prompt();
    return new Promise((resolve, reject) => {
      waiter = { resolve, reject, cancelOnSigint: options?.cancelOnSigint === true };
    });
  };
  const enterLocal = (notice: string) => {
    const abort = new AbortController();
    let cancel = (): void => {};
    const cancelled = new Promise<typeof CANCELLED>((resolve) => {
      cancel = () => {
        resolve(CANCELLED);
      };
    });
    const entry = { kind: 'local' as const, abort, notice, cancel, cancelled };
    activity = entry;
    return entry;
  };
  const hooks: ReplHooks = {
    toTurn: (turn) => {
      // 描く区間の入り直し（`turn` 無し）で、送信が渡した対象を落とさない。
      if (turn === undefined && activity?.kind === 'clone') return;
      activity = turn === undefined ? { kind: 'clone' } : { kind: 'clone', turn };
    },
    toLocal: (notice) => enterLocal(notice).abort.signal,
  };
  const runLocal = async <T>(
    notice: string,
    op: (signal: AbortSignal) => Promise<T>,
  ): Promise<T | typeof CANCELLED> => {
    const entry = enterLocal(notice);
    try {
      return await Promise.race([op(entry.abort.signal), entry.cancelled]);
    } catch (error) {
      if (entry.abort.signal.aborted) return CANCELLED;
      throw error;
    } finally {
      activity = null;
    }
  };
  let unsent = null as string | null;
  const reprintUnsent = (): void => {
    const body = unsent;
    unsent = null;
    if (body === null || body.length === 0) return;
    const out = interactive ? stdout : stderr;
    out.write('送れなかった本文:\n');
    // 行末の `\` は倍にして戻す: そのまま貼り直すと、末尾の `\` 1つが続きの印になり別の本文になる。
    out.writeRaw(`${body.replace(/\\+(?=\n|$)/g, (run) => run + run)}\n`);
  };
  const reportWithdrawnFiles = (files: readonly DraftFile[]): void => {
    if (files.length === 0) return;
    const out = interactive ? stdout : stderr;
    out.write(
      `添えていたファイル（${files.length} 件: ${files.map((f) => f.name).join(', ')}）は戻っていません。` +
        '送り直すなら /attach で添え直してください\n',
    );
  };
  const draft = createAttachmentDraft(target);
  let editing: EditInProgress | null = null;
  let conversationId: string | null = null;
  // 引き直さずに送ると、次の発言が新しい会話に入って会話が黙って分かれる。
  let unopened: string | null = null;
  const listed: Listed = {
    approvals: [],
    managerAnchors: {},
    commitments: [],
    conversations: [],
    managers: [],
    waiting: [],
    messages: [],
    messagesConversationId: null,
    messageAttachments: {},
    messageTexts: {},
  };

  stdout.write(
    'alteroid chat（Ctrl-D で終了 / 応答中の Ctrl-C でターンを止める / 行末の \\ で改行・貼り付けは1発言 / /help でコマンド）\n',
  );

  try {
    for (;;) {
      unsent = null;
      let line: string;
      let typed: string;
      let body: string;
      try {
        const raw = await ask('> ');
        line = raw.trim();
        typed = raw.trimEnd();
        body = typed;
      } catch {
        break; // Ctrl-C・入力の終わり（EOF）
      }
      try {
        if (line.length === 0 && draft.count === 0) {
          if (editing !== null) stdout.write(`${EDIT_EMPTY_MESSAGE}\n`);
          continue;
        }

        if (/^\/(attach|attachments|detach)(\s|$)/.test(line)) {
          slashFailure = null;
          const attached = await runLocal(
            `（${line.split(/\s+/)[0] ?? ''} を取り消しました。クローンのターンには触れていません）`,
            () =>
              runAttachmentCommand(line, draft, (reason) => {
                slashFailure ??= reason;
              }),
          );
          if (attached === CANCELLED) continue;
          if (slashFailure !== null && !interactive) {
            abortReason = `コマンド ${line.split(/\s+/)[0] ?? ''} が失敗した（${redactError(slashFailure)}）`;
            break;
          }
          continue;
        }

        const editCommand = runEditDraftCommand(line, listed, draft, editing);
        if (editCommand.handled) {
          editing = editCommand.editing;
          continue;
        }

        if (/^\/resume(\s|$)/.test(line)) {
          slashFailure = null;
          const resumed = await runLocal(
            '（/resume を取り消しました。クローンのターンには触れていません）',
            (signal) =>
              runResumeCommand(
                line,
                target,
                (reason) => {
                  slashFailure ??= reason;
                },
                { ...hooks, signal },
                listed,
              ),
          );
          if (resumed === CANCELLED) {
            slashFailure = null;
            continue;
          }
          if (resumed !== null) {
            conversationId = resumed;
            unopened = null;
          }
          if (slashFailure !== null && !interactive) {
            abortReason = `コマンド ${line.split(/\s+/)[0] ?? ''} が失敗した（${redactError(slashFailure)}）`;
            break;
          }
          continue;
        }

        if (line.startsWith('//')) {
          body = body.replace('/', '');
        } else if (line.startsWith('/')) {
          slashFailure = null;
          const handled = await runLocal(
            `（${line.split(/\s+/)[0] ?? ''} を取り消しました。クローンのターンには触れていません）`,
            () =>
              runSlashCommand(
                line,
                slashClient,
                listed,
                conversationId,
                target,
                async (summary) => {
                  const confirmed = await confirmInRepl(summary, (question) =>
                    ask(question, { restoreTyped: false, cancelOnSigint: true }),
                  );
                  if (!confirmed && !interactive) {
                    slashFailure ??= `確認できないので実行していない。${NON_TTY_HOW_TO}`;
                  }
                  return confirmed;
                },
                (reason) => {
                  slashFailure ??= reason;
                },
                hooks,
                auxClient,
                absentOkClient,
                removedOkClient,
              ),
          );
          if (handled === CANCELLED) {
            slashFailure = null;
            continue;
          }
          if (handled === 'quit') break;
          if (slashFailure !== null && !interactive) {
            abortReason = `コマンド ${line.split(/\s+/)[0] ?? ''} が失敗した（${redactError(slashFailure)}）`;
            break;
          }
          continue;
        }

        // 引けなかったら黙って新しい会話として送らない（readline は入力を残せないので、もう一度送ってもらう）。
        if (editing === null && conversationId === null && unopened !== null) {
          try {
            const unopenedId = unopened;
            const checked = await runLocal(
              '（前の送信の確認を取り消しました。発言は送っていません。もう一度送ってください）',
              (signal) => findClientMessage(target, unopenedId, signal),
            );
            if (checked === CANCELLED) continue;
            const found = checked;
            unopened = null;
            if (found !== undefined) {
              conversationId = found;
              stdout.write(`前の送信は受け取られていました。その会話（${found}）へ送ります\n`);
            }
          } catch (error) {
            stdout.write(
              `前の送信が受け取られたか確かめられなかったので、送っていません（${describeCliFailure(error)}）。\n` +
                '同じ内容をもう一度送ってください（確かめ直します。添えかけは残してあります）\n',
            );
            unsent = typed;
            reprintUnsent();
            if (!interactive) {
              abortReason = `前の送信が受け取られたか確かめられなかった（${describeCliFailure(error)}）`;
              break;
            }
            continue;
          }
        }

        let attachmentIds: string[] | undefined;
        let sentFiles: DraftFile[] = [];
        if (draft.count > 0) {
          const uploaded = await runLocal(
            '（添付のアップロードを取り消しました。発言は送っていません。添えかけは残してあります）',
            (signal) => uploadDraft(draft, (file) => uploadAttachment(target, file, signal)),
          );
          if (uploaded === CANCELLED) continue;
          if (!uploaded.ok) {
            stdout.write(
              `添付を上げられなかったので送っていません: ${uploaded.reason}\n` +
                '（添えかけは残してあります。/attachments で確認、/detach で外せます）\n',
            );
            unsent = typed;
            reprintUnsent();
            if (!interactive) {
              abortReason = `添付を上げられなかった: ${uploaded.reason}`;
              break;
            }
            continue;
          }
          attachmentIds = uploaded.uploaded.map((a) => a.id);
          sentFiles = uploaded.files;
          for (const a of uploaded.uploaded) stdout.write(`  ${describeAttachment(a)}\n`);
        }
        let sendFailure: string | null = null;
        let withdrawn = false;
        let accepted = false;
        unsent = typed;
        const edit = editing;
        const sentTo = await sendMessage(
          target,
          body,
          edit === null ? conversationId : edit.conversationId,
          edit?.id,
          {
            onFailed: (reason) => {
              sendFailure = reason;
            },
            onWithdrawn: () => {
              withdrawn = true;
              unsent = typed;
              if (edit !== null) editing = edit;
            },
            ...(attachmentIds === undefined ? {} : { attachments: attachmentIds }),
            onAccepted: () => {
              unsent = null;
              accepted = true;
              draft.discard(sentFiles);
              if (edit !== null) {
                editing = null;
                retireListedMessage(listed, edit.id);
              }
            },
            onUnopened: (clientMessageId) => {
              unopened = clientMessageId;
            },
            onAttachmentMissing: (message) => {
              stdout.write(`${expireUploads(sentFiles, message)}\n`);
            },
            hooks,
          },
        ).finally(() => {
          activity = null;
        });
        if (edit === null) conversationId = sentTo;
        if (sendFailure !== null || withdrawn) reprintUnsent();
        if (withdrawn && accepted) reportWithdrawnFiles(sentFiles);
        if (sendFailure !== null && !interactive) {
          abortReason = `送信に失敗した（${sendFailure}）`;
          break;
        }
      } catch (error) {
        const reason = describeCliFailure(error);
        stdout.write(`エラー: ${reason}\n`);
        reprintUnsent();
        if (!interactive) {
          // 案内の文は句点で終わる。理由のあとに足す「。入力が端末でないので…」と重ねない
          abortReason = reason.replace(/。$/, '');
          break;
        }
      }
    }
  } finally {
    stdin.off('keypress', onKeypress);
    if (bracketedPaste) process.stdout.write('\x1b[?2004l');
    rl.close();
    if (conversationId) {
      await endConversationOnExit(client, target, conversationId);
    }
  }
  if (abortReason !== null) {
    throw new Error(
      `${abortReason}。入力が端末でないので、ここで止めました（残りの入力は読んでいません）`,
    );
  }
}

// 畳まずに送ると `\` で終わる本文を送る方法が無くなる。
export function foldTrailingBackslashes(line: string): { text: string; continues: boolean } {
  const trailing = /\\+$/.exec(line);
  if (trailing === null) return { text: line, continues: false };
  const count = trailing[0].length;
  return {
    text: line.slice(0, line.length - count) + '\\'.repeat(Math.floor(count / 2)),
    continues: count % 2 === 1,
  };
}

export function continuesLine(line: string): boolean {
  const trailing = /\\+$/.exec(line);
  return trailing !== null && trailing[0].length % 2 === 1;
}

async function confirmRepl(
  confirm: ((summary: string) => Promise<boolean>) | undefined,
  summary: string,
  onFailed?: (reason: string) => void,
): Promise<boolean> {
  if (confirm === undefined) {
    stdout.write(
      `${summary}\n取り消せない操作で、確認できないので実行しません。何も変更していません。\n`,
    );
    onFailed?.('確認できないので実行していない');
    return false;
  }
  return confirm(summary);
}

export async function sendMessage(
  target: Target,
  text: string,
  conversationId: string | null,
  supersedes?: string,
  options: {
    attachments?: string[];
    onAccepted?: () => void;
    onUnopened?: (clientMessageId: string) => void;
    onAttachmentMissing?: (message: string) => void;
    onFailed?: (reason: string) => void;
    onWithdrawn?: () => void;
    hooks?: ReplHooks;
  } = {},
): Promise<string | null> {
  // 送信ごとに新しい id: 取り下げた id での再送は重複として受理されて配られない。
  const clientMessageId = randomUUID();
  const stream = new AbortController();
  const turn: TurnHandle = {
    clientMessageId,
    conversationId,
    withdrawn: false,
    withdraw: () => {
      turn.withdrawn = true;
      stream.abort();
    },
  };
  options.hooks?.toTurn?.(turn);
  // SSE は hono/client ではなく生の fetch で受ける: EventSource は POST もヘッダ付与もできない。
  const response = await fetch(`${target.baseUrl}/chat`, {
    method: 'POST',
    signal: stream.signal,
    headers: { ...target.headers, 'content-type': 'application/json' },
    body: JSON.stringify({
      text,
      conversationId: conversationId ?? undefined,
      clientMessageId,
      ...(supersedes === undefined ? {} : { supersedes }),
      ...(options.attachments === undefined || options.attachments.length === 0
        ? {}
        : { attachments: options.attachments }),
    }),
  }).catch((error: unknown) => {
    if (turn.withdrawn) return null;
    throw error;
  });
  if (response === null) {
    options.onWithdrawn?.();
    return conversationId;
  }

  if (!response.ok || !response.body) {
    const described = describeAuthFailure(response.status, target);
    if (described !== null) {
      stdout.write(`${described}\n`);
      options.onFailed?.(described);
      return conversationId;
    }
    const failed = { status: response.status, body: await response.json().catch(() => null) };
    const missing = attachmentMissingMessageOf(failed.body);
    // 本文の `error` をそのまま出す: 一律に潰すと、`/edit` がクローンの応答を指したときの案内が人間に届かない。
    const detail = await errorDetail({
      status: failed.status,
      json: () => Promise.resolve(failed.body),
    });
    stdout.write(`エラー: ${detail}\n`);
    options.onFailed?.(detail);
    if (missing !== null) options.onAttachmentMissing?.(missing);
    return conversationId;
  }

  options.onAccepted?.();
  const next = await renderChatEvents(
    target,
    readSSE(response.body),
    conversationId,
    options.onFailed,
    false,
    options.hooks,
    turn,
  );
  if (turn.withdrawn) options.onWithdrawn?.();
  if (conversationId === null && next === null) options.onUnopened?.(clientMessageId);
  return next;
}

// 404 以外の失敗は投げる: 「受け取っていない」と「確かめられなかった」を取り違えない。
export async function findClientMessage(
  target: Target,
  clientMessageId: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const response = await fetch(
    `${target.baseUrl}/client-messages/${encodeURIComponent(clientMessageId)}`,
    { headers: target.headers, ...(signal === undefined ? {} : { signal }) },
  );
  if (response.status === 404) return undefined;
  if (!response.ok) {
    const described = describeAuthFailure(response.status, target);
    if (described !== null) throw new Error(described);
    throw new Error(await errorDetail({ status: response.status, json: () => response.json() }));
  }
  const body: unknown = await response.json();
  const id =
    typeof body === 'object' && body !== null && 'conversationId' in body
      ? (body as { conversationId?: unknown }).conversationId
      : undefined;
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error('応答に会話 id がありませんでした');
  }
  return id;
}

let flushRenderedText: (() => void) | null = null;

// `sendMessage` の本体を切り出したもの。描き方を2か所に写すと、片方の伏せ字や既読の扱いだけがずれる。
async function renderChatEvents(
  target: Target,
  events: AsyncIterable<SSEEvent>,
  conversationId: string | null,
  onFailed?: (reason: string) => void,
  resuming = false,
  hooks?: ReplHooks,
  turn?: TurnHandle,
): Promise<string | null> {
  hooks?.toTurn?.(turn);
  let nextConversationId = conversationId;
  let wrote = false;
  let completed = false;
  let failedOrLimited = false;
  let ended = false;
  let sawEvent = false;
  // 本文は改行までためて、行ごとに伏せてから書く: チャンクごとに伏せると、2つのチャンクにまたがったトークンは
  // どちらの断片も規則に合わずに出る。端末へ書いたものは取り消せない。
  let pending = '';
  const flushPending = (): void => {
    if (pending === '') return;
    stdout.write(redactBody(pending));
    pending = '';
  };
  // パイプへは足さない: 出力を読む道具に、本文でない行を混ぜない。本文を書いたあとは出さない:
  // 改行の無い本文の行の途中へ書くと、次の消去がその本文の行を消してしまう。
  let statusShown = false;
  const clearStatus = (): void => {
    if (!statusShown) return;
    stdout.writeRaw('\r\x1b[2K');
    statusShown = false;
  };
  const showStatus = (label: string): void => {
    if (!stdout.isTTY || wrote) return;
    stdout.writeRaw(`  … ${label}`);
    statusShown = true;
  };
  // 描いている間だけ、溜めた断片を書き切る口を公開する。Ctrl-C で止めた文は、先に届いていた断片の後ろへ回さない。
  const outerFlush = flushRenderedText;
  flushRenderedText = flushPending;

  try {
    for await (const event of events) {
      sawEvent = true;
      clearStatus();
      if (event.name !== 'text') flushPending();
      switch (event.name) {
        case 'open': {
          const data = event.json<{ conversationId: string; pending?: unknown }>();
          if (data) {
            nextConversationId = data.conversationId;
            if (turn !== undefined) {
              turn.conversationId = data.conversationId;
              if (resuming) turn.clientMessageId = pickResumeTarget(data.pending);
            }
          }
          break;
        }
        case 'text': {
          const data = event.json<{ text: string }>();
          if (data) {
            pending += data.text;
            const lineEnd = pending.lastIndexOf('\n');
            if (lineEnd !== -1) {
              stdout.write(redactBody(pending.slice(0, lineEnd + 1)));
              pending = pending.slice(lineEnd + 1);
            }
            wrote = true;
          }
          break;
        }
        case 'tool': {
          const data = event.json<{ tool: string }>();
          if (data) stdout.write(`\n  · ${data.tool}\n`);
          break;
        }
        case 'ask_human': {
          const data = event.json<{ approvalId: string; question: string }>();
          if (data) {
            stdout.write(
              `\n  ? 人間への確認（${data.approvalId}）: ${redactBody(data.question)}\n`,
            );
            stdout.write('    /answer <id> <回答> で返せます\n');
          }
          break;
        }
        case 'attachments': {
          const data = event.json<{
            attachments: { id: string; name: string; mediaType: string; size: number }[];
          }>();
          if (data) {
            for (const item of data.attachments) {
              stdout.write(`\n  ${redactBody(describeAttachment(item))}\n`);
              stdout.write(`    alteroid attachments get ${item.id} で取り出せます\n`);
            }
          }
          break;
        }
        case 'usage_limited': {
          ended = true;
          const data = event.json<{ message: string }>();
          if (data) {
            stdout.write(`\n  ! ${redactError(data.message)}\n`);
            stdout.write(
              '    （この発言は保持されていて、次に枠が開いたときに配り直されて試し直される）\n',
            );
          }
          onFailed?.('利用の枠の上限に達した（発言は保持されていて、あとで配り直される）');
          failedOrLimited = true;
          break;
        }
        case 'done':
          ended = true;
          completed = true;
          break;
        case 'error': {
          ended = true;
          failedOrLimited = true;
          const data = event.json<{ message: string; kind?: string }>();
          stdout.write(`\nエラー: ${data ? redactError(data.message) : '不明'}\n`);
          // 文面からは推し量らない: 種別はデーモンが `kind` で運ぶ。
          const hint = turnFailureHint(data?.kind);
          if (hint !== null) stdout.write(`${hint}\n`);
          onFailed?.(`応答がエラーで終わった（${data ? redactError(data.message) : '不明'}）`);
          break;
        }
        case 'queued':
          showStatus('順番を待っている');
          break;
        case 'thinking':
          showStatus('考えている');
          break;
        default:
          break;
      }
    }
  } catch (error) {
    clearStatus();
    flushPending();
    ended = true;
    const reason = redactError(error instanceof Error ? error.message : String(error));
    if (turn?.withdrawn === true) {
      // 取り下げて自分で閉じた。切断ではない。
    } else if (resuming) {
      const described = `進行中の応答に戻れませんでした: 接続が切れました（${reason}）`;
      stdout.write(`\nエラー: ${described}\n`);
      onFailed?.(described);
    } else {
      stdout.write(`\nエラー: 応答が途中で切れました（${reason}）\n`);
      // 何も受け取る前の切断は、デーモンがターンを受けたか分からないので、続いているとは言わない。
      if (sawEvent) {
        stdout.write(
          '  ターンはデーモンで続いています。/resume で戻れます（頭から流れ直すので、見えた分と重なります）。\n' +
            '  完成した返信は /conversation で読めます\n',
        );
      }
      onFailed?.(`応答が途中で切れた（${reason}）`);
    }
    failedOrLimited = true;
  }

  clearStatus();
  flushPending();
  flushRenderedText = outerFlush;
  if (wrote) stdout.write('\n');
  if (!ended && turn?.withdrawn !== true) {
    stdout.write(
      !sawEvent
        ? '  ! 応答が来ないまま接続が閉じました。発言が受け取られたかは分かりません\n'
        : '  ! 応答が途中で切れました（done も error も来ないまま接続が閉じました。出ているのは受け取った分だけです）\n',
    );
    onFailed?.('応答が終端の無いまま切れた（done も error も来なかった）');
  }
  if (completed && !failedOrLimited && nextConversationId !== null) {
    const signal = hooks?.toLocal?.(READ_CANCELLED_NOTICE);
    await markConversationReadAfterReply(target, nextConversationId, signal);
  }
  return nextConversationId;
}

export { parseSSEChunk, type SSEEvent };

async function* readSSE(body: ReadableStream<Uint8Array>): AsyncGenerator<SSEEvent> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffer = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let boundary = buffer.indexOf('\n\n');
    while (boundary !== -1) {
      const chunk = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const parsed = parseSSEChunk(chunk);
      if (parsed) yield parsed;
      boundary = buffer.indexOf('\n\n');
    }
  }
}

const RESUME_PROBE_LIMIT = 5;

async function openChatStream(
  target: Target,
  conversationId: string,
  signal: AbortSignal,
): Promise<ReadableStream<Uint8Array>> {
  const what = '進行中の応答に戻れませんでした';
  let response: Response;
  try {
    response = await fetch(`${target.baseUrl}/chat/${encodeURIComponent(conversationId)}/stream`, {
      method: 'GET',
      headers: { ...target.headers, 'content-type': 'application/json' },
      signal,
    });
  } catch (error) {
    throw new Error(
      isConnectionFailure(error)
        ? `${what}: ${describeCliFailure(error)}`
        : `${what}: デーモンに繋がりません（${redactError(String(error))}）`,
      { cause: error },
    );
  }
  if (!response.ok || !response.body) {
    const described = describeAuthFailure(response.status, target);
    throw new Error(described ?? `${what}: ${await errorDetail(response)}`);
  }
  return response.body;
}

// `held`・`queued` は選ばない: 再生しているのは走っているターンで、それが `pending` に無いのに順番待ちを選ぶと、
// 見ているターンは止まらず、別の発言を取り下げてしまう。
function pickResumeTarget(pending: unknown): string | null {
  if (!Array.isArray(pending)) return null;
  const entries = pending.filter(
    (p): p is { clientMessageId: string; state: string } =>
      typeof p === 'object' &&
      p !== null &&
      typeof (p as { clientMessageId?: unknown }).clientMessageId === 'string' &&
      typeof (p as { state?: unknown }).state === 'string',
  );
  for (const state of ['running', 'starting']) {
    const found = entries.find((p) => p.state === state);
    if (found !== undefined) return found.clientMessageId;
  }
  return null;
}

async function probeInProgress(
  target: Target,
  conversationId: string,
  outer?: AbortSignal,
): Promise<boolean> {
  const abort = new AbortController();
  const signal = outer === undefined ? abort.signal : AbortSignal.any([abort.signal, outer]);
  try {
    for await (const event of readSSE(await openChatStream(target, conversationId, signal))) {
      if (event.name === 'open') {
        return event.json<{ inProgress?: boolean }>()?.inProgress === true;
      }
    }
    return false;
  } finally {
    abort.abort();
  }
}

// 進行中の会話の一覧を返す口は daemon に無いので、会話ごとに stream を張って `open.inProgress` だけ読む。
export async function runResumeCommand(
  line: string,
  target: Target,
  onFailed?: (reason: string) => void,
  hooks?: ReplHooks & { signal?: AbortSignal },
  listed?: Listed,
): Promise<string | null> {
  const fail = (error: unknown): null => {
    if (hooks?.signal?.aborted === true) return null;
    const reason = describeCliFailure(error);
    stdout.write(`エラー: ${reason}\n`);
    onFailed?.(reason);
    return null;
  };
  const [reference, ...extra] = line
    .split(/\s+/)
    .slice(1)
    .filter((token) => token.length > 0);
  const usageFailure = (message: string): null => {
    stdout.write(message);
    onFailed?.('使い方の誤り（/resume）');
    return null;
  };
  if (extra.length > 0) {
    return usageFailure('使い方: /resume [番号|id]（番号は /conversations の並び）\n');
  }
  if (reference !== undefined && isKeyValueToken(reference)) {
    return usageFailure(keyValueReferenceMessage('/resume', reference));
  }
  let id: string | undefined;
  if (reference !== undefined) {
    const resolved = resolveListedId(reference, listed?.conversations ?? []);
    if (resolved === null) {
      stdout.write(`[${reference}] は /conversations の一覧にありません\n`);
      return null;
    }
    id = resolved;
  }
  let candidates: string[];
  if (id !== undefined) {
    candidates = [id];
  } else {
    try {
      const client = createClient(target.baseUrl, target.headers);
      const response = await client.conversations.$get(
        { query: {} },
        hooks?.signal === undefined ? undefined : { init: { signal: hooks.signal } },
      );
      if (!response.ok) {
        return fail(new Error(`会話の一覧を読めませんでした: ${await errorDetail(response)}`));
      }
      const { conversations } = await response.json();
      candidates = conversations.slice(0, RESUME_PROBE_LIMIT).map((c) => c.conversationId);
    } catch (error) {
      return fail(error);
    }
  }
  let found: string | null = null;
  for (const candidate of candidates) {
    try {
      if (await probeInProgress(target, candidate, hooks?.signal)) {
        found = candidate;
        break;
      }
    } catch (error) {
      return fail(error);
    }
  }
  if (found === null) {
    stdout.write(
      id === undefined
        ? '進行中の会話は無い（/conversations で履歴を見られる）\n'
        : `会話 ${id} に進行中のターンは無い（/conversations で履歴を見られる）\n`,
    );
    return null;
  }
  const abort = new AbortController();
  // 対象は再生の `open` で決める: 探した時点の `pending` は、その後に変わりうる。
  const turn: TurnHandle = {
    clientMessageId: null,
    conversationId: null,
    withdrawn: false,
    withdraw: () => {
      turn.withdrawn = true;
      abort.abort();
    },
  };
  let body: ReadableStream<Uint8Array>;
  try {
    body = await openChatStream(
      target,
      found,
      hooks?.signal === undefined ? abort.signal : AbortSignal.any([abort.signal, hooks.signal]),
    );
  } catch (error) {
    return fail(error);
  }
  return renderChatEvents(target, readSSE(body), found, onFailed, true, hooks, turn);
}

const HELP = `（入力）            応答中の Ctrl-C でターンを止める（会話は続く。入力待ちの Ctrl-C は終了）。
                     行末の \\ で次の行へ続けて1発言にする（/ で始まる行は除く）。端末では貼り付けた複数行も1発言になり、Enter で送る
                     // で始めると、先頭の / を 1 つ外した文をそのまま発言として送る（例: //var/log/app.log を見て）
                     標準入力が端末でない（パイプ）ときは、送信が失敗した行・不明なコマンド・使い方の誤りの行で止まり、非 0 で終わる
                     key=value の知らないキー・空の値・使わない語も使い方の誤りで、何も実行しない（使えるキーを言う）
/attach <path>       次に送る発言にファイルを添える（複数回で複数個。本文を打って送ると一緒に上がる。添えかけがあれば空行の Enter で添付だけも送れる）
/attachments         添えかけのファイルの一覧
/detach <番号|all>   添えかけを外す
/report [日付]        日報（既定は直近。日付は YYYY-MM-DD）
/reports [件数]       日報の一覧
/memory              記憶の一覧
/memory <slug>       記憶の中身（書き換えは alteroid memory edit <slug>）
/journal [件数] [type=<種別1,種別2>] [q=<語>]  日誌（新しい順）。q= はそれ以降の行末までを1つの語として扱う
                     type= は ${JOURNAL_ENTRY_TYPES.slice(0, 7).join(' / ')} /
                     ${JOURNAL_ENTRY_TYPES.slice(7).join(' / ')} のカンマ区切り
/journal-show <id>   日誌の1件を全文で（id は /journal の各行の id:。一覧の窓の外の記録も読める）
/conversations [limit=<N>] [scan=<N>] [cursor=<…>]  会話の一覧（新しい順、番号付き。
                     続きがあれば cursor= の打ち方を出す）
/conversation <番号|id> [scan=<N>] [includeSuperseded=true]  その会話の中身（古い順。
                     番号は /conversations の並び。includeSuperseded=true でチャットの
                     編集で畳まれた旧発言・その応答も含めて読める）
/edit <番号|id> <新しい本文>  送信済みの自分の発言を編集する（番号は /conversation の並び。
                     クローンの応答は編集できない。編集前のターンの副作用は取り消さない。
                     元の添付は付けたまま、その場で送る）
/edit <番号|id>      編集を始める。元の本文と添付を出し、添付を添えかけに載せる（上げ直さない）。
                     /detach で外す・/attach で足す。本文を打って Enter で確定（添付が残っていれば
                     空行の Enter で本文を空にして確定できる。添付も本文も無ければ送らない）
/edit-cancel         始めた編集をやめる（何も送らない）
/resume [番号|id]    進行中のターンへ戻る（途中経過を再生して続きを流す。番号は /conversations の並び）。省略なら新しい順に5件まで探す。自動では戻らない
/managers [status=<s1,s2>] [limit=<N>] [after=<番号|id>]  マネージャーの一覧（番号付き）と状態
                     status= は ${jobStatusSchema.options.join(' / ')} のカンマ区切り。
                     limit= と after= で古い側へ頁を辿る（after= は直前の /managers に
                     出た番号か id）。何も付けなければ全件（従来どおり）
/manager <番号|id>    そのマネージャーのセッション生ログ（番号は /managers の並び）
/stop <番号|id> [理由]  その仕事だけをやめさせる（止めた事実は日誌に残る）
/waiting             マネージャーの返事待ち一覧（番号付き）
/msg <番号|id> <本文>  マネージャーへ追加指示を送る（質問への回答としては扱われない）
/reply <番号|requestId> <本文>  マネージャーの質問に自分の言葉で答える（番号は /waiting の並び）
/allow [番号|requestId] [理由]  マネージャーの実行許可の確認に許可で答える
/deny  [番号|requestId] [理由]  マネージャーの実行許可の確認に拒否で答える
                     番号・requestId を省くと、返事待ちのマネージャーが1本だけ
                     なら送る（2本以上なら送らずに候補を出す）
/archive             セッションの生ログ一覧（大きさ・時刻つき）
/archive <id>        生ログの中身
/archive sessions    セッションごとの行数・使用量の集計
/archive remove <id> [理由]  生ログの本文だけを消す（行は残り、本文だけが消えた印になる）
                     走行中のマネージャーの退避は既定で拒まれる——理由を付けて
                     もう一度打つと、その理由を記録した上で消せる
/approvals           承認待ち（番号付き）
/approvals all       回答済み・取り下げ済みも含めて見る
/approvals answered [limit=<N>] [before=<YYYY-MM-DD>]  決着した日と件数（新しい日が上。既定 14 日）
                     before= はその日より古い日から（前の頁の最後の日を渡して続きを辿る）
/approvals answered <YYYY-MM-DD>  その日に決着した承認を決着の新しい順に（取り下げ済みも）。
                     一覧は問い・答え・理由の抜粋だけ。全文は /approval <id> で読む（日付は
                     デーモンの時間帯。日報と同じ区切り。番号は振らない——id で引く）
/answer <番号|id> <回答>  承認待ちに答える（番号は /approvals の並び）
/answer <番号|id> --select <設問id>=<選択肢id>[,<選択肢id>...] [--other <設問id>=<文>] [補足]
                     設問つきの承認待ちに選んで答える（--select / --other は何度でも書ける。
                     文に空白があれば "..." で囲む。補足の自由文は併用できる。設問は /approval で読む）
/approval <番号|id>  承認待ちを詳しく見る（設問・選択肢・推奨・単一/複数・その他の可否）
/approval-trace <番号|id>  その承認の答えと、答えを受けてクローンが取った行動を対で見る
                     （番号は /approvals の並び。答えが無い・対が無いときは理由が出る）
/answers <番号|id> <回答> [<番号|id> <回答> ...]  溜まった承認待ちにまとめて答える
                     （回答は1語。複数語なら "..." で囲む。1件が駄目でも残りは進み、
                      結果は id ごとに出る）
/commitments         引き受けたまま終わっていない仕事（番号付き）
/commitments all     片付けたものも含めて見る
/commitment <番号|id>  台帳の1件を全文で（本文・片付けた理由を80字で切らない。番号は /commitments の並び。
                     片付けた行も引ける）
/commit <本文>       引き受けたことを台帳へ積む
/commit-edit <番号|id> <新しい本文>  台帳の本文を後から直す（番号は /commitments の並び。
                     直せるのは自分が積んだ未了の行だけ——断りの理由はサーバが返す）
/done <番号|id> <理由>  片付けたことを記録する（理由は必須。番号は /commitments の並び）
/usage [from=YYYY-MM-DD] [to=YYYY-MM-DD] [manager=<id>] [layer=<種>] [site=<場所>] [token=<id>]  利用状況（いくら使ったか）
                     layer= は ${usageLayerSchema.options.join(' / ')}、site= は
                     ${usageSiteSchema.options.join(' / ')} のどれか。token= は
                     alteroid token list の id（値の集合は閉じていないため検査しない）
/schedule            時間起点のジョブ・継続中の依頼と次の発火
/schedule <kind> <HH:MM|30m|cron 0 10 * * 1> <依頼>  継続する依頼を仕込む
/schedule-show <kind>  定期ジョブ1件を全文で（依頼を80字で切らない。kind は /schedule の各行の先頭）
/unschedule <kind>   継続中の依頼を外す
/run <kind>          定期ジョブを今すぐ起こす
/event <source> [本文]  外部イベントをクローンに届ける（本文が JSON ならその値として）
/quit                終了
`;

// 承認待ち・台帳・会話・マネージャー・待ちは別々に持つ: 1本にまとめると `/approvals` の直後の `/done 1` が
// 承認待ちの id を閉じに行く。`managers` と `waiting` も別物で、`/managers` の直後の `/reply 1` で
// マネージャーの id が requestId として使われてはいけない。
export interface Listed {
  approvals: string[];
  commitments: string[];
  conversations: string[];
  managers: string[];
  // `startedAt` を人間に打たせない: ミリ秒精度の ISO を手で写させると、CLI にだけ「打ち間違えると 400」という段差ができる。
  // `GET /managers` の錨は `(afterId, afterStartedAt)` の組なので、`managerId` だけでは続きの起点が決まらない。
  managerAnchors: Record<string, string>;
  waiting: { managerId: string; requestId: string }[];
  // クローンの応答（outbound）には番号を振らない: 編集できるのは人間の発言だけで、その制約を番号選択の時点で満たす。
  // 既に別の編集で畳まれた発言にも振らない（指すと、サーバが 400 を返す）。
  messages: string[];
  // `/edit` の対象は、いま話している会話ではなく直前に `/conversation` で開いた会話。
  messagesConversationId: string | null;
  messageAttachments: Record<
    string,
    { id: string; name: string; mediaType: string; size: number }[]
  >;
  messageTexts: Record<string, string>;
}

// `!response.ok` で例外を投げず `stdout.write` して `'ok'` を返す: 1つの操作の失敗で、無関係な会話の続きまで失わせない。
// 通信そのものの例外は呼び手のループが受ける。
export async function runSlashCommand(
  line: string,
  client: ReturnType<typeof createClient>,
  listed: Listed,
  conversationId: string | null = null,
  target?: Target,
  confirm?: (summary: string) => Promise<boolean>,
  onFailed?: (reason: string) => void,
  hooks?: ReplHooks,
  auxClient: ReturnType<typeof createClient> = client,
  absentOkClient: ReturnType<typeof createClient> = client,
  removedOkClient: ReturnType<typeof createClient> = client,
): Promise<'ok' | 'quit'> {
  const [command, ...rest] = line.split(/\s+/);
  const usageError = (message: string): 'ok' => {
    stdout.write(message);
    onFailed?.(`使い方の誤り（${command ?? ''}）`);
    return 'ok';
  };

  // 参照を省いて `scan=500` のように書くと、キーを id と取り違えてデーモンへ飛ばしてしまう。飛ばす前に断る。
  if (command !== undefined && REFERENCE_FIRST_COMMANDS.has(command)) {
    const first = rest[0];
    if (first !== undefined && isKeyValueToken(first)) {
      return usageError(keyValueReferenceMessage(command, first));
    }
  }

  switch (command) {
    case '/help':
      stdout.write(HELP);
      return 'ok';

    case '/report': {
      const date = rest[0];
      if (date) {
        const response = await absentOkClient.reports[':date'].$get({ param: { date } });
        if (!response.ok) {
          // 「無い」は 404 だけ。400（日付の形）・5xx を「ありません」と言わない。
          stdout.write(
            `${
              response.status === 404
                ? `${date} の日報はありません`
                : await withDetail(`${date} の日報を読めませんでした`, response)
            }\n`,
          );
          return 'ok';
        }
        const body = await response.json();
        if ('reports' in body) for (const report of body.reports) writeReport(report);
        return 'ok';
      }
      const response = await client.reports.$get({ query: { limit: '1' } });
      if (!response.ok) {
        stdout.write(`${await withDetail('日報を読めませんでした', response)}\n`);
        return 'ok';
      }
      const { reports } = await response.json();
      if (reports.length === 0) {
        stdout.write('（日報はまだありません。/run daily_report で今すぐ作れます）\n');
        return 'ok';
      }
      for (const report of reports) writeReport(report);
      return 'ok';
    }

    case '/reports': {
      const limit = rest[0] ?? '14';
      const response = await client.reports.$get({ query: { limit } });
      if (!response.ok) {
        stdout.write(`${await withDetail('日報を読めませんでした', response)}\n`);
        return 'ok';
      }
      const { reports } = await response.json();
      if (reports.length === 0) stdout.write('（日報はまだありません）\n');
      for (const report of reports) {
        stdout.write(`${renderReportLine(report)}\n`);
      }
      noteIfAtLimit(reports.length, limit, '日報');
      return 'ok';
    }

    case '/schedule': {
      if (rest.length >= 3) {
        const [kind] = rest;
        const parsed = takeWhen(rawTail(line, 2));
        if (parsed === null || parsed.request.length === 0) {
          stdout.write(
            '周期は HH:MM（毎日その時刻）／30m・30（分ごと）／cron <5項目>（例: cron 0 10 * * 1）\n',
          );
          return 'ok';
        }
        const created = await client.schedule.$post({
          json: { kind: kind ?? '', request: parsed.request, spec: parsed.spec },
        });
        stdout.write(
          created.ok
            ? `${kind ?? ''} を仕込みました（/schedule で確認できます）\n`
            : `${await withDetail(
                '仕込めませんでした（名前は英小文字・数字・. _ -、既定の定期ジョブの名前は使えません。cron 式なら書式も確かめてください）',
                created,
              )}\n`,
        );
        return 'ok';
      }
      if (rest.length > 0) {
        return usageError('使い方: /schedule <kind> <HH:MM|30m|cron 0 10 * * 1> <依頼の本文>\n');
      }
      const response = await client.schedule.$get();
      if (!response.ok) {
        stdout.write(`${await withDetail('定期ジョブを読めませんでした', response)}\n`);
        return 'ok';
      }
      const { entries, unreadable = [] } = await response.json();
      if (entries.length === 0) {
        stdout.write(
          unreadable.length === 0
            ? '（定期ジョブは仕込まれていません）\n'
            : '（読めた定期ジョブは仕込まれていません）\n',
        );
      }
      for (const entry of entries) {
        stdout.write(
          `  ${entry.kind}  次: ${entry.nextAt}\n      ${redactBody(entry.description)}\n`,
        );
        if (entry.request !== undefined) {
          stdout.write(`      依頼: ${summarizeText(entry.request)}\n`);
        }
        // 既定の日報・発意は仕込まれたレコードではなく作成という出来事が無い。空欄や `—` にすると「取れなかった」と読まれる。
        stdout.write(
          entry.createdAt === undefined
            ? '      作成・更新: 無し（コードに書かれた既定の仕込みで、仕込まれた記録がありません）\n'
            : `      作成: ${entry.createdAt}  更新: ${entry.updatedAt ?? entry.createdAt}\n`,
        );
        if (entry.request !== undefined) {
          stdout.write(`      前回: ${entry.lastRunAt ?? '（まだ一度も動いていません）'}\n`);
        }
      }
      const unreadableNote = renderUnreadableScheduleNotice(unreadable);
      if (unreadableNote !== '') stdout.write(`${unreadableNote}\n`);
      return 'ok';
    }

    // `/schedule <kind>` に相乗りしない: 仕込む口の引数の数で意味が変わるのを避ける。
    case '/schedule-show': {
      const kind = rest[0];
      if (kind === undefined || rest.length > 1) {
        return usageError('使い方: /schedule-show <kind>（kind は /schedule の各行の先頭）\n');
      }
      const response = await client.schedule.$get();
      if (!response.ok) {
        stdout.write(`${await withDetail('定期ジョブを読めませんでした', response)}\n`);
        return 'ok';
      }
      const { entries, unreadable = [] } = await response.json();
      const found = entries.find((entry) => entry.kind === kind);
      if (found === undefined) {
        stdout.write(
          unreadable.some((row) => row.kind === kind)
            ? `${kind} は在るが読めない形で入っている（消されたのではない。/schedule の末尾の案内を見てください）\n`
            : `${kind} という定期ジョブはありません（/schedule で一覧）\n`,
        );
        return 'ok';
      }
      stdout.write(
        `${formatEntryFull(`  ${found.kind}`, found as unknown as Record<string, unknown>, ['kind'])}\n`,
      );
      return 'ok';
    }

    case '/unschedule': {
      const kind = rest[0];
      if (!kind) {
        return usageError('使い方: /unschedule <kind>（/schedule で一覧）\n');
      }
      const response = await client.schedule[':kind'].$delete({ param: { kind } });
      // 「無い」は 404 だけ。それ以外の失敗を「ありません」と言わない。
      stdout.write(
        `${
          response.ok
            ? `${kind} を外しました`
            : response.status === 404
              ? `${kind} という継続中の依頼はありません（既定の定期ジョブは外せません）`
              : await withDetail(`${kind} を外せませんでした`, response)
        }\n`,
      );
      return 'ok';
    }

    case '/run': {
      const kind = rest[0];
      if (!kind) {
        return usageError('使い方: /run <kind>（/schedule で一覧）\n');
      }
      const response = await client.schedule[':kind'].run.$post({ param: { kind } });
      stdout.write(
        `${
          response.ok
            ? `${kind} を起こしました（結果は日誌・日報に出ます）`
            : response.status === 404
              ? `${kind} という定期ジョブはありません`
              : await withDetail(`${kind} を起こせませんでした`, response)
        }\n`,
      );
      return 'ok';
    }

    case '/event': {
      const [source] = rest;
      if (!source) {
        return usageError('使い方: /event <source> [本文]（本文が JSON ならその値として届ける）\n');
      }
      // 空白を畳まない生の残りを使う: `rest` は空白で割ってあり、JSON の文字列や本文の連続した空白を壊す。
      const body = line.replace(/^\S+\s+\S+\s*/, '').trimEnd();
      const response = await client.events.$post({
        json: { source, payload: parseEventPayload(body) },
      });
      stdout.write(
        `${
          response.ok
            ? '外部イベントとして届けました（クローンが判断します）'
            : await withDetail('届けられませんでした', response)
        }\n`,
      );
      return 'ok';
    }

    case '/quit':
    case '/exit':
      return 'quit';

    case '/memory': {
      const slug = rest[0];
      if (!slug) {
        const response = await client.memory.$get();
        // 失敗の本文（`{ error }`）に `documents` は無い。確かめずに読むと TypeError で落ちる。
        if (!response.ok) {
          stdout.write(`${await withDetail('記憶の一覧を読めませんでした', response)}\n`);
          return 'ok';
        }
        const { documents } = await response.json();
        if (documents.length === 0) stdout.write('（記憶はまだ空）\n');
        for (const doc of documents) {
          const marker = freshnessMarker(doc.descriptionFreshness);
          const desc = doc.description === undefined ? '' : ` — ${marker}${doc.description}`;
          stdout.write(
            `  ${doc.slug}  — ${doc.title}` +
              ` (作成: ${formatCreatedAt(doc.createdAt)} / 更新: ${doc.updatedAt})${desc}\n`,
          );
        }
        return 'ok';
      }
      const response = await absentOkClient.memory[':slug'].$get({ param: { slug } });
      if (!response.ok) {
        // 「無い」は 404 だけ。400（スラッグの形）・5xx を「ありません」と言わない。
        stdout.write(
          `${
            response.status === 404
              ? 'そんな記憶はありません'
              : await withDetail('記憶を読めませんでした', response)
          }\n`,
        );
        return 'ok';
      }
      const body = await response.json();
      if ('document' in body) stdout.write(`${body.document.content}\n`);
      return 'ok';
    }

    case '/journal': {
      // 知らない `type=` は 400 を待たずにその場で断る（`/managers` の `status=` / `/usage` の `layer=`・`site=` と同じ慣習）。
      // デーモンへ問い合わせる前に `parseJournalSearchTokens` が検査するので、`parsed.ok` を先に見る。
      const parsed = parseJournalSearchTokens(rest);
      if (!parsed.ok) return usageError(`${parsed.message}\n`);
      const { limit: limitToken, q, type } = parsed;
      const limit = limitToken ?? '20';
      const response = await client.journal.$get({
        query: {
          limit,
          ...(type === undefined ? {} : { type }),
          ...(q === undefined ? {} : { q }),
        },
      });
      if (!response.ok) {
        stdout.write(
          `${await withDetail('日誌を読めませんでした（件数 / type= / q= の値を確かめてください）', response)}\n`,
        );
        return 'ok';
      }
      const { entries } = await response.json();
      if (entries.length === 0) {
        // 探す対象に入っていない欄が在ることまで言う: 黙ると「日誌にその語は無い」と読めるが、tool_use の input に書かれているかもしれない。
        // `type=` で絞った0件を「日誌はまだ空」と言わない: 絞りを外せば見える日誌まで「無い」と読める。
        if (q === undefined && type === undefined) {
          stdout.write('（日誌はまだ空）\n');
        } else if (q === undefined) {
          stdout.write(
            `type=${type} に当たる日誌はありません` + '（絞り込みを外せば見えるかもしれません）\n',
          );
        } else {
          const prefix = type === undefined ? '' : `type=${type} に絞った上で、`;
          stdout.write(
            `${prefix}「${q}」に当たる日誌はありません。` +
              `ただし ${JOURNAL_SEARCH_UNCOVERED_LIST} は探す対象に入っていないので、` +
              'そこにだけ書かれている語はここでは当たりません\n',
          );
        }
      }
      for (const entry of entries) {
        stdout.write(`  ${entry.at}  [${entry.type}] ${summarize(entry)}\n`);
        stdout.write(`      id: ${entry.id}\n`);
      }
      noteIfAtLimit(entries.length, limit, '日誌');
      return 'ok';
    }

    // 404 は指した id の誤りなので失敗として数える（`absentOkClient` を使わない）。409（在るが読めない行）は「無い」と言わない。
    case '/journal-show': {
      const id = rest[0];
      if (id === undefined || rest.length > 1) {
        return usageError('使い方: /journal-show <id>（id は /journal の各行の id:）\n');
      }
      if (isKeyValueToken(id)) {
        return usageError(keyValueIdMessage('/journal-show', id));
      }
      const response = await client.journal[':id'].$get({ param: { id } });
      if (!response.ok) {
        stdout.write(
          `${
            response.status === 404
              ? `日誌 ${id} は無い（id が違うか、まだ書かれていない）`
              : response.status === 409
                ? `日誌 ${id} は在るが読めない形で入っている（消されたのではない）`
                : await withDetail('日誌を読めませんでした', response)
          }\n`,
        );
        return 'ok';
      }
      const entry = (await response.json()) as Record<string, unknown>;
      stdout.write(`${formatJournalEntryFull(entry)}\n`);
      return 'ok';
    }

    case '/conversations': {
      const parsed = parseKeyValueTokens(rest, ['limit', 'scan', 'cursor']);
      if (!parsed.ok) return usageError(`${parsed.message}\n`);
      const raw = parsed.values;
      const query = {
        ...(raw.limit === undefined ? {} : { limit: raw.limit }),
        ...(raw.scan === undefined ? {} : { scan: raw.scan }),
        ...(raw.cursor === undefined ? {} : { cursor: raw.cursor }),
      };
      const response = await client.conversations.$get({ query });
      if (!response.ok) {
        stdout.write(
          `${await withDetail('会話の一覧を読めませんでした（limit= / scan= / cursor= の値を確かめてください）', response)}\n`,
        );
        return 'ok';
      }
      const { conversations, scanned, reachedStart, hiddenByLimit, nextCursor } =
        await response.json();
      stdout.write(`${await fetchUnreadTotalLine(auxClient)}\n`);
      listed.conversations.length = 0;
      if (conversations.length === 0) {
        stdout.write('（会話はまだありません）\n');
      } else {
        conversations.forEach((conversation, index) => {
          listed.conversations.push(conversation.conversationId);
          stdout.write(
            `  [${index + 1}] ${conversation.conversationId}` +
              `  作成: ${conversation.startedAt}  更新: ${conversation.updatedAt}` +
              `  (${conversation.messages}件)${unreadMark(conversation.unreadCount)}\n`,
          );
          stdout.write(`      ${redactBody(conversation.preview)}\n`);
        });
      }
      // 0件でも scanned を出す: 0件が「本当に無い」か「窓の外に残っている」かを人間が区別できなくなる。
      // 広げる手の在り処は常に示す: 隠すと、広げる必要があるかもしれないことにすら気づけない。
      stdout.write(
        `  （人間との往復を新しい方から ${scanned} 件見て集計した。これより古い会話は窓の外に` +
          '残っているかもしれません — 判定できません。さらに見るには ' +
          '`/conversations scan=<N>`（表示件数を増やすには limit=<N>。' +
          'alteroid conversations list --scan / --limit でも同じことができます）\n',
      );
      if (!reachedStart) {
        stdout.write(
          `  （人間との往復を ${scanned} 件遡ったが、先頭には届いていない。これより古い会話が` +
            '残っているかもしれません）\n',
        );
      }
      if (hiddenByLimit > 0) {
        stdout.write(
          `  …ほか ${hiddenByLimit} 件は省略（この窓に ${conversations.length + hiddenByLimit} 件あり、` +
            `新しい順に ${conversations.length} 件だけ出した）\n`,
        );
      }
      // `limit` の上限 200 や `scan` の窓の外は、増やしても出ない。継続点だけが辿る手段。
      if (nextCursor !== undefined) {
        stdout.write(`  続きを読むには: /conversations cursor=${nextCursor}\n`);
      }
      if (conversations.length > 0) {
        stdout.write('  /conversation <番号|id> で中身を読めます\n');
      }
      return 'ok';
    }

    case '/conversation': {
      const reference = rest[0];
      if (!reference) {
        return usageError(
          '使い方: /conversation <番号|id> [scan=<N>] [includeSuperseded=true]' +
            '（番号は /conversations の並び）\n',
        );
      }
      const id = resolveListedId(reference, listed.conversations);
      if (id === null) {
        stdout.write(`[${reference}] は /conversations の一覧にありません\n`);
        return 'ok';
      }
      const parsedQuery = parseKeyValueTokens(rest.slice(1), ['scan', 'includeSuperseded']);
      if (!parsedQuery.ok) return usageError(`${parsedQuery.message}\n`);
      const rawQuery = parsedQuery.values;
      // `includeSuperseded=ture` を false と読むと、畳まれた版を読んだつもりで読めていない。
      if (
        rawQuery.includeSuperseded !== undefined &&
        !['true', 'false'].includes(rawQuery.includeSuperseded)
      ) {
        return usageError(
          `includeSuperseded= は true か false です: ${rawQuery.includeSuperseded}\n`,
        );
      }
      const includeSuperseded = rawQuery.includeSuperseded === 'true';
      const query = {
        ...(rawQuery.scan === undefined ? {} : { scan: rawQuery.scan }),
        ...(includeSuperseded ? { includeSuperseded: 'true' as const } : {}),
      };
      const response = await client.conversations[':id'].$get({ param: { id }, query });
      if (response.status === 404) {
        stdout.write(`そんな会話はありません: ${id}\n`);
        return 'ok';
      }
      if (!response.ok) {
        stdout.write(
          `${await withDetail('会話を読めませんでした（scan= の値を確かめてください）', response)}\n`,
        );
        return 'ok';
      }
      const { messages, scanned, reachedStart, supersededCount } = await response.json();
      listed.messages.length = 0;
      listed.messageAttachments = {};
      listed.messageTexts = {};
      listed.messagesConversationId = id;
      const approvalsRead = await fetchConversationApprovals(auxClient, id);
      const timeline = interleaveApprovals(messages, approvalsRead.approvals);
      if (timeline.length === 0) {
        stdout.write(
          reachedStart
            ? '（発言はありません）\n'
            : '（この窓には発言が見つかりませんでした。窓の外に残っているかもしれません' +
                '（判定できません） — /conversation <番号|id> scan=<N> で広げられます）\n',
        );
      } else {
        for (const item of timeline) {
          if (item.kind === 'approval') {
            stdout.write(`      ${approvalLine(item.approval)}\n`);
            continue;
          }
          const message = item.message;
          const speaker = message.role === 'inbound' ? '人間' : 'クローン';
          // 取り下げた発言は配られていないので、編集の番号を振らない。
          const withdrawn = message.delivery === 'withdrawn';
          const editable =
            message.role === 'inbound' && message.supersededBy === undefined && !withdrawn;
          if (editable) {
            listed.messages.push(message.id);
            listed.messageTexts[message.id] = message.text;
            if (message.attachments !== undefined && message.attachments.length > 0) {
              listed.messageAttachments[message.id] = message.attachments.map((item) => ({
                id: item.id,
                name: item.name,
                mediaType: item.mediaType,
                size: item.size,
              }));
            }
          }
          const label = editable ? `[${listed.messages.length}]` : '   ';
          const edit =
            message.supersededBy !== undefined
              ? `  [畳まれた版 → ${message.supersededBy} に置き換えられた]`
              : message.supersedes !== undefined
                ? `  [編集後の発言 — ${message.supersedes} を置き換えた]`
                : '';
          const body = withdrawn
            ? withdrawnMessageText(redactBody(message.text))
            : redactBody(message.text);
          stdout.write(`  ${label} [${message.at}] ${speaker}: ${body}${edit}\n`);
          for (const line of attachmentLinesOf(message.attachments)) {
            stdout.write(`         ${redactBody(line)}\n`);
          }
        }
      }
      for (const notice of approvalNoticeLines(approvalsRead)) stdout.write(`  ${notice}\n`);
      stdout.write(
        reachedStart
          ? `  （人間との往復を ${scanned} 件遡り、この会話の先頭まで届きました）\n`
          : `  （人間との往復を ${scanned} 件遡りましたが先頭には届いていません。これより古い発言が` +
              '残っているかもしれません — /conversation <番号|id> scan=<N>（または ' +
              'alteroid conversations show --scan）で広げられます）\n',
      );
      // `includeSuperseded` の値によらず常に出す: 出ないと、編集で畳まれた版が在ることに気づけない。
      if (supersededCount > 0) {
        stdout.write(
          `  （この会話にはチャットの編集で畳まれた版が ${supersededCount} 件ある。中身を読むには ` +
            '/conversation <番号|id> includeSuperseded=true で広げられます）\n',
        );
      }
      if (listed.messages.length > 0) {
        stdout.write(
          '  /edit <番号|id> <新しい本文> で自分の発言を編集できます（/edit <番号|id> だけなら、添付を外す・本文を空にする編集もできます）\n',
        );
      }
      return 'ok';
    }

    // 番号は直前の `/conversation` が振ったものだけを引く: 人間の発言にしか番号が無いので、クローンの応答を編集対象にできない（制約C。
    // id を直に打った場合はサーバの検証が 400 で弾く）。`conversationId` は、いま話している会話ではなく直前に開いた会話を使う。
    // 副作用は巻き戻さない（制約B）。
    case '/edit': {
      const [reference] = rest;
      const text = rawTail(line, 2);
      if (!reference || text.length === 0) {
        return usageError(
          '使い方: /edit <番号|id> <新しい本文>（1行で直す。元の添付は付けたまま送る）、または\n' +
            '        /edit <番号|id>（編集を始める。元の本文と添付を出す。/detach で添付を外し、/attach で足し、' +
            '本文を打って Enter（添付が残っていれば空行でも）で確定、/edit-cancel でやめる）\n' +
            '番号は /conversation の並び。編集できるのは自分（人間）の発言だけです — クローンの応答は指せません\n',
        );
      }
      const id = resolveListedId(reference, listed.messages);
      if (id === null) {
        stdout.write(
          `[${reference}] は直前の /conversation の一覧にありません` +
            '（番号は、その会話でまだ畳まれていない自分の発言だけに振られています）\n',
        );
        return 'ok';
      }
      const owningConversationId = listed.messagesConversationId;
      if (owningConversationId === null) {
        stdout.write('先に /conversation <番号|id> でその発言が含まれる会話を開いてください\n');
        return 'ok';
      }
      if (target === undefined) {
        stdout.write('編集を送れませんでした（接続先が分かりません）\n');
        return 'ok';
      }
      const carried = (listed.messageAttachments[id] ?? []).map((a) => a.id);
      await sendMessage(target, text, owningConversationId, id, {
        attachments: carried,
        onAccepted: () => {
          retireListedMessage(listed, id);
        },
        ...(onFailed === undefined ? {} : { onFailed }),
        ...(hooks === undefined ? {} : { hooks }),
      });
      return 'ok';
    }

    case '/managers': {
      // 台帳に行を消す口が無いので、直し方は「消す」ではなく絞り込みと窓。上限で古いものを刈る形は north_star 禁止2に触れる。
      // 既定を絞らないのは Web と同じ判断で、到達できない行を作らないため。
      const parsed = parseManagerFilters(rest);
      if (!parsed.ok) return usageError(`${parsed.message}\n`);
      let anchor: { afterId: string; afterStartedAt: string } | undefined;
      if (parsed.after !== undefined) {
        const afterId = resolveListedId(parsed.after, listed.managers);
        const afterStartedAt = afterId === null ? undefined : listed.managerAnchors[afterId];
        if (afterId === null || afterStartedAt === undefined) {
          // id を直に書いても、直前の一覧に出ていなければ `startedAt` が手元に無く、錨を組めない。
          stdout.write(
            `[${parsed.after}] は直前の /managers の一覧にありません` +
              '（after= には直前に出た番号か id を指してください）\n',
          );
          return 'ok';
        }
        anchor = { afterId, afterStartedAt };
      }

      const response = await client.managers.$get({
        query: { ...parsed.query, ...(anchor ?? {}) },
      });
      if (!response.ok) {
        // 400 の本文をそのまま出す: 3つの理由で断るので、一言に畳むとどれなのか読めなくなる。
        stdout.write(`マネージャーの一覧を読めませんでした — ${await errorDetail(response)}\n`);
        return 'ok';
      }
      const { managers, unreadable = [] } = await response.json();
      listed.managers.length = 0;
      listed.managers.push(...managers.map((entry) => entry.managerId));
      // 錨も同じ一覧から作り直す: 前の分を残すと、いま画面に出ていない行を起点にできてしまい、番号と錨が食い違う。
      for (const key of Object.keys(listed.managerAnchors)) delete listed.managerAnchors[key];
      for (const entry of managers) listed.managerAnchors[entry.managerId] = entry.startedAt;
      stdout.write(`${renderManagerList(managers, parsed.query.status, unreadable)}\n`);
      const unreadableJobNote = renderUnreadableJobNotice(unreadable);
      if (unreadableJobNote !== '') stdout.write(`${unreadableJobNote}\n`);
      const note = renderManagersWindowNote(managers.length, parsed.query);
      if (note !== null) stdout.write(note);
      return 'ok';
    }

    case '/waiting': {
      const response = await client.managers.$get({
        // `status=waiting_human` で絞らない: 「`waiting` が空でない行の `status` は必ず `waiting_human`」を確かめていない。
        // 絞ると、人間が答えれば進む確認が黙って一覧から消えうる。
        query: {},
      });
      if (!response.ok) {
        stdout.write(`${await withDetail('マネージャーの一覧を読めませんでした', response)}\n`);
        return 'ok';
      }
      const { managers } = await response.json();
      const { text, entries } = renderWaitingList(managers);
      listed.waiting.length = 0;
      listed.waiting.push(...entries);
      stdout.write(`${text}\n`);
      if (entries.length > 0) {
        stdout.write(
          '  /reply <番号|requestId> <本文> で質問に答える、' +
            '/allow /deny [番号|requestId] [理由] で実行許可に答えられます' +
            '（1本だけなら番号無しでも打てます）\n',
        );
      }
      return 'ok';
    }

    case '/stop': {
      const reference = rest[0];
      if (!reference) {
        return usageError('使い方: /stop <番号|manager_id> [理由]\n');
      }
      const id = resolveListedId(reference, listed.managers);
      if (id === null) {
        stdout.write(`[${reference}] は /managers の一覧にありません\n`);
        return 'ok';
      }
      if (
        !(await confirmRepl(
          confirm,
          `マネージャー ${id} を止めます。この仕事だけが止まり、走っていた途中の作業は戻りません。`,
          onFailed,
        ))
      ) {
        return 'ok';
      }
      const reason = rawTail(line, 2);
      const response = await client.managers[':id'].$delete({
        param: { id },
        // 空文字を送らない: 書かなかったことを空文字で埋めると、日誌に「理由：（空）」が残って書き忘れと区別が付かない。
        json: reason === '' ? {} : { reason },
      });
      if (!response.ok) {
        // 404 以外はサーバの理由をそのまま出す: 状態コードだけを見せて「打ち間違えた」と誤読させない。
        stdout.write(
          `${
            response.status === 404
              ? `そのマネージャーは見つかりませんでした: ${id}`
              : await errorDetail(response)
          }\n`,
        );
        return 'ok';
      }
      reportOutcome(await response.json(), STOPPED_OUTCOMES, onFailed);
      return 'ok';
    }

    case '/manager': {
      const reference = rest[0];
      if (!reference) {
        return usageError('使い方: /manager <番号|manager_id>\n');
      }
      const id = resolveListedId(reference, listed.managers);
      if (id === null) {
        stdout.write(`[${reference}] は /managers の一覧にありません\n`);
        return 'ok';
      }
      const response = await absentOkClient.managers[':id'].transcript.$get({ param: { id } });
      if (!response.ok) {
        // 「まだ無い」は 404 だけ。5xx 等を「まだありません」と言わない。
        stdout.write(
          `${
            response.status === 404
              ? 'そのマネージャーの生ログはまだありません'
              : response.status === 410
                ? await describeRemovedBody('そのマネージャーの生ログ', response)
                : await withDetail('そのマネージャーの生ログを読めませんでした', response)
          }\n`,
        );
        return 'ok';
      }
      stdout.write(`${redactBody(await response.text())}\n`);
      return 'ok';
    }

    // `requestId` も `decision` も付けない: 足すと、確認の待ちが在るときに追加指示が回答へ化ける。
    case '/msg': {
      const [reference] = rest;
      const text = rawTail(line, 2);
      if (!reference || text.length === 0) {
        return usageError('使い方: /msg <番号|manager_id> <本文>\n');
      }
      const id = resolveListedId(reference, listed.managers);
      if (id === null) {
        stdout.write(`[${reference}] は /managers の一覧にありません\n`);
        return 'ok';
      }
      const response = await client.managers[':id'].messages.$post({
        param: { id },
        json: { text },
      });
      if (!response.ok) {
        stdout.write(
          `${
            response.status === 404
              ? `そのマネージャーは見つかりませんでした: ${id}`
              : await errorDetail(response)
          }\n`,
        );
        return 'ok';
      }
      reportOutcome(await response.json(), DELIVERED_OUTCOMES, onFailed);
      return 'ok';
    }

    // `decision` は付けない: 質問には許可/拒否の意思が無い。
    case '/reply': {
      const [reference] = rest;
      const text = rawTail(line, 2);
      if (!reference || text.length === 0) {
        return usageError('使い方: /reply <番号|requestId> <本文>\n');
      }
      const target = await resolveWaitingTarget(reference, listed.waiting, client);
      if (!target.ok) {
        stdout.write(`${target.message}\n`);
        return 'ok';
      }
      const response = await client.managers[':id'].messages.$post({
        param: { id: target.managerId },
        json: { text, requestId: target.requestId },
      });
      if (!response.ok) {
        stdout.write(
          `${
            response.status === 404
              ? `そのマネージャーは見つかりませんでした: ${target.managerId}`
              : await errorDetail(response)
          }\n`,
        );
        return 'ok';
      }
      reportOutcome(await response.json(), DELIVERED_OUTCOMES, onFailed);
      return 'ok';
    }

    // 引数が無ければ宛先を書かずに decision だけ送る。どのマネージャーへ送るかは CLI 側で決め、当てない:
    // 返事待ちが2本以上あれば、どちらへも送らずに候補を出す。
    // 理由は省略できる: 必須にすると、API が要求していない制約を CLI 側で足すことになる。
    case '/allow':
    case '/deny': {
      const decision: 'allow' | 'deny' = command === '/allow' ? 'allow' : 'deny';
      const defaultText = decision === 'allow' ? '許可する' : '許可しない';

      if (rest.length === 0) {
        const target = await resolveDecisionOnlyManager(client);
        if (!target.ok) {
          stdout.write(`${target.message}\n`);
          return 'ok';
        }
        const response = await client.managers[':id'].messages.$post({
          param: { id: target.managerId },
          json: { text: defaultText, decision },
        });
        if (!response.ok) {
          stdout.write(
            `${
              response.status === 404
                ? `そのマネージャーは見つかりませんでした: ${target.managerId}`
                : await errorDetail(response)
            }\n`,
          );
          return 'ok';
        }
        reportOutcome(await response.json(), DELIVERED_OUTCOMES, onFailed);
        return 'ok';
      }

      const [reference] = rest;
      const reason = rawTail(line, 2);
      const target = await resolveWaitingTarget(reference ?? '', listed.waiting, client);
      if (!target.ok) {
        stdout.write(`${target.message}\n`);
        return 'ok';
      }
      const response = await client.managers[':id'].messages.$post({
        param: { id: target.managerId },
        json: {
          text: reason.length === 0 ? defaultText : reason,
          requestId: target.requestId,
          decision,
        },
      });
      if (!response.ok) {
        stdout.write(
          `${
            response.status === 404
              ? `そのマネージャーは見つかりませんでした: ${target.managerId}`
              : await errorDetail(response)
          }\n`,
        );
        return 'ok';
      }
      reportOutcome(await response.json(), DELIVERED_OUTCOMES, onFailed);
      return 'ok';
    }

    case '/archive': {
      const sub = rest[0];

      if (sub === 'sessions') {
        const response = await client.archive.sessions.$get();
        if (!response.ok) {
          stdout.write(`${await withDetail('アーカイブの集計を読めませんでした', response)}\n`);
          return 'ok';
        }
        const { sessions } = await response.json();
        if (sessions.length === 0) stdout.write('（生ログはまだありません）\n');
        for (const session of sessions) {
          stdout.write(
            `  ${session.sessionId}  行数: ${session.rows}` +
              `  使用量合計: ${session.storedBytes}バイト（最大1行: ${session.maxStoredBytes}バイト）` +
              `  ${session.firstAt} 〜 ${session.lastAt}\n`,
          );
        }
        return 'ok';
      }

      if (sub === 'remove') {
        const removeId = rest[1];
        if (!removeId) {
          return usageError('使い方: /archive remove <id> [理由]\n');
        }
        if (isKeyValueToken(removeId)) {
          return usageError(keyValueIdMessage('/archive remove', removeId));
        }
        if (
          !(await confirmRepl(
            confirm,
            `生ログ ${removeId} の本文を消します。本文は戻りません（行と大きさだけが残ります）。`,
            onFailed,
          ))
        ) {
          return 'ok';
        }
        const reason = rawTail(line, 3);
        const response = await client.archive[':id'].$delete({
          param: { id: removeId },
          query: reason === '' ? {} : { overrideReason: reason },
        });
        if (response.status === 404) {
          stdout.write('その生ログはありません\n');
          return 'ok';
        }
        if (response.status === 409) {
          stdout.write(
            `${await errorDetail(response)}\n` +
              `理由を付けて上書きするには: /archive remove ${removeId} <理由>\n`,
          );
          return 'ok';
        }
        if (!response.ok) {
          stdout.write(`${await errorDetail(response)}\n`);
          return 'ok';
        }
        const result = await response.json();
        const overrideNote =
          result.override !== undefined
            ? `（⚠️ override — 走行中のマネージャー ${result.override.managerId} の退避を、` +
              `理由「${redactBody(result.override.reason)}」で消しました）`
            : '';
        stdout.write(
          `${result.alreadyRemoved ? '前から消されていました' : '消しました'}` +
            `（${result.bytes}バイト。${ARCHIVE_REMOVED_BYTES_UNIT_NOTE}）${overrideNote}\n`,
        );
        return 'ok';
      }

      const id = sub;
      if (!id) {
        const response = await client.archive.$get();
        if (!response.ok) {
          stdout.write(`${await withDetail('アーカイブを読めませんでした', response)}\n`);
          return 'ok';
        }
        const { entries } = await response.json();
        if (entries.length === 0) stdout.write('（生ログはまだありません）\n');
        for (const entry of entries) {
          const removedNote = entry.removedAt !== undefined ? '（本文は削除済み）' : '';
          stdout.write(`  ${entry.id}  ${entry.storedBytes}バイト  ${entry.at}${removedNote}\n`);
        }
        return 'ok';
      }
      if (isKeyValueToken(id)) {
        return usageError(keyValueIdMessage('/archive', id));
      }
      const response = await removedOkClient.archive[':id'].$get({ param: { id } });
      if (!response.ok) {
        // 「無い」は 404 だけ。5xx 等を「ありません」と言わない。
        stdout.write(
          `${
            response.status === 404
              ? 'その生ログはありません'
              : response.status === 410
                ? await describeRemovedBody('その生ログ', response)
                : await withDetail('その生ログを読めませんでした', response)
          }\n`,
        );
        return 'ok';
      }
      stdout.write(`${redactBody(await response.text())}\n`);
      return 'ok';
    }

    case '/approvals': {
      // 番号は振らず `listed.approvals` も触らない: `/answer <番号>` が指す未回答の一覧を、答えようのない行で書き換えないため。
      if (rest[0] === 'answered') {
        const args = rest.slice(1);
        // `limt=3` を日付として読むと、デーモンの日付の形の 400 が「キーの綴り違い」を隠す。
        const dayArg = args.find((arg) => !arg.includes('='));
        if (dayArg !== undefined) {
          if (args.length > 1) {
            return usageError('使い方: /approvals answered <YYYY-MM-DD>\n');
          }
          const response = await client.approvals.$get({ query: { answeredOn: dayArg } });
          if (!response.ok) {
            stdout.write(
              `${await withDetail(`${dayArg} に決着した承認を読めませんでした`, response)}\n`,
            );
            return 'ok';
          }
          const { approvals } = await response.json();
          if (approvals.length === 0) {
            stdout.write(`（${dayArg} に決着した承認はありません）\n`);
            return 'ok';
          }
          stdout.write(`${dayArg} に決着した承認 ${approvals.length} 件（決着の新しい順）\n`);
          for (const approval of approvals) {
            const withdrawn = approval.withdrawnAt && !approval.answeredAt;
            const settledAt = approval.answeredAt ?? approval.withdrawnAt ?? '';
            stdout.write(
              `  ${settledAt}  ${withdrawn ? '取り下げ済み' : '回答済み'}  ${summarizeText(approval.question)}\n`,
            );
            stdout.write(`      id: ${approval.id}\n`);
            if (withdrawn) {
              stdout.write(
                `      取り下げた理由: ${approval.withdrawnReason ? summarizeText(approval.withdrawnReason) : '（理由の記録なし）'}\n`,
              );
            } else if (approval.answer) {
              stdout.write(`      回答: ${summarizeText(approval.answer)}\n`);
            }
          }
          stdout.write(
            '  全文・設問は /approval <id>、答えの後の行動は /approval-trace <id> で読めます\n',
          );
          return 'ok';
        }
        const window = parseKeyValueTokens(args, ['limit', 'before']);
        if (!window.ok) {
          return usageError(
            `${window.message}\n使い方: /approvals answered [limit=<N>] [before=<YYYY-MM-DD>]、または /approvals answered <YYYY-MM-DD>\n`,
          );
        }
        const limit = window.values.limit ?? '14';
        const before = window.values.before;
        const response = await client.approvals['answered-dates'].$get({
          query: { limit, ...(before === undefined ? {} : { beforeDate: before }) },
        });
        if (!response.ok) {
          stdout.write(`${await withDetail('承認が決着した日を読めませんでした', response)}\n`);
          return 'ok';
        }
        const { dates } = await response.json();
        if (dates.length === 0) stdout.write('（決着した承認はまだありません）\n');
        for (const entry of dates) stdout.write(`  ${entry.date}  ${entry.count} 件\n`);
        if (dates.length > 0) stdout.write('  /approvals answered <日付> でその日の件を読めます\n');
        noteIfAtLimit(dates.length, limit, '日');
        return 'ok';
      }
      // `all` で回答済み・取り下げ済みも含める。既定は未回答かつ未取り下げのみ:
      // 番号を振って `/answer` に使わせる一覧を、答えようがない行で埋めないため。
      const includeSettled = rest[0] === 'all';
      // `/approvals foo` が未回答の一覧を返すと、`all` のつもりの綴り違いが「回答済みは無い」と読める。
      const surplus = rest.slice(includeSettled ? 1 : 0).find((token) => token.length > 0);
      if (surplus !== undefined) {
        return usageError(
          `使わない語です: ${surplus}（使えるのは /approvals、/approvals all、/approvals answered …）\n`,
        );
      }
      // `order` を明示する: 渡さないとストアの生の並びが返り、永続化層ごとに並びが変わる。
      // 番号を振って `/answer` に使わせる以上、並びが動くと人間が見た番号と次に打つ番号がずれて誤爆する。
      const response = await client.approvals.$get({
        query: { order: 'asc', ...(includeSettled ? { pending: 'false' as const } : {}) },
      });
      if (!response.ok) {
        stdout.write(`${await withDetail('承認待ちを読めませんでした', response)}\n`);
        return 'ok';
      }
      const { approvals, unreadable = [] } = await response.json();
      listed.approvals.length = 0;
      if (approvals.length === 0) {
        stdout.write(
          unreadable.length === 0
            ? '（承認待ちはありません）\n'
            : '（読めた承認待ちはありません）\n',
        );
        const note = renderUnreadableApprovalNotice(unreadable);
        if (note !== '') stdout.write(`${note}\n`);
        return 'ok';
      }
      approvals.forEach((approval, index) => {
        listed.approvals.push(approval.id);
        // 札は質問の1行目: 全文を先頭行へ出すと、改行を含む質問で `[1] ` の行が折れて番号と質問の対応が崩れる。残りの行は落とさず札の下へ続ける。
        const [head, ...restLines] = redactBody(approval.question).split('\n');
        stdout.write(`  [${index + 1}] ${head ?? ''}\n`);
        for (const line of restLines) stdout.write(`      ${line}\n`);
        stdout.write(
          `      id: ${approval.id}  作成: ${approval.createdAt}` +
            `  更新: ${approvalUpdatedAt(approval)}\n`,
        );
        if (approval.jobId) stdout.write(`      マネージャー: ${approval.jobId}\n`);
        if (approval.context) stdout.write(`      背景: ${summarizeText(approval.context)}\n`);
        if (approval.questions !== undefined && approval.questions.length > 0) {
          stdout.write(
            `      ${summarizeQuestions(approval.questions)}` +
              `（/approval ${index + 1} で選択肢を読める）\n`,
          );
        }
        if (approval.withdrawnAt) {
          stdout.write(`      状態: 取り下げ済み（${approval.withdrawnAt}）\n`);
          stdout.write(
            `      取り下げた理由: ${approval.withdrawnReason === undefined || approval.withdrawnReason === null ? '（理由の記録なし）' : redactBody(approval.withdrawnReason)}\n`,
          );
        } else if (approval.answeredAt) {
          stdout.write(`      状態: 回答済み（${approval.answeredAt}）\n`);
          if (approval.answer) stdout.write(`      回答: ${redactBody(approval.answer)}\n`);
          // 記録が無い行では出さない: 「わからない」を「operator ではない」に化けさせない。
          if (approval.answeredVia) {
            stdout.write(`      回答経路: ${describeAnsweredVia(approval.answeredVia)}\n`);
          }
        }
        // 会話の中身は出さない: 一覧に全文を載せると溢れ、承認1件ごとに会話を取りに行くと承認が溜まるほどリクエストが増える。
        stdout.write(
          approval.conversationId
            ? `      会話: ${approval.conversationId}` +
                `（/conversation ${approval.conversationId} で読めます）\n`
            : '      会話: 紐づいていない' +
                '（マネージャー発・内部ターンには紐づけられる会話が存在しない）\n',
        );
      });
      stdout.write('  /answer <番号> <回答> で答えられます（答えた仕事だけが再開します）\n');
      const unreadableNote = renderUnreadableApprovalNotice(unreadable);
      if (unreadableNote !== '') stdout.write(`${unreadableNote}\n`);
      return 'ok';
    }

    case '/approval-trace': {
      const [reference] = rest;
      if (!reference) {
        return usageError('使い方: /approval-trace <番号|id>\n');
      }
      const id = resolveListedId(reference, listed.approvals);
      if (id === null) {
        stdout.write(`[${reference}] は /approvals の一覧にありません\n`);
        return 'ok';
      }
      const response = await client.approvals[':id'].trace.$get({ param: { id } });
      if (response.status === 404) {
        stdout.write(`承認 ${id} はありません\n`);
        return 'ok';
      }
      if (!response.ok) {
        stdout.write(`${await withDetail('承認の答えと行動の対を読めませんでした', response)}\n`);
        return 'ok';
      }
      const trace = (await response.json()) as ApprovalTrace;
      stdout.write(
        `${redactBody(
          renderApprovalTrace(trace, {
            budget: null,
            summaryLimit: null,
            detailHint: '（行動は日誌の行の全文。前後の文脈は /journal で読めます）',
          }),
        )}\n`,
      );
      return 'ok';
    }

    case '/approval': {
      const reference = rest[0];
      if (!reference) {
        return usageError('使い方: /approval <番号|id>\n');
      }
      const id = resolveListedId(reference, listed.approvals);
      if (id === null) {
        stdout.write(`[${reference}] は /approvals の一覧にありません\n`);
        return 'ok';
      }
      let approval;
      if (/^\d+$/.test(reference)) {
        const response = await client.approvals.$get({
          query: { order: 'asc', pending: 'false' },
        });
        if (!response.ok) {
          stdout.write(`${await withDetail('承認待ちを読めませんでした', response)}\n`);
          return 'ok';
        }
        const { approvals } = await response.json();
        approval = approvals.find((entry) => entry.id === id);
      } else {
        const response = await client.approvals[':id'].$get({ param: { id } });
        if (response.status !== 404 && !response.ok) {
          stdout.write(`${await withDetail('承認待ちを読めませんでした', response)}\n`);
          return 'ok';
        }
        approval = response.ok ? (await response.json()).approval : undefined;
      }
      if (approval === undefined) {
        stdout.write(`[${reference}] （${id}）は見つかりませんでした\n`);
        return 'ok';
      }
      stdout.write(`  ${redactBody(approval.question)}\n`);
      stdout.write(`      id: ${approval.id}  作成: ${approval.createdAt}\n`);
      if (approval.context) stdout.write(`      背景: ${redactBody(approval.context)}\n`);
      if (approval.withdrawnAt) {
        stdout.write(`      状態: 取り下げ済み（${approval.withdrawnAt}）\n`);
      } else if (approval.answeredAt) {
        stdout.write(`      状態: 回答済み（${approval.answeredAt}）\n`);
        if (approval.answer) stdout.write(`      回答: ${redactBody(approval.answer)}\n`);
      }
      if (approval.questions === undefined || approval.questions.length === 0) {
        stdout.write('      （設問はありません。/answer <番号> <回答> で自由文で答えます）\n');
        return 'ok';
      }
      for (const questionLine of describeQuestionLines(approval.questions)) {
        stdout.write(`      ${redactBody(questionLine)}\n`);
      }
      stdout.write(
        '      答え方: /answer <番号> --select <設問id>=<選択肢id>[,<選択肢id>...]' +
          ' [--other <設問id>=<文>] [補足]\n',
      );
      return 'ok';
    }

    case '/answer': {
      const [reference] = rest;
      if (!reference) {
        return usageError('使い方: /answer <番号|id> <回答>\n');
      }
      const id = resolveListedId(reference, listed.approvals);
      if (id === null) {
        stdout.write(`[${reference}] は /approvals の一覧にありません\n`);
        return 'ok';
      }
      // 取れなかったときに黙って自由文へ倒さない: 設問つきの承認待ちへ、構造化のつもりの字面をそのまま自由文として送ってしまう。
      let structured: ReturnType<typeof parseStructuredAnswer> | null = null;
      if (/(^|\s)--(select|other)(=|\s|$)/.test(line)) {
        let target;
        if (/^\d+$/.test(reference)) {
          const lookup = await client.approvals.$get({
            query: { order: 'asc', pending: 'false' },
          });
          if (!lookup.ok) {
            stdout.write(
              `${await withDetail('承認待ちを読めなかったので、回答を送っていません', lookup)}\n`,
            );
            return 'ok';
          }
          const { approvals } = await lookup.json();
          target = approvals.find((entry) => entry.id === id);
        } else {
          const lookup = await client.approvals[':id'].$get({ param: { id } });
          if (lookup.status !== 404 && !lookup.ok) {
            stdout.write(
              `${await withDetail('承認待ちを読めなかったので、回答を送っていません', lookup)}\n`,
            );
            return 'ok';
          }
          target = lookup.ok ? (await lookup.json()).approval : undefined;
        }
        if (target === undefined) {
          stdout.write(`[${reference}] （${id}）は見つからなかったので、回答を送っていません\n`);
          return 'ok';
        }
        if (target.questions !== undefined && target.questions.length > 0) {
          structured = parseStructuredAnswer(rawTail(line, 2));
        }
      }
      if (structured !== null && 'error' in structured) {
        stdout.write(`${redactError(structured.error)}\n`);
        return 'ok';
      }
      const answer = structured === null ? rawTail(line, 2) : structured.supplement;
      if (answer.length === 0 && structured === null) {
        return usageError('使い方: /answer <番号|id> <回答>\n');
      }
      const response = await client.approvals[':id'].answer.$post({
        param: { id },
        json:
          structured === null
            ? { answer }
            : {
                selections: structured.selections,
                ...(answer.length === 0 ? {} : { answer }),
              },
      });
      stdout.write(
        `${response.ok ? '回答しました' : await withDetail('回答に失敗しました', response)}\n`,
      );
      return 'ok';
    }

    // `/answer` に相乗りしない: 複数件を1行に混ぜると自由文との区切りが決められない（引用符を要求すると今の使い方を壊す）。
    case '/answers': {
      // `line` は `/\s+/` 分割済みで引用符の中の空白が保てないので、生の文字列から読み直す。
      const argsText = line.replace(/^\S+\s*/, '');
      const tokens = tokenizeQuoted(argsText);
      const pairs = parseAnswerPairs(tokens);
      if (pairs === null) {
        return usageError(
          '使い方: /answers <番号|id> <回答> [<番号|id> <回答> ...]' +
            '（回答は1語。複数語なら "..." で囲む）\n',
        );
      }

      const requests: { id: string; answer: string }[] = [];
      for (const pair of pairs) {
        const id = resolveListedId(pair.reference, listed.approvals);
        if (id === null) {
          stdout.write(`  [${pair.reference}] は /approvals の一覧にありません（飛ばしました）\n`);
          continue;
        }
        requests.push({ id, answer: pair.answer });
      }

      if (requests.length === 0) {
        stdout.write('送れる回答がありませんでした\n');
        return 'ok';
      }

      const response = await client.approvals.answer.$post({ json: { answers: requests } });
      if (!response.ok) {
        stdout.write(
          `${await withDetail('まとめて答えられませんでした（サーバ側の検査に落ちました）', response)}\n`,
        );
        return 'ok';
      }
      const { results } = await response.json();
      const failures: string[] = [];
      for (const result of results) {
        if (result.ok) {
          stdout.write(`  [${result.id}] 回答しました\n`);
          continue;
        }
        const failure = `[${result.id}] 回答に失敗: ${result.error === undefined ? '不明' : redactError(result.error)}`;
        stdout.write(`  ${failure}\n`);
        failures.push(failure);
      }
      // 全件を出し終えてから知らせる: 通った件と通らなかった件を人間が見分けられるように。
      if (failures.length > 0) onFailed?.(failures.join(' / '));
      return 'ok';
    }

    case '/commitments': {
      // 承認待ちとは別のもの: 止まっていなくても片付いていない仕事はあるので、片方で他方は代用できない。
      // `CLOSED_HISTORY_LIMIT` を超えた古い片付き行は物理削除され、その累計が `trimmedClosed` として応答に載る。
      // `renderCommitments` へ渡して人間にも見える形にする。
      const includeClosed = rest[0] === 'all';
      const response = await client.commitments.$get({
        query: includeClosed ? { includeClosed: 'true' } : {},
      });
      if (!response.ok) {
        stdout.write(`${await withDetail('台帳を読めませんでした', response)}\n`);
        return 'ok';
      }
      const { entries, unreadable, trimmedClosed } = await response.json();
      const { text, ids } = renderCommitments(entries, Date.now(), unreadable, trimmedClosed);
      listed.commitments.length = 0;
      listed.commitments.push(...ids);
      stdout.write(`${text}\n`);
      if (ids.length > 0) {
        stdout.write('  /done <番号> <理由> で片付けたことを記録できます\n');
      }
      return 'ok';
    }

    case '/commitment': {
      const [reference] = rest;
      if (reference === undefined || rest.length > 1) {
        return usageError('使い方: /commitment <番号|id>（番号は /commitments の並び）\n');
      }
      const id = resolveListedId(reference, listed.commitments);
      if (id === null) {
        stdout.write(`[${reference}] は /commitments の一覧にありません\n`);
        return 'ok';
      }
      const response = await client.commitments.$get({ query: { includeClosed: 'true' } });
      if (!response.ok) {
        stdout.write(`${await withDetail('台帳を読めませんでした', response)}\n`);
        return 'ok';
      }
      const { entries, unreadable, trimmedClosed } = await response.json();
      const found = entries.find((entry) => entry.id === id);
      if (found === undefined) {
        const notes = [
          unreadable?.some((row) => row.id === id) === true
            ? '在るが読めない形で入っている（消されたのではない）'
            : '',
          renderTrimmedClosedNotice(trimmedClosed),
        ].filter((line) => line !== '');
        stdout.write(
          `台帳に ${id} は見つかりません（id が違うか、片付けて保持上限で消えた）${
            notes.length === 0 ? '' : `\n${notes.join('\n')}`
          }\n`,
        );
        return 'ok';
      }
      stdout.write(
        `${formatEntryFull(
          `  ${found.closedAt === undefined ? '' : '✓ '}${found.id}`,
          found as unknown as Record<string, unknown>,
          ['id'],
        )}\n`,
      );
      return 'ok';
    }

    case '/commit': {
      const body = rawTail(line, 1);
      if (body.length === 0) {
        return usageError('使い方: /commit <本文>（引き受けたままの仕事として台帳へ積みます）\n');
      }
      const response = await client.commitments.$post({
        json: {
          body,
          // 会話が始まっていなければ付けない: 嘘の出どころを埋めない。
          ...(conversationId === null ? {} : { source: conversationId }),
        },
      });
      if (response.ok) {
        stdout.write('台帳に積みました（/commitments で確認できます）\n');
        return 'ok';
      }
      stdout.write(
        `${response.status === 404 ? '台帳に積めませんでした' : await errorDetail(response)}\n`,
      );
      return 'ok';
    }

    case '/done': {
      const [reference] = rest;
      // 理由は必須: 書かれていないまま「閉じた」事実だけを残さない。
      const reason = rawTail(line, 2);
      if (!reference || reason.length === 0) {
        return usageError(
          '使い方: /done <番号|id> <理由>（番号は /commitments の並び）\n' +
            '  理由が要ります（何をもって片付いたかを、後から読んで確かめられるように残すため）\n',
        );
      }
      const id = resolveListedId(reference, listed.commitments);
      if (id === null) {
        stdout.write(`[${reference}] は /commitments の一覧にありません\n`);
        return 'ok';
      }
      const response = await client.commitments[':id'].close.$post({
        param: { id },
        json: { reason },
      });
      if (response.ok) {
        stdout.write('片付いたことを記録しました\n');
        return 'ok';
      }
      // 失敗の理由を1つに畳まない: 「既に片付いている」と「そんな id は無い」は次の一手が違う。
      stdout.write(
        `${
          response.status === 409
            ? 'それは既に片付いています'
            : response.status === 404
              ? 'その id は台帳にありません'
              : await errorDetail(response)
        }\n`,
      );
      return 'ok';
    }

    // `/edit` に相乗りしない: 番号の置き場が違い、混ぜると `/commitments` の直後の `/edit 1` が会話の発言を指す。
    // 直せる行の条件をここへ写さない: 断るのはサーバで、写すとサーバ側の線が動いた日に CLI だけが静かに嘘になる。
    case '/commit-edit': {
      const [reference] = rest;
      const body = rawTail(line, 2);
      if (!reference || body.length === 0) {
        return usageError(
          '使い方: /commit-edit <番号|id> <新しい本文>（番号は /commitments の並び）\n',
        );
      }
      const id = resolveListedId(reference, listed.commitments);
      if (id === null) {
        stdout.write(`[${reference}] は /commitments の一覧にありません\n`);
        return 'ok';
      }
      const response = await client.commitments[':id'].$patch({
        param: { id },
        json: { body },
      });
      if (response.ok) {
        stdout.write('本文を直しました（直す前の本文は日誌に逐語で残っています）\n');
        return 'ok';
      }
      stdout.write(`${await errorDetail(response)}\n`);
      return 'ok';
    }

    case '/usage': {
      const parsed = parseUsageFilters(rest);
      if (!parsed.ok) return usageError(`${parsed.message}\n`);
      const response = await client.usage.$get({ query: parsed.filters });
      if (!response.ok) {
        stdout.write(
          `${await withDetail('利用状況を読めませんでした（from=/to= の日付の形を確かめてください）', response)}\n`,
        );
        return 'ok';
      }
      const aggregate = await response.json();
      const dateOrderNotice = describeUsageDateOrder(parsed.filters.from, parsed.filters.to);
      if (dateOrderNotice !== null) {
        stdout.write(`${dateOrderNotice}\n`);
      }
      stdout.write(`${renderUsage(aggregate)}\n`);
      return 'ok';
    }

    default:
      stdout.write(`不明なコマンド: ${command ?? ''}\n${HELP}`);
      onFailed?.(`不明なコマンド（${command ?? ''}）`);
      return 'ok';
  }
}

// `unavailable` の本文を素で出さない: エラー文を「クローンが書いたその日のまとめ」として読んでしまう。
// 理由は言い換えずに出す: SDK の文言のまま検索できる。次に見る場所まで書く: 「作れなかった」だけだと記録が消えたと読める。
export function renderReport(report: {
  date: string;
  body: string;
  unavailable?: string | undefined;
}): string {
  if (report.unavailable !== undefined && report.unavailable !== '') {
    return (
      `── ⚠ ${report.date} の日報は作れなかった ──\n` +
      `理由: ${redactBody(report.unavailable)}\n` +
      'この日の記録は日誌に残っている（/journal で辿れる）。' +
      '書けていないだけなので、原因が解ければ /run daily_report で作り直せる\n'
    );
  }
  return `── ${report.date} の日報 ──\n${redactBody(report.body)}\n`;
}

// 印の行を本文の抜粋で出さない: 「その日は上限に当たった話が日報に書かれている」と読める。
// `at` を足す: `date` だけだと同じ日に日報が2本あると見分けが付かない。ISO をそのまま出す: 他の欄も生の ISO で、ここだけ変えると揃わない。
export function renderReportLine(report: {
  date: string;
  at: string;
  body: string;
  unavailable?: string | undefined;
}): string {
  if (report.unavailable !== undefined && report.unavailable !== '') {
    return (
      `  ${report.date}  ${report.at}` +
      `  ⚠ 日報なし（作れなかった。理由: ${summarizeText(report.unavailable)}）`
    );
  }
  return `  ${report.date}  ${report.at}  ${summarizeText(report.body)}`;
}

function writeReport(report: { date: string; body: string; unavailable?: string }): void {
  stdout.write(renderReport(report));
}

// `GET /reports` `GET /journal` は総件数を返さない（`grep -Fn -- 'ちょうど返ったかで判る' apps/daemon/src/app.ts` で当たる）。
// 言えるのは「返った件数が要求した上限とちょうど一致した」という、この API 自身が定めた唯一の合図だけ。
function noteIfAtLimit(count: number, limit: string, label: string): void {
  if (count !== Number(limit)) return;
  stdout.write(`直近 ${limit} 件のみ表示している。これより古い${label}があるかもしれない。\n`);
}

const LIST_DENIED_TOOLS = 3;

// status（`200`）を明示する: 400 が生えて `$get` の返りが応答の union になり、`InferEndpointType` が union の上では解けなくなる。
// 200 を名指しすれば元の1本に戻る。
type ManagerListItem = InferResponseType<DaemonClient['managers']['$get'], 200>['managers'][number];
type ManagerDenial = NonNullable<ManagerListItem['denials']>[number];
type ManagerUnpushedWorkObservation = NonNullable<ManagerListItem['lastUnpushedWorkObservation']>;

// `packages/core/src/tools.ts` の `denialActorTag` と同じ書式に揃える: 片方だけ直すと、クローンと人間が同じ拒否を見て違う判断をする。
// `undefined`（層が取れていない）を消したりマネージャー側へ混ぜたりしない。
function denialActorTag(actor: ManagerDenial['actor']): string {
  return actor === 'manager' ? ' [マネージャー]' : actor === 'worker' ? ' [作業者]' : ' [層不明]';
}

// 状態を置き換えない: 札は `[running]` のまま残し、その下に並べる。
// 拒否の出所はこの数からは取れない: 器の分類器・deny 規則の拒否なら担い手は本当に詰むが、alteroid 自身の `PreToolUse` フックの拒否なら
// 理由と代替案が担い手へ直接返っており自力で抜けられる。だから断定せず (b) の可能性を残す。
// 拒否が無いときは何も足さない: `denials` が無いのと `[]` は別で、常に書くと「0 件だった」と読める。
// 但し書きを短くしても「止まっている可能性がある」までは削らない: 数えているのは拒否そのもので、止まったかどうかはデーモンから見えていない。
function denialLine(
  denials: ManagerDenial[] | undefined,
  lastReportAt: string | undefined,
): string | null {
  if (denials === undefined || denials.length === 0) return null;
  const followUp = describeDenialFollowUp(denials, lastReportAt);
  // 帳面は古い順に積まれている。新しい側から採る。
  const recent = [...denials].reverse();
  const shown = recent.slice(0, LIST_DENIED_TOOLS);
  const rest = recent.length - shown.length;
  const total = denials.reduce((sum, entry) => sum + entry.count, 0);
  return (
    `⚠ 確認へ上がらず止められた道具: ${shown.map((e) => `${e.tool} ${e.count}件${denialActorTag(e.actor)}`).join(' / ')}` +
    (rest > 0 ? `（ほか ${rest} 種、全 ${total} 件）` : '') +
    '。まず担い手自身の拒否文を読ませること。' +
    '(a) 器の分類器か deny 規則なら、手が止まっている可能性があります。' +
    '(b) alteroid 自身の PreToolUse フックなら、理由と代替案は担い手へ直接返っており自力で抜けられることがあります' +
    (followUp === null ? '' : `。${followUp}`)
  );
}

// `status` を置き換えない: 支出上限に当たった回もセッションは生きているので `status` は `done` のまま。`failed` へ倒すと嘘になる。
// SDK の語（`code` / `via`）をそのまま出す: 言い換えると、SDK の型定義やログで引ける手がかりが消える。
// `status` が既に `failed` / `lost` / `stopped` なら分けて言う: `lastFailure` は次の `report` まで消えず、終端の札と矛盾する。
// 「もう続かない」とまでは言わない: `stopped` へも resume を試みうる。届く保証は無いとまで言う。
// `lastFoldedTurn` が在る回は出さない: その回の `lastFailure` は、畳まれる前の無関係な古いターンを指す。
function failureLine(
  failure: ManagerListItem['lastFailure'],
  status: ManagerListItem['status'],
  lastFoldedTurn: ManagerListItem['lastFoldedTurn'],
): string | null {
  if (failure === undefined || failure === null) return null;
  if (lastFoldedTurn !== undefined) return null;
  const opening = `⚠ 直近のターンは報告ではなく失敗で終わっています: ${failure.code}（${failure.via}, ${failure.at}）`;
  if (status === 'failed' || status === 'lost') {
    return (
      `${opening}。ただし status: ${status}——セッションそのものが、依頼者が望まない終わり方で` +
      '既に終端している。「セッションが生きていて原因が解ければ話しかければ続く」という前提はここでは' +
      '成り立たない——続けたいなら /msg で送ると resume を試みるしかなく、届く保証は無い'
    );
  }
  if (status === 'stopped') {
    return (
      `${opening}。ただし status: stopped——このセッションは、その後 人間・クローンが明示的に` +
      '停止させ、確かめたうえで既に終端している。「セッションが生きていて原因が解ければ話しかければ続く」' +
      'という前提はここでは成り立たない——続けたいなら /msg で送ると resume を試みるしかなく、届く保証は無い'
    );
  }
  return `${opening}。セッションは生きているので、原因が解ければ話しかければ続きます`;
}

// core の `describeUsageStopped`（`packages/core/src/tools.ts`）は export されていないので、3分岐を複製する。
// `failureLine` と同じ2分岐で「セッションは生きている」を言い切らない。
// `stopped` 枝にも resume の一文を付ける: core は `failed`/`lost` 枝と `stopped` 枝の両方が同じ resume の一文を持つ
// （`grep -Fn -- '起こし直すには
// manager_send で resume を試みるしかなく、届く保証は無い' packages/core/src/tools.ts` が `describeUsageStopped` 内で2箇所ヒットする）。
// Web と違い CLI の `/managers` には別建ての詳細画面が無く、この行だけが枠に当たっている事実の唯一の手がかりになるので、独立した行として出す。
function usageStoppedLine(
  usageStoppedAt: ManagerListItem['usageStoppedAt'],
  status: ManagerListItem['status'],
): string | null {
  if (usageStoppedAt === undefined) return null;
  if (status === 'failed' || status === 'lost') {
    return (
      `      ⚠ 枠(利用上限)で止まっている（${usageStoppedAt} から）。` +
      `ただし status: ${status}——セッションそのものが、依頼者が望まない終わり方で` +
      '既に終端している。「セッションは生きているので鍵が回れば続く」はここでは' +
      '成り立たない——起こし直すには /msg で送ると resume を試みるしかなく、届く保証は無い' +
      '（実際に届いたかどうかは、この一覧の他の行——システムエラー・cgroup 等——を見ること）。'
    );
  }
  if (status === 'stopped') {
    return (
      `      ⚠ 枠(利用上限)で止まっている（${usageStoppedAt} から）。` +
      'ただし status: stopped——このセッションは、その後 人間・クローンが明示的に' +
      '停止させ、確かめたうえで既に終端している。「セッションは生きているので鍵が' +
      '回ればこの委譲は続く」はここでは成り立たない' +
      '——起こし直すには /msg で送ると resume を試みるしかなく、届く保証は無い' +
      '（実際に届いたかどうかは、この一覧の他の行——システムエラー・cgroup 等——を見ること）。'
    );
  }
  return (
    `      ⚠ 枠(利用上限)で止まっている（${usageStoppedAt} から）。` +
    'セッションは生きているので、鍵が回ればこの委譲は続く' +
    '——status はそれまで動かさない（仕様である）。'
  );
}

// 文言は core と同じ正本（`@alteroid/core/system-error-format`）から引き、3つ目の複製を作らない。ゲートだけはこの関数側で複製する:
// ゲートそのものは軽い口に無い。末尾の指し先だけ、`lastFailure`（MCP の欄名）ではなく CLI の `failureLine` の見出しに変える。
function systemErrorLine(
  status: ManagerListItem['status'],
  lastSystemError: ManagerListItem['lastSystemError'],
): string | null {
  if (status !== 'failed') return null;
  if (lastSystemError === undefined) {
    const note = formatSystemErrorUnknownNote(
      '、上の「直近のターンは報告ではなく失敗で終わっています」の行を見ること',
    );
    return `      ⚠ セッションは失敗で畳まれた。${note}。`;
  }
  return (
    `      ⚠ セッションは器の資源による落ち方で畳まれた可能性 ` +
    `（${lastSystemError.at}）: ${formatSystemErrorFacts(lastSystemError)}`
  );
}

function cgroupEventsLine(
  status: ManagerListItem['status'],
  lastCgroupEvents: ManagerListItem['lastCgroupEvents'],
): string | null {
  if (status !== 'failed') return null;
  if (lastCgroupEvents === undefined) {
    return `      ⚠ ${CGROUP_EVENTS_UNKNOWN_NOTE}。`;
  }
  return `      ${formatCgroupEventsNote(lastCgroupEvents)}（${lastCgroupEvents.at}）。`;
}

// 世代の生の番号は出さない: 人間の次の一手は増えない。`reattached-across-restart` の対処は CLI の語へ言い換える:
// core の助言定数（`STALE_TOKEN_RESTART_ADVICE`）の逐語を複製すると `pnpm check:stale-token-restart-advice` に引っかかる。
function tokenGenerationUnknownReasonLine(
  tokenGenerationUnknownReason: ManagerListItem['tokenGenerationUnknownReason'],
): string | null {
  if (tokenGenerationUnknownReason === undefined) return null;
  if (tokenGenerationUnknownReason === 'pool-not-wired') {
    return (
      '      認証トークンの世代: 分からない（このデプロイは認証トークンの世代そのものを' +
      '配線していない構成。全ての委譲について同じ理由で分からない——この委譲固有の' +
      '問題ではなく、起こし直しても変わらない）。'
    );
  }
  if (tokenGenerationUnknownReason === 'not-yet-observed') {
    return (
      '      認証トークンの世代: 分からない（この委譲のセッションが、いまのデーモンの' +
      'プロセスではまだ一度も起きていない。開始・明示的な resume・認証トークンの' +
      '回転のどれかが起きれば次の一覧から埋まる——いま何もしなくてよい）。'
    );
  }
  if (tokenGenerationUnknownReason === 'reattached-across-restart') {
    return (
      '      認証トークンの世代: 分からない（デーモンの再起動をまたいで、器に生きた' +
      'ままのセッションを引き取った。引き取っただけではこのセッションの環境変数に' +
      '触れていないので、抱えている世代を確かめる材料が無い——一致でも不一致でもない、' +
      '正直な「分からない」である）。この委譲へ daemon が次に明示的に触れば' +
      '（送信・回転のどちらでも）自動で埋まるが、429 が続くなど気になるようなら、' +
      '止める前に、まず外へ出た成果（PR・コミット・送信済みのメール・登録済みの予定・投稿先など）を確かめること。' +
      '確かめずに止めると、失われるのは会話だけではない——そのターンで進行中だった' +
      '作業も一緒に失われうる。確かめたうえで、/msg で送ると resume を試みる。'
    );
  }
  return (
    `      認証トークンの世代: 分からない理由に、この一覧が知らない値 ` +
    `"${String(tokenGenerationUnknownReason)}" が入っている（デーモンの版が新しい可能性）。`
  );
}

// core の `describeResetTimeSkew` と違い、二重に鳴らさないための抑えは無い: CLI は世代の生の番号を出さないので、抑える材料が無い。
// 未知の値でも落ちない: 版のずれ（新しいデーモンが第3の値を返す）は型では防げないので、知らない値をそのまま名乗る。
// `'stale'` の対処は CLI の語へ言い換える（`tokenGenerationUnknownReasonLine` と同じ理由）。
function resetTimeSkewLine(
  resetTimeSkewMatch: ManagerListItem['resetTimeSkewMatch'],
  hasUnpushedWorkObservationLine: boolean,
): string | null {
  if (resetTimeSkewMatch === undefined) return null;
  if (resetTimeSkewMatch === 'stale') {
    // 「下の『未push観測』」は、その行が実際に出るときだけ指す: 0本で省かれた行を指さない。
    const unpushedNote = !hasUnpushedWorkObservationLine
      ? ''
      : '下の「未push観測」にも最後の観測が出ている（いまの状態ではない）ので、合わせて見ること。';
    return (
      '      ⚠ 認証トークンの世代ずれの疑い（429の文言に書かれていた resets 時刻が、' +
      '現役ではない鍵の冷却期限と一致した）。このセッションは古い鍵を掴んだまま' +
      '走っている可能性がある——鍵が通る状態へ戻っても、このセッション自身は' +
      'ターンの境界に達するまで戻らない。この行が消えないまま 429 が続くようなら、' +
      '止める前に、まず外へ出た成果（PR・コミット・送信済みのメール・登録済みの予定・投稿先など）を確かめること。' +
      unpushedNote +
      '確かめずに止めると、失われるのは会話だけではない——そのターンで進行中だった' +
      '作業も一緒に失われうる。確かめたうえで、/msg で送ると resume を試みる。'
    );
  }
  if (resetTimeSkewMatch === 'active') {
    return (
      '      認証トークン: 429の文言に書かれていた resets 時刻が、現役の鍵自身の' +
      '冷却期限と一致した——世代ずれではなく、待てば戻る。'
    );
  }
  return (
    `      認証トークンの世代ずれの判定: この一覧が知らない値 ` +
    `"${String(resetTimeSkewMatch)}"（デーモンの版が新しい可能性）。`
  );
}

// core の `formatUnpushedWorkObservationWorktrees`（`tools.ts`、export されていない）と同じ判断の複製。
function formatUnpushedWorkObservationWorktrees(
  worktrees: readonly { relativePath: string; branch: string | null }[],
): string {
  return worktrees.length === 0
    ? '見つかった作業ツリー0本'
    : worktrees
        .map(
          (wt) =>
            `${wt.relativePath}: branch=${wt.branch === null ? 'null（取れなかった）' : wt.branch}`,
        )
        .join(' / ');
}

function unpushedWorkObservationIncompleteSuffix(
  observation: Extract<ManagerUnpushedWorkObservation, { kind: 'observed' }>,
): string {
  const note = describeUnpushedWorkObservationIncompleteness(observation);
  return note === null ? '' : `\n      ${note}`;
}

// core の `describeUnpushedWorkObservation`（`tools.ts`）と同じ分岐の複製。`cwd`（探索の起点の絶対パス）は載せない。
// 器の入れ替えで応答不能な委譲は、`shutdownObservationArrivedAfterSwap` で言い分ける。
function unpushedWorkObservationLine(manager: ManagerListItem): string | null {
  const observation = manager.lastUnpushedWorkObservation;

  if (manager.sessionMissingSince !== undefined) {
    if (manager.shutdownObservationArrivedAfterSwap === true && observation !== undefined) {
      if (observation.kind === 'unavailable') {
        return (
          `      未push観測: 器が止まる直前（${observation.at}）に取ろうとしたが取れなかった: ` +
          redactBody(observation.reason)
        );
      }
      if (isEmptyCompleteUnpushedWorkObservation(observation)) return null;
      return (
        `      未push観測: 器が止まる直前（${observation.at}）の観測: ` +
        formatUnpushedWorkObservationWorktrees(observation.worktrees) +
        unpushedWorkObservationIncompleteSuffix(observation)
      );
    }
    const shown =
      observation === undefined
        ? '表示中の観測は無い（一度も取れていない）'
        : observation.kind === 'unavailable'
          ? `表示中の観測は ${observation.at} 時点・${describeUnpushedWorkObservationSource(observation.source)} のもの（取れなかった: ${redactBody(observation.reason)}）`
          : `表示中の観測は ${observation.at} 時点・${describeUnpushedWorkObservationSource(observation.source)} のもの: ${formatUnpushedWorkObservationWorktrees(observation.worktrees)}` +
            unpushedWorkObservationIncompleteSuffix(observation);
    return (
      '      ⚠ 未push観測: 器が止まる直前の観測は届いていない' +
      '（best-effort の送信のため。未pushが無かったことを意味しない）。' +
      shown
    );
  }

  if (observation === undefined) return null;
  if (isEmptyCompleteUnpushedWorkObservation(observation)) return null;
  const provenance = describeUnpushedWorkObservationProvenance(observation.source, 'この一覧');
  if (observation.kind === 'unavailable') {
    return (
      `      未push観測（${provenance}）: 取れなかった（${observation.at}）: ` +
      redactBody(observation.reason)
    );
  }
  return (
    `      未push観測（${provenance}、${observation.at}）: ` +
    formatUnpushedWorkObservationWorktrees(observation.worktrees) +
    unpushedWorkObservationIncompleteSuffix(observation)
  );
}

// `status` を受ける: 絞った0件と絞っていない0件を同じ「1本も居ません」にすると、絞りを外せば見える一覧まで「居ない」と読める。
export function renderManagerList(
  managers: ManagerListItem[],
  status?: string,
  unreadable: readonly UnreadableJob[] = [],
  now: Date = new Date(),
): string {
  if (managers.length === 0) {
    // 読めない行は状態も取れないので、`status` で絞った先に居ないとも言えない。
    if (unreadable.length > 0) {
      return status === undefined
        ? '（読めたマネージャーは居ません。居ないとは言えません）'
        : `status=${status} に当たる読めたマネージャーは居ません（読めない行の状態は分からないので、居ないとは言えません）`;
    }
    return status === undefined
      ? '（マネージャーは1本も居ません）'
      : `status=${status} に当たるマネージャーは居ません（絞り込みを外せば見えるかもしれません）`;
  }

  const lines: string[] = [];
  managers.forEach((manager, index) => {
    // 字面は `describeManagerState` から取る（唯一の生成元）: 自前で組むと、`live` の「取れていない」（`undefined`）を表せず、
    // 面によって字面が割れる。第3引数まで通す。
    lines.push(
      `  [${index + 1}] ${manager.managerId}  ` +
        `[${describeManagerState(manager.status, manager.live, manager.awaitingBackground)}]  ` +
        `${summarizeText(manager.request)}`,
    );
    lines.push(`      cwd: ${manager.cwd}`);
    lines.push(`      作成: ${manager.startedAt}  更新: ${manager.updatedAt}`);
    // 断定は「器が黙っている」まで: その中で走っていたかどうかはこの観測から言えない。
    // 「いま話しかけられない」と書かない: 実測で偽だった。`lost` の器に載っている委譲へも `ManagerPool.send()` は届き、resume の口が叩かれる。
    // 書いてよいのは「新しい委譲の宛先からは外れている」まで。CLI には器を見る命令が無いので `runner_list` を名指ししない。
    if (manager.runnerLostSince !== undefined) {
      lines.push(
        `      ⚠ 宛先の器は ${manager.runnerLostSince} 以降 名乗っていない。` +
          '新しい委譲の宛先からは外れている（置き先として数えない）。' +
          '**この委譲が失われたという意味ではない** — ' +
          '黙っているのが器なのか経路なのかは、ここからは言えない（器の中でまだ走っていることもある）。' +
          '話しかけることは塞いでいない — 戻る先（session_id）が在れば、' +
          '/msg で送ると resume を試みる（届くとは限らない）。' +
          '打つ手はこの委譲の側ではなく器の側にある — 名乗らなくなった器そのものを確かめること',
      );
    }
    // `runnerLostSince`（entry は残っているが黙っている）とは別の集合で、排他ではない。文言の核は `describeRunnerVanished`（`tools.ts`）と揃える。
    if (manager.runnerVanished === true) {
      lines.push(
        `      ⚠ 宛先の器が名簿から消えている（この委譲の走り始めは ${manager.startedAt}。` +
          '消えた時刻は名簿に残っていないので分からない）。' +
          'resume を試したわけではないので「戻れなかった(lost)」ではなく、lost で絞っても出てこない。' +
          '状態は走行中のまま残っている — 確かめる前に起こし直さないこと（同じ仕事が2本になる）',
      );
    }
    // `runnerLostSince` とは別の欄: 器は答えているが、この委譲のセッションだけが無い。`live` は落ちない。
    // 「失われた」と読ませない: 完遂した後にセッションが畳まれ、終端イベントだけが届かなかった回も同じ形に見え、区別する材料が無い。
    if (manager.sessionMissingSince !== undefined) {
      lines.push(
        `      ⚠ 宛先の runner は ${manager.sessionMissingSince} の時点で、この委譲のセッションを持っていなかった` +
          '（runner がそう答えた。聞けなかったのではない）。' +
          // 由来はクローンの面と同じ生成元から取る: 自前で書くと、同じ状態が面によって違う次の一手を指す。
          describeSessionMissingKind(manager.sessionMissingKind) +
          '**この委譲が失われたという意味ではない** — ' +
          '完遂した後にセッションが畳まれ、終端の合図だけが届かなかった回も同じ形に見える。' +
          'まず /manager で生ログを確かめること（報告が届いていなくても、' +
          'そこに書き終えた報告が残っていることがある）。話しかければ resume から入り直す',
      );
    }
    // 言い切れるのは観測した分まで: デーモンが見ているのは「前のセッションへ戻れたか」だけで、成果の有無は見ていない。
    if (manager.status === 'lost') {
      lines.push(
        '      ⚠ 前のセッションへ戻れなかった。見ているのは戻れたかどうかだけで、' +
          '成果が既に外へ出ていることがある（PR・コミット・送信済みのメール・登録済みの予定・投稿先など）。' +
          '起こし直す前にそこを確かめること',
      );
    }
    const unobserved = describeUnobservedOutcome(manager);
    if (unobserved !== null) lines.push(`      ${unobserved}`);
    const denied = denialLine(manager.denials, manager.lastReportAt);
    if (denied !== null) lines.push(`      ${denied}`);
    for (const item of manager.waiting) {
      lines.push(
        `      返事待ち (${item.requestId})  種別: ${describeWaitingKind(item.kind)}` +
          `${describeAskedAt(item.askedAt)}: ${summarizeText(item.summary)}`,
      );
    }
    // 失敗は報告の上に置く: 下に置くと、包まれたエラー文（`lastReport`）を先に読んでから「実は報告ではない」と分かる順になる。
    // 枠・システムエラー・cgroup の行は `lastFailure` とは別の軸で、同時に出ることがある。
    const failed = failureLine(manager.lastFailure, manager.status, manager.lastFoldedTurn);
    if (failed !== null) lines.push(`      ${failed}`);
    const usageStopped = usageStoppedLine(manager.usageStoppedAt, manager.status);
    if (usageStopped !== null) lines.push(usageStopped);
    const systemError = systemErrorLine(manager.status, manager.lastSystemError);
    if (systemError !== null) lines.push(systemError);
    const cgroupEvents = cgroupEventsLine(manager.status, manager.lastCgroupEvents);
    if (cgroupEvents !== null) lines.push(cgroupEvents);
    // 失敗した回は「報告」と呼ばない。`lastFoldedTurn` が在る回の `lastReport` は畳まれる前の無関係な古いターンのままなので、
    // 直近届いた本文（`lastFoldedTurn.text`）を受信時刻つきで出す。
    if (manager.lastFoldedTurn !== undefined) {
      lines.push(
        `      停止後に届いた、畳まれたターンの中身（${manager.lastFoldedTurn.at} 受信）: ` +
          summarizeText(manager.lastFoldedTurn.text),
      );
    } else if (manager.lastReport) {
      const label = isFoldedTurnReport(manager) ? '直近のターンの中身' : '直近の報告';
      lines.push(`      ${label}: ${summarizeText(manager.lastReport)}`);
    }
    // 報告の行には受信時刻が無く、足すと既存の行の形が変わるので、食い違いの印は別の行で出す。
    const reportDrift = describeReportDriftMark(manager, now);
    if (reportDrift !== null) lines.push(`      ${reportDrift}`);
    // 判定も字面も `manager_list` と同じ関数を呼び、ここで組み直さない。返る文字列は行頭インデント（2 桁）を含むので、この面の深さへ替える。
    const turnEnd = describeTurnEnd(manager);
    if (turnEnd !== null) lines.push(`      ${turnEnd.trimStart()}`);
    const toolUseStall = describeToolUseStall(manager);
    if (toolUseStall !== null) lines.push(`      ${toolUseStall.trimStart()}`);
    const tokenGenerationUnknown = tokenGenerationUnknownReasonLine(
      manager.tokenGenerationUnknownReason,
    );
    if (tokenGenerationUnknown !== null) lines.push(tokenGenerationUnknown);
    const resetTimeSkew = resetTimeSkewLine(
      manager.resetTimeSkewMatch,
      unpushedWorkObservationLine(manager) !== null,
    );
    if (resetTimeSkew !== null) lines.push(resetTimeSkew);
    const unpushedWork = unpushedWorkObservationLine(manager);
    if (unpushedWork !== null) lines.push(unpushedWork);
  });
  return lines.join('\n');
}

type ManagerWaitingItem = ManagerListItem['waiting'][number];

// `kind` は省略されうる（猶予中の旧 runner の応答には乗らない）: 「実行許可」と決めつけると、実際は質問だったときに人間が `/allow` を打ってしまう。
function describeWaitingKind(kind: ManagerWaitingItem['kind']): string {
  if (kind === 'question') return '質問';
  if (kind === 'permission') return '実行許可';
  return '種別不明';
}

// 絶対値をそのまま出す: 相対表現（「4時間前」）は作らない（AGENTS.md「時刻の扱い」）。無いときは `-` で埋めない: 意味の決まっていない値を作ることになる。
function describeAskedAt(askedAt: ManagerWaitingItem['askedAt']): string {
  return askedAt === undefined ? '' : `  確認: ${askedAt}`;
}

// 表示と番号の対応を一緒に作って返す: 別々に作ると、ずれた瞬間に人間が見ていない確認へ答える。
// `kind`/`askedAt` が欠けていても行は出す: 丸ごと落とすと、人間の返事を待っている最中に口が消える。
export function renderWaitingList(managers: ManagerListItem[]): {
  text: string;
  entries: { managerId: string; requestId: string }[];
} {
  const entries: { managerId: string; requestId: string }[] = [];
  const lines: string[] = [];
  for (const manager of managers) {
    for (const item of manager.waiting) {
      entries.push({ managerId: manager.managerId, requestId: item.requestId });
      const [head, ...rest] = redactBody(item.summary).split('\n');
      lines.push(`  [${entries.length}] ${head ?? ''}`);
      for (const line of rest) lines.push(`      ${line}`);
      lines.push(
        `      manager: ${manager.managerId}  requestId: ${item.requestId}` +
          `  種別: ${describeWaitingKind(item.kind)}${describeAskedAt(item.askedAt)}`,
      );
    }
  }
  if (entries.length === 0) {
    return { text: '（返事待ちのマネージャーはいません）', entries: [] };
  }
  return { text: lines.join('\n'), entries };
}

type ScheduleSpecInput =
  | { type: 'daily'; at: string }
  | { type: 'every'; minutes: number }
  | { type: 'cron'; expression: string };

// cron 式は空白を含むので、依頼の本文との境目を語数で決める: 引用符を要求すると、シェルの引用と混ざって書けなくなる。
// 依頼の本文は生の文字列のまま返す: 改行・インデント・連続した空白を潰さない。
function takeWhen(when: string): { spec: ScheduleSpecInput; request: string } | null {
  const [head, ...tail] = when.trim().split(/\s+/);
  if (head === undefined || head === '') return null;

  if (head === 'cron') {
    if (tail.length < 6) return null;
    return {
      spec: { type: 'cron', expression: tail.slice(0, 5).join(' ') },
      request: rawTail(when, 6),
    };
  }

  const request = rawTail(when, 1);
  if (/^(?:[01]?\d|2[0-3]):[0-5]\d$/.test(head)) {
    return { spec: { type: 'daily', at: head }, request };
  }
  const minutes = /^(\d+)m?$/.exec(head);
  if (minutes === null) return null;
  const parsed = Number(minutes[1]);
  return parsed >= 1 ? { spec: { type: 'every', minutes: parsed }, request } : null;
}

interface UsageFilters {
  from?: string;
  to?: string;
  managerId?: string;
  layer?: UsageLayer;
  site?: UsageSite;
  tokenId?: string;
}

type ParsedUsageFilters = { ok: true; filters: UsageFilters } | { ok: false; message: string };

type KeyValueTokens = { ok: true; values: Record<string, string> } | { ok: false; message: string };

// 知らないキー・`=` の無い語・値が空のトークンは黙って落とさない: 落とすと `/usage mgr=abc` が絞らない全体の数字を返し、人間が読み違える。
function parseKeyValueTokens(tokens: string[], allowedKeys: readonly string[]): KeyValueTokens {
  const allowed = allowedKeys.map((key) => `${key}=`).join(' / ');
  const values: Record<string, string> = {};
  for (const token of tokens) {
    if (token.length === 0) continue;
    const separator = token.indexOf('=');
    if (separator === -1) {
      return { ok: false, message: `使わない語です: ${token}（使えるのは ${allowed}）` };
    }
    const key = token.slice(0, separator);
    const value = token.slice(separator + 1);
    if (!allowedKeys.includes(key)) {
      return { ok: false, message: `知らないキーです: ${key}=（使えるのは ${allowed}）` };
    }
    if (value.length === 0) {
      return { ok: false, message: `${key}= の値が空です（使えるのは ${allowed}）` };
    }
    values[key] = value;
  }
  return { ok: true, values };
}

export type ParsedJournalSearchTokens =
  { ok: true; limit?: string; type?: string; q?: string } | { ok: false; message: string };

// `q=` はそのトークンから行末までを1つの語として扱う: 空白で割った後のトークン列では、空白を含む語で探せない。
// `type=` は `q=` より前だけを見る。件数は `type=` にも `q=` にも当たらない最初のトークン: 「最初の非空トークン」と読むと `type=decision` を件数と誤読する。
// 値が空・知らないキー・2つ目以降の位置引数は使い方の誤りにする: HTTP 側は空文字列を「絞らない」に倒すので、黙って通すと全件を読む。
// 種別の集合は core の `JOURNAL_ENTRY_TYPES` だけが持つので、書き写さずそこから組む。
export function parseJournalSearchTokens(tokens: string[]): ParsedJournalSearchTokens {
  const qIndex = tokens.findIndex((token) => token.startsWith('q='));
  const before = qIndex === -1 ? tokens : tokens.slice(0, qIndex);

  const usable = '（使えるのは [件数] / type= / q=）';
  let type: string | undefined;
  let limit: string | undefined;
  for (const token of before) {
    if (token.length === 0) continue;
    if (token.startsWith('type=')) {
      const value = token.slice('type='.length);
      if (value.length === 0) return { ok: false, message: `type= の値が空です${usable}` };
      type ??= value;
    } else if (token.includes('=')) {
      return {
        ok: false,
        message: `知らないキーです: ${token.slice(0, token.indexOf('=') + 1)}${usable}`,
      };
    } else if (limit === undefined) {
      limit = token;
    } else {
      return { ok: false, message: `使わない語です: ${token}${usable}` };
    }
  }

  if (type !== undefined) {
    const unknown = type
      .split(',')
      .filter((value) => value.length > 0)
      .filter((value) => !(JOURNAL_ENTRY_TYPES as readonly string[]).includes(value));
    if (unknown.length > 0) {
      return {
        ok: false,
        message:
          `type= に知らない値が入っています: ${unknown.join(', ')}` +
          `（使えるのは ${JOURNAL_ENTRY_TYPES.join(' / ')}）`,
      };
    }
  }

  if (qIndex === -1) {
    return {
      ok: true,
      ...(limit === undefined ? {} : { limit }),
      ...(type === undefined ? {} : { type }),
    };
  }
  const q = tokens.slice(qIndex).join(' ').slice('q='.length);
  if (q.trim().length === 0) return { ok: false, message: `q= の値が空です${usable}` };
  return {
    ok: true,
    ...(limit === undefined ? {} : { limit }),
    ...(type === undefined ? {} : { type }),
    q,
  };
}

// 層と場所の値の集合は core の schema だけが持つ: chat 側に書き写すと、値が増えたときにここだけ古くなる。
// `token=` は検査しない: 値の集合が閉じていない（プールは器ごとに違う）。
function parseUsageFilters(tokens: string[]): ParsedUsageFilters {
  const parsed = parseKeyValueTokens(tokens, ['from', 'to', 'manager', 'layer', 'site', 'token']);
  if (!parsed.ok) return parsed;
  const raw = parsed.values;
  const layer = narrowUsageAxis<UsageLayer>(usageLayerSchema, raw.layer);
  if (!layer.ok) return { ok: false, message: `layer= は ${layer.allowed} のどれか` };
  const site = narrowUsageAxis<UsageSite>(usageSiteSchema, raw.site);
  if (!site.ok) return { ok: false, message: `site= は ${site.allowed} のどれか` };
  return {
    ok: true,
    filters: {
      ...(raw.from === undefined ? {} : { from: raw.from }),
      ...(raw.to === undefined ? {} : { to: raw.to }),
      ...(raw.manager === undefined ? {} : { managerId: raw.manager }),
      ...(layer.value === undefined ? {} : { layer: layer.value }),
      ...(site.value === undefined ? {} : { site: site.value }),
      ...(raw.token === undefined ? {} : { tokenId: raw.token }),
    },
  };
}

function isKeyValueToken(token: string): boolean {
  return token.includes('=');
}

function keyValueReferenceMessage(command: string, token: string): string {
  return (
    `使い方の誤り: ${command} は先頭に <番号|id> が要ります。[${token}] は key=value の形で、参照ではありません` +
    '（key=value は参照の後ろに書きます）\n'
  );
}

function keyValueIdMessage(command: string, token: string): string {
  return `使い方の誤り: ${command} は <id> が要ります。[${token}] は key=value の形で、id ではありません\n`;
}

const REFERENCE_FIRST_COMMANDS: ReadonlySet<string> = new Set([
  '/conversation',
  '/edit',
  '/stop',
  '/manager',
  '/msg',
  '/reply',
  '/allow',
  '/deny',
  '/approval-trace',
  '/approval',
  '/answer',
  '/commitment',
  '/done',
  '/commit-edit',
]);

function resolveListedId(reference: string, listed: string[]): string | null {
  if (/^\d+$/.test(reference)) return listed[Number(reference) - 1] || null;
  return reference;
}

// 固定の文言だけを返して状態コードも理由も捨てる口を作らないための、口ごとに共通の1本。
async function withDetail(
  message: string,
  response: { status: number; json: () => Promise<unknown> },
): Promise<string> {
  return `${message} — ${await errorDetail(response)}`;
}

// 本文が読めなくても削除済みとは言える: 410 という状態そのものが「消した」を表すため。
async function describeRemovedBody(
  subject: string,
  response: { json: () => Promise<unknown> },
): Promise<string> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    // 本文が JSON でない（プロキシの HTML 等）。いつ・何バイトかは言えない。
  }
  const { removedAt, bytes, archiveId } = (body ?? {}) as Record<string, unknown>;
  if (typeof removedAt !== 'string' || typeof bytes !== 'number') {
    return `${subject}は、本文が削除済みです（いつ消したか・何バイトだったかは読めませんでした）`;
  }
  const id = typeof archiveId === 'string' ? `（アーカイブ id: ${redactError(archiveId)}）` : '';
  return (
    `${subject}は、${redactError(removedAt)} に本文を消しました${id}。` +
    `消した本文は ${String(bytes)}バイト（${ARCHIVE_REMOVED_BYTES_UNIT_NOTE}）。中身は戻せません`
  );
}

// `session_missing`・`declined` は HTTP 200 でも届いていない。
const DELIVERED_OUTCOMES: ReadonlySet<string> = new Set(['delivered', 'answered']);

// `not_stopped`・`unknown` を止まったとみなさない: 止まったと確かめられていないため。
const STOPPED_OUTCOMES: ReadonlySet<string> = new Set(['stopped']);

// 拒否リスト（`session_missing` 等）にしない: デーモンが値を足したとき、黙って成功になるため。
function reportOutcome(
  result: { outcome: string; detail: string },
  succeeded: ReadonlySet<string>,
  onFailed: ((reason: string) => void) | undefined,
): void {
  const text = `${result.outcome}: ${result.detail}`;
  if (succeeded.has(result.outcome)) {
    stdout.write(`${text}\n`);
    return;
  }
  stdout.write(`✗ ${text}\n`);
  onFailed?.(text);
}

async function errorDetail(response: { status: number; json: () => Promise<unknown> }) {
  try {
    const body: unknown = await response.json();
    if (typeof body === 'object' && body !== null && 'error' in body) {
      const { error } = body as { error?: unknown };
      if (typeof error === 'string' && error.length > 0) return redactError(error);
    }
  } catch {
    // 本文が JSON でない（プロキシの HTML 等）。状態コードへ倒す。
  }
  return `HTTP ${response.status}（理由は読めませんでした）`;
}

// 要求が通ってから「蒸留しています」と言う: 失敗したときに、走っていない蒸留を走っているとは言わない。
export async function endConversationOnExit(
  client: DaemonClient,
  target: Target,
  conversationId: string,
  write: (text: string) => void = (text) => void stdout.write(text),
): Promise<void> {
  write('\n（会話を終えています…）\n');
  let reason: string;
  try {
    const response = await client.chat[':conversationId'].end.$post({
      param: { conversationId },
    });
    if (response.ok) {
      write('（学びを記憶へ蒸留しています…）\n');
      return;
    }
    reason = describeAuthFailure(response.status, target) ?? (await errorDetail(response));
  } catch (error) {
    // 案内の文は句点で終わるので、括弧の中では句点を外す。
    reason = isConnectionFailure(error)
      ? describeCliFailure(error).replace(/。$/, '')
      : redactError(error instanceof Error ? error.message : String(error));
  }
  write(
    `会話 ${conversationId} を終えられませんでした（${reason}）。会話は終わっておらず、` +
      '学びの蒸留も走っていません。あとで Web の会話画面の「会話を終える」か、' +
      `alteroid tui で /conversations から開き直して /end で終えられます\n`,
  );
}

export type ParsedManagerFilters =
  | {
      ok: true;
      query: { status?: string; limit?: string };
      after?: string;
    }
  | { ok: false; message: string };

// `status=` の値の集合は core の schema だけが持つ: chat 側に書き写すと札が増えたときにここだけ古くなる。
// `limit=` は検査しない: 範囲を持つのはデーモンの側で、書き写すと片方だけ動いたときに CLI が「通るはずの値」を拒む側になる。
export function parseManagerFilters(tokens: string[]): ParsedManagerFilters {
  const parsed = parseKeyValueTokens(tokens, ['status', 'limit', 'after']);
  if (!parsed.ok) return parsed;
  const raw = parsed.values;

  if (raw.status !== undefined) {
    // 空の要素（`status=a,,b`）は落とす: デーモンの `parseManagerStatuses` が同じ落とし方をするので、数えると CLI だけが断る形になる。
    const unknown = raw.status
      .split(',')
      .filter((value) => value.length > 0)
      .filter((value) => !jobStatusSchema.safeParse(value).success);
    if (unknown.length > 0) {
      return {
        ok: false,
        message:
          `status= に知らない値が入っています: ${unknown.join(', ')}` +
          `（使えるのは ${jobStatusSchema.options.join(' / ')}）`,
      };
    }
  }

  return {
    ok: true,
    query: {
      ...(raw.status === undefined ? {} : { status: raw.status }),
      ...(raw.limit === undefined ? {} : { limit: raw.limit }),
    },
    ...(raw.after === undefined ? {} : { after: raw.after }),
  };
}

// 言えるのは「要求した上限とちょうど同じ件数が返った」という1つの事実だけ: `GET /managers` は封筒を持たない。
// `noteIfAtLimit` を使わない理由は、続きの打ち方まで出すこと。`status=` は打たれた字面をそのまま繰り返す: 絞りを外した命令を案内すると別の一覧へ移る。
export function renderManagersWindowNote(
  count: number,
  query: { status?: string; limit?: string },
): string | null {
  const { limit, status } = query;
  if (limit === undefined) return null;
  // `Number(limit)` が NaN なら黙る: `!==` は NaN で必ず真になり、切れていない一覧に注記を付けてしまう。
  if (!Number.isFinite(Number(limit)) || count !== Number(limit)) return null;
  const statusPart = status === undefined ? '' : ` status=${status}`;
  return (
    `limit=${limit} 件ちょうど返った。これより古い委譲が残っているかもしれない（判定できない）。\n` +
    `  続きは /managers${statusPart} limit=${limit} after=${count}\n`
  );
}

type WaitingTarget =
  { ok: true; managerId: string; requestId: string } | { ok: false; message: string };

// 宛先を CLI 側で当てない: 同じ `requestId` を複数のマネージャーが持つことは原理的に否定できない（AGENTS.md「踏みやすい地雷」）。
// 2件以上ならどちらへも送らず両方を出し、先頭を選ばない。
async function resolveWaitingTarget(
  reference: string,
  listedWaiting: Listed['waiting'],
  client: ReturnType<typeof createClient>,
): Promise<WaitingTarget> {
  if (/^\d+$/.test(reference)) {
    const entry = listedWaiting[Number(reference) - 1];
    if (entry === undefined) {
      return { ok: false, message: `[${reference}] は /waiting の一覧にありません` };
    }
    return { ok: true, managerId: entry.managerId, requestId: entry.requestId };
  }

  const response = await client.managers.$get({
    query: {},
  });
  if (!response.ok) {
    return {
      ok: false,
      message: await withDetail('マネージャーの一覧を読めませんでした', response),
    };
  }
  const { managers } = await response.json();
  const owners = managers.filter((manager) =>
    manager.waiting.some((item) => item.requestId === reference),
  );
  if (owners.length === 0) {
    return {
      ok: false,
      message: `${reference} という requestId を待っているマネージャーは居ません`,
    };
  }
  if (owners.length > 1) {
    return {
      ok: false,
      message:
        `${reference} は複数のマネージャーが待っています。どちらか分からないので` +
        `送っていません: ${owners.map((manager) => manager.managerId).join(' / ')}`,
    };
  }
  const owner = owners[0];
  if (owner === undefined) {
    return {
      ok: false,
      message: `${reference} という requestId を待っているマネージャーは居ません`,
    };
  }
  return { ok: true, managerId: owner.managerId, requestId: reference };
}

type DecisionOnlyTarget = { ok: true; managerId: string } | { ok: false; message: string };

// ここでも宛先を当てない: 返事待ちのマネージャーが2本以上あれば、どちらへも送らず候補を出す。
async function resolveDecisionOnlyManager(
  client: ReturnType<typeof createClient>,
): Promise<DecisionOnlyTarget> {
  const response = await client.managers.$get({
    query: {},
  });
  if (!response.ok) {
    return {
      ok: false,
      message: await withDetail('マネージャーの一覧を読めませんでした', response),
    };
  }
  const { managers } = await response.json();
  const waiting = managers.filter((manager) => manager.waiting.length > 0);
  if (waiting.length === 0) {
    return { ok: false, message: '返事待ちのマネージャーはいません' };
  }
  if (waiting.length > 1) {
    return {
      ok: false,
      message:
        '複数のマネージャーが返事待ちです。どれに送るか分からないので送っていません: ' +
        waiting.map((manager) => manager.managerId).join(' / '),
    };
  }
  const only = waiting[0];
  if (only === undefined) {
    return { ok: false, message: '返事待ちのマネージャーはいません' };
  }
  return { ok: true, managerId: only.managerId };
}

// `line.split(/\s+/)` では引用符の中の空白ごと割れてしまうので、`/answers` の処理でだけこちらを使う（他のコマンドの単純な空白分割は変えない）。
function tokenizeQuoted(text: string): string[] {
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  const tokens: string[] = [];
  for (const match of text.matchAll(pattern)) {
    tokens.push(match[1] ?? match[2] ?? match[3] ?? '');
  }
  return tokens;
}

// `tokenizeQuoted` は引用符が語の先頭にあるときだけ効くので、`設問id=文`（`--other q2="ただし 来週"`）の形には使えない。
function tokenizeWithQuotes(text: string): QuotedToken[] {
  const tokens: QuotedToken[] = [];
  let current = '';
  let started = false;
  let start = 0;
  let quote: '"' | "'" | null = null;
  let index = 0;
  for (const char of text) {
    if (quote !== null) {
      if (char === quote) quote = null;
      else current += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      if (!started) start = index;
      started = true;
    } else if (/\s/.test(char)) {
      if (started) tokens.push({ value: current, start, end: index });
      current = '';
      started = false;
    } else {
      current += char;
      if (!started) start = index;
      started = true;
    }
    index += char.length;
  }
  if (started) tokens.push({ value: current, start, end: index });
  return tokens;
}

interface QuotedToken {
  value: string;
  start: number;
  end: number;
}

// 突き合わせはデーモンが行う: 知らない id は 400 で返る。
function parseStructuredAnswer(
  text: string,
): { selections: ApprovalSelection[]; supplement: string } | { error: string } {
  const tokens = tokenizeWithQuotes(text);
  const selections: ApprovalSelection[] = [];
  // 補足は、隣り合う語の間の生の空白（改行・インデント・連続した空白）を保って繋ぐ。フラグを挟んだ語どうしは空白1つで繋ぐ。
  let supplement = '';
  let lastSupplement = -1;
  const entryOf = (questionId: string): ApprovalSelection => {
    let entry = selections.find((candidate) => candidate.questionId === questionId);
    if (entry === undefined) {
      entry = { questionId, optionIds: [] };
      selections.push(entry);
    }
    return entry;
  };
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === undefined) break;
    const flag = /^--(select|other)(?:=([\s\S]*))?$/.exec(token.value);
    if (flag === null) {
      const previous = lastSupplement === i - 1 ? tokens[lastSupplement] : undefined;
      if (previous !== undefined) supplement += text.slice(previous.end, token.start);
      else if (supplement !== '') supplement += ' ';
      supplement += token.value;
      lastSupplement = i;
      continue;
    }
    const name = flag[1] as 'select' | 'other';
    let value = flag[2];
    if (value === undefined) {
      i += 1;
      value = tokens[i]?.value;
    }
    const eq = value === undefined ? -1 : value.indexOf('=');
    if (value === undefined || eq <= 0) {
      return {
        error:
          `--${name} は --${name} <設問id>=${name === 'select' ? '<選択肢id>[,<選択肢id>...]' : '<文>'}` +
          ' の形で書いてください',
      };
    }
    const questionId = value.slice(0, eq);
    const rest = value.slice(eq + 1);
    const entry = entryOf(questionId);
    if (name === 'select') {
      entry.optionIds.push(
        ...rest
          .split(',')
          .map((optionId) => optionId.trim())
          .filter((optionId) => optionId !== ''),
      );
    } else {
      entry.other = entry.other === undefined ? rest : `${entry.other} ${rest}`;
    }
  }
  if (selections.length === 0) {
    return { error: '--select か --other に1つ以上の設問を書いてください' };
  }
  return { selections, supplement };
}

interface AnswerPair {
  reference: string;
  answer: string;
}

// 一部だけ解釈して送ると、書いたつもりの件が黙って落ちるので、不正なら全体を `null` にする。
function parseAnswerPairs(tokens: string[]): AnswerPair[] | null {
  if (tokens.length === 0 || tokens.length % 2 !== 0) return null;
  const pairs: AnswerPair[] = [];
  for (let i = 0; i < tokens.length; i += 2) {
    const reference = tokens[i];
    const answer = tokens[i + 1];
    if (reference === undefined || answer === undefined || answer.length === 0) return null;
    pairs.push({ reference, answer });
  }
  return pairs;
}

const COMMITMENT_ORIGIN_LABEL: Record<Commitment['origin'], string> = {
  human: '人間',
  manager: 'マネージャー',
  external: '外部',
  self: '自分',
};

// 「片付いたのではない」を落とさない: 落とすと、読めない行が静かに未了から消えたのと区別が付かない。
function renderUnreadableNotice(unreadable: UnreadableCommitment[]): string {
  if (unreadable.length === 0) return '';
  const ids = unreadable.map((entry) => entry.id).filter((id): id is string => id !== undefined);
  return (
    `  ⚠ 読めない行が ${unreadable.length} 件あります` +
    (ids.length === 0 ? '' : `（id: ${ids.join(', ')}）`) +
    '。片付いたのではありません。'
  );
}

// 「壊れた行であって、回答済み・取り下げ済みではない」を落とさない。番号は振らない: 読めない行へは `/answer` できない。
function renderUnreadableApprovalNotice(unreadable: UnreadableApproval[]): string {
  if (unreadable.length === 0) return '';
  const ids = unreadable.map((entry) => entry.id).filter((id): id is string => id !== undefined);
  return (
    `  ⚠ 読めない承認待ちが ${unreadable.length} 件あります` +
    (ids.length === 0 ? '' : `（id: ${ids.join(', ')}）`) +
    '。壊れた行であって、回答済み・取り下げ済みではありません。この一覧には載っていません。'
  );
}

// 「壊れた行であって、居ないのでも、畳まれたのでもない」を落とさない。番号は振らない: 読めない行へは `/msg` も `/stop` もできない。
function renderUnreadableJobNotice(unreadable: readonly UnreadableJob[]): string {
  if (unreadable.length === 0) return '';
  const ids = unreadable.map((entry) => entry.id).filter((id): id is string => id !== undefined);
  return (
    `  ⚠ 読めない委譲が ${unreadable.length} 件あります` +
    (ids.length === 0 ? '' : `（id: ${ids.join(', ')}）`) +
    '。壊れた行であって、居ないのでも、畳まれたのでもありません。この一覧には載っていません。'
  );
}

// 「壊れた行であって、消された依頼ではない」を落とさない。
function renderUnreadableScheduleNotice(unreadable: UnreadableSchedule[]): string {
  if (unreadable.length === 0) return '';
  const kinds = unreadable
    .map((entry) => entry.kind)
    .filter((kind): kind is string => kind !== undefined);
  return (
    `  ⚠ 読めない継続中の依頼が ${unreadable.length} 件あります` +
    (kinds.length === 0 ? '' : `（kind: ${kinds.join(', ')}）`) +
    '。壊れた行であって、消された依頼ではありません。この一覧には載っていません。' +
    (kinds.length === 0 ? '' : '外すなら /unschedule <kind> です。')
  );
}

function renderTrimmedClosedNotice(trimmedClosed: number): string {
  if (trimmedClosed === 0) return '';
  return (
    `  ⚠ 保持上限を超えて物理削除された片付き行が累計 ${trimmedClosed} 件あります。` +
    '削除された分の内容はここでは二度と読めません。'
  );
}

// 番号と id の対応をここで一緒に作って返す: 別々に並べ直すと、ずれた瞬間に人間が見ていないものを閉じる。
// 番号は片付いたものにも振る: 抜け番にすると、人間が数え直して指すことになる。
export function renderCommitments(
  commitments: Commitment[],
  now: number = Date.now(),
  unreadable: UnreadableCommitment[] = [],
  trimmedClosed = 0,
): { text: string; ids: string[] } {
  // 読めない行の断りを、読める行が0件のときも出す: 下の早期 return より後ろへ置くと、
  // 読めない行だけの台帳が「仕事はありません」という安心な文言で出る。
  const notices = [renderUnreadableNotice(unreadable), renderTrimmedClosedNotice(trimmedClosed)]
    .filter((line) => line !== '')
    .join('\n');

  if (commitments.length === 0) {
    return {
      text:
        notices === ''
          ? '（引き受けたまま終わっていない仕事はありません）'
          : `${notices}\n（読める行は無い）`,
      ids: [],
    };
  }

  const lines: string[] = [];
  const ids: string[] = [];
  if (notices !== '') lines.push(notices);

  commitments.forEach((commitment, index) => {
    ids.push(commitment.id);
    const closed = commitment.closedAt !== undefined;
    lines.push(`  [${index + 1}] ${closed ? '✓ ' : ''}${summarizeText(commitment.body)}`);
    const from =
      COMMITMENT_ORIGIN_LABEL[commitment.origin] +
      (commitment.source === undefined ? '' : `(${commitment.source})`);
    // 齢の表示は残す: 人間が一覧を読むときに効くのはそこで、ISO を足したから要らなくなるものではない。
    lines.push(
      `      id: ${commitment.id}  起点: ${from}  作成: ${commitment.at}` +
        `（${formatElapsedAgo(commitment.at, now)}）  更新: ${commitmentUpdatedAt(commitment)}`,
    );
    if (closed) {
      lines.push(
        `      片付けた: ${commitment.closedAt ?? ''}  ${summarizeText(commitment.closedReason ?? '')}`,
      );
    }
  });

  return { text: lines.join('\n'), ids };
}

function formatEntryFull(
  heading: string,
  entry: Record<string, unknown>,
  skip: readonly string[],
): string {
  const lines = [heading];
  for (const [key, value] of Object.entries(entry)) {
    if (skip.includes(key) || value === undefined) continue;
    if (typeof value === 'string') {
      const body = redactBody(value);
      if (!body.includes('\n')) {
        lines.push(`      ${key}: ${body}`);
        continue;
      }
      lines.push(`      ${key}:`, ...body.split('\n').map((line) => `        ${line}`));
    } else {
      lines.push(`      ${key}: ${redactBody(JSON.stringify(value) ?? String(value))}`);
    }
  }
  return lines.join('\n');
}

function summarize(entry: Record<string, unknown>): string {
  for (const key of ['text', 'decision', 'question', 'summary', 'body', 'tool']) {
    const value = entry[key];
    if (typeof value === 'string') return summarizeText(value);
  }
  // 上の6キーを持たない診断系は、Web と同じ文言を共有の口（`@alteroid/core/journal-diagnostics-format`）から借りる: 2箇所で複製しない。
  if (isJournalDiagnosticsEntry(entry)) return summarizeJournalDiagnosticsEntry(entry);
  // 観測者は申告であることを落とさない。
  if (entry.type === 'github_observation') return summarizeGithubObservation(entry);
  if (entry.type === 'conversation_deleted') {
    return summarizeText(
      `会話 ${String(entry.deletedConversationId)} を削除した（${String(entry.hiddenCount)} 件。${String(entry.deletedBy)}）`,
    );
  }
  return '';
}

function formatJournalEntryFull(entry: Record<string, unknown>): string {
  const lines = [`  ${String(entry.at)}  [${String(entry.type)}]`, `      id: ${String(entry.id)}`];
  for (const [key, value] of Object.entries(entry)) {
    if (key === 'at' || key === 'type' || key === 'id') continue;
    if (typeof value === 'string') {
      const body = redactBody(value);
      if (!body.includes('\n')) {
        lines.push(`      ${key}: ${body}`);
        continue;
      }
      lines.push(`      ${key}:`, ...body.split('\n').map((line) => `        ${line}`));
    } else {
      lines.push(`      ${key}: ${redactBody(JSON.stringify(value) ?? String(value))}`);
    }
  }
  return lines.join('\n');
}

function summarizeGithubObservation(entry: Record<string, unknown>): string {
  const result = entry.result as
    | {
        status?: string;
        openIssues?: number;
        openPulls?: number;
        ci?: Parameters<typeof describeGithubCi>[0]['ci'];
        ciUnavailable?: string;
        truncated?: boolean;
        reason?: string;
      }
    | undefined;
  const head = `${String(entry.repo)}（観測者 ${String(entry.observedBy)}）`;
  if (result?.status === 'ok') {
    return (
      `${head} open Issue ${String(result.openIssues)} 件 / open PR ${String(result.openPulls)} 件` +
      (result.truncated === true ? '（limit に達した。下限）' : '') +
      ` / ${describeGithubCi(result)}`
    );
  }
  if (result?.status === 'failed')
    return `${head} 取れなかった: ${summarizeText(result.reason ?? '')}`;
  return head;
}

// 欄の形までは検査しない: `GET /journal` はサーバ側で `journalEntrySchema` を通った行しか返さないので、`type` が一致すれば欄の形も一致する前提を置く。
function isJournalDiagnosticsEntry(
  entry: Record<string, unknown>,
): entry is JournalDiagnosticsEntryLike {
  return (
    typeof entry.type === 'string' &&
    (JOURNAL_DIAGNOSTICS_TYPES as readonly string[]).includes(entry.type)
  );
}

function summarizeText(value: string): string {
  // 伏せ字を先に掛ける: 切ってからだとトークンの途中で切れて形が崩れ、取りこぼす。
  const single = redactBody(value).replace(/\s+/g, ' ').trim();
  return single.length > 80 ? `${single.slice(0, codePointBoundary(single, 80))}…` : single;
}

export interface EditInProgress {
  readonly id: string;
  readonly conversationId: string;
}

// 配列から抜かない: 後ろの番号がずれ、同じ番号が別の発言を指す。全部を無効にもしない: 続けて別の発言を編集できなくなる。
// 並びを読み直すにはスキャン窓や `includeSuperseded` を覚えておく必要があり、通信の失敗も抱える。
// だから位置は保ったまま、その1つだけを空にして（`resolveListedId` は空を引けないものとして扱う）、読み直しを案内する。
export function retireListedMessage(listed: Listed, id: string): void {
  const index = listed.messages.indexOf(id);
  if (index >= 0) listed.messages[index] = '';
  delete listed.messageAttachments[id];
  delete listed.messageTexts[id];
  stdout.write(
    `（編集を受け付けました。${index >= 0 ? `[${String(index + 1)}] は` : 'その発言は'}置き換えた前の発言なので、もう指せません。新しい並びは /conversation で読み直してください）\n`,
  );
}

export const EDIT_EMPTY_MESSAGE =
  '本文も添付も無いので送っていません（本文を打つか、/attach で添付を足してください。やめるなら /edit-cancel）';

// 添えかけに別の添付が残っているときは始めない: 元の添付と混ざり、取り消しで巻き添えにする。
export function runEditDraftCommand(
  line: string,
  listed: Listed,
  draft: AttachmentDraft,
  editing: EditInProgress | null,
): { handled: false } | { handled: true; editing: EditInProgress | null } {
  if (/^\/edit-cancel(\s|$)/.test(line)) {
    if (editing === null) {
      stdout.write('編集は始めていません\n');
      return { handled: true, editing };
    }
    draft.clear();
    stdout.write('編集をやめました（何も送っていません。添えかけも空にしました）\n');
    return { handled: true, editing: null };
  }
  const match = /^\/edit(?:\s+([\s\S]*))?$/.exec(line);
  if (match === null) return { handled: false };
  const args = (match[1] ?? '').trim();
  if (args === '') return { handled: false };
  if (editing !== null) {
    stdout.write(
      '編集の途中です。本文を打って確定するか、/edit-cancel でやめてから、もう一度 /edit してください\n',
    );
    return { handled: true, editing };
  }
  if (/\s/.test(args)) return { handled: false }; // 1行の形
  const id = resolveListedId(args, listed.messages);
  if (id === null) {
    stdout.write(
      `[${args}] は直前の /conversation の一覧にありません` +
        '（番号は、その会話でまだ畳まれていない自分の発言だけに振られています）\n',
    );
    return { handled: true, editing };
  }
  const owning = listed.messagesConversationId;
  if (owning === null) {
    stdout.write('先に /conversation <番号|id> でその発言が含まれる会話を開いてください\n');
    return { handled: true, editing };
  }
  if (draft.count > 0) {
    stdout.write(
      '添えかけのファイルが残っています。先に送るか、/detach all で外してから /edit してください\n',
    );
    return { handled: true, editing };
  }
  const original = listed.messageAttachments[id] ?? [];
  for (const attachment of original) draft.addUploaded(attachment);
  const text = listed.messageTexts[id];
  stdout.write(
    `編集を始めます（${args}）\n` +
      `  元の本文: ${text === undefined ? '（直前の /conversation の一覧に無いので出せません）' : redactBody(text)}\n`,
  );
  for (const item of attachmentLinesOf(original)) stdout.write(`  ${redactBody(item)}\n`);
  stdout.write(
    '本文を打って Enter で、置き換えた新しい版を送ります（添付が残っていれば空行の Enter で本文を空にして送れます）。\n' +
      '/detach <番号|all> で添付を外す・/attach <path> で足す（足した分は新しく上げます）・/edit-cancel でやめる\n',
  );
  return { handled: true, editing: { id, conversationId: owning } };
}

export async function runAttachmentCommand(
  line: string,
  draft: AttachmentDraft,
  onFailed?: (reason: string) => void,
): Promise<void> {
  const match = /^\/(\w+)\s*([\s\S]*)$/.exec(line.trim());
  const command = match?.[1] ?? '';
  const args = (match?.[2] ?? '').trim();
  if (command === 'attach') {
    if (args === '') {
      stdout.write('使い方: /attach <path>\n');
      onFailed?.('使い方の誤り（/attach <path>）');
      return;
    }
    const added = await draft.add(interpretAttachPath(args));
    if (!added.ok) {
      stdout.write(`添えられません: ${added.reason}\n`);
      onFailed?.(`添えられません: ${added.reason}`);
      return;
    }
    stdout.write(
      `添えかけ ${draft.count} 件（${added.file.name}）。本文を打って送ると一緒に上がります（空行の Enter なら添付だけを送る）\n`,
    );
    return;
  }
  if (command === 'attachments') {
    for (const text of draft.describe()) stdout.write(`${text}\n`);
    return;
  }
  if (args === '') {
    stdout.write('使い方: /detach <番号|all>\n');
    onFailed?.('使い方の誤り（/detach <番号|all>）');
    return;
  }
  const removed = draft.remove(args);
  if (!removed.ok) onFailed?.(`外せません: ${removed.reason}`);
  stdout.write(
    removed.ok
      ? `外した: ${removed.removed.map((f) => f.name).join(', ')}（残り ${draft.count} 件）\n`
      : `外せません: ${removed.reason}\n`,
  );
}

// Web の予定の画面・webhook と同じ解釈にする: 入口ごとに解釈が違うと、同じ `{"a":1}` でもクローンが読む本文と重複判定の鍵が入口で変わる。
export function parseEventPayload(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return body;
  }
}

export function rawTail(line: string, skip: number): string {
  let rest = line.trimStart();
  for (let i = 0; i < skip; i += 1) rest = rest.replace(/^\S+\s*/, '');
  return rest.trimEnd();
}
