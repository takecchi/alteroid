// マネージャーへの委譲（manager_start / manager_send / manager_stop / manager_list / manager_report）の道具。
// `tools.ts` から呼ぶ（`createCloneTools` が並びのまま連結する）。このファイルから `tools.ts` を import しない（一方向）。

import { z } from 'zod';
import { describeArchiveRemovedBytesUnit } from './archive-removed-bytes.js';
import { readAttachmentLimits } from './attachment.js';
import {
  attachmentRefsOf,
  loadManagerAttachments,
  ManagerAttachmentsRefusedError,
} from './manager-attachments.js';
import { taskStatusForJob } from './task.js';
import { describePidsSaturation } from './runner-protocol.js';
import { describeManagerState, describeUnobservedOutcome } from './digest.js';
import { reasonOf } from './dropped-record.js';
import { describePage, excerptLine, page } from './excerpt.js';
import { describeReportDrift } from './manager-activity.js';
import {
  decisionUnusedNote,
  type ManagerPool,
  type ManagerSendResult,
  type ManagerSummary,
  type ManagerTranscript,
} from './manager.js';
import { tokenGenerationMismatched } from './manager-summary.js';
import type { ManagerUnpushedWork } from './unpushed-work-observation.js';
import { stripNul } from './nul-guard.js';
import { type Task } from './schema.js';
import { UnreadableTaskError, describeUnreadableManagerRow, type Stores } from './store.js';
import { RESTART_BEFORE_CHECK_ADVICE } from './usage-limits.js';
import { describeManagerModels, managerModelsOf } from './manager-models.js';
import { isEmptyCompleteUnpushedWorkObservation } from './unpushed-work-observation-format.js';
import {
  describeIntRangeViolation,
  describeStringLengthViolation,
  formatIntRangeJa,
  formatStringLengthJa,
} from './tool-arg-checks.js';
import {
  text,
  TRANSCRIPT_PAGE,
  tool,
  NO_POOL,
  appendJournalOrThrow,
  appendJournalOrDrop,
  type ToolText,
  JOURNAL_TEXT_EXCERPT,
  foldFixedFor,
  isSubagentCaller,
} from './clone-tools-common.js';
import type { ToolContext, CloneToolsShared } from './clone-tools-context.js';
import { CLOSES_SCHEMA, describeClosesViolation, finishWithCloses } from './clone-tools-closes.js';
import { managerListTool } from './clone-tools-manager-list.js';
import {
  describeDenials,
  describeManagerCgroupEvents,
  describeManagerFailure,
  describeManagerSystemError,
  describeRunnerVanished,
  describeUnpushedWorkObservation,
  describeUsageStopped,
  isFoldedTurnReport,
} from './clone-tools-manager-describe.js';

const MANAGER_ATTACHMENTS_DESCRIPTION =
  '人間の添付を担い手にも見せたいときに、その添付の id（通知行の id=… / conversation_read の添付行）を渡す。' +
  '渡したものは担い手の手元にファイルとして置かれ（通知行にパスが付くので Read で開ける）、画像は画像としても見える。' +
  '渡さない添付は担い手には見えない。**記憶には写らない**（日誌に残るのは渡した添付の参照だけで、中身は残らない）。' +
  '見つからない添付（保持期限切れ・id の誤り）があれば、何も送らずにエラーを返す。個数・合計には人間の発言と同じ上限がある。' +
  '確認への回答（requestId / decision）には載せられない。';

// `LIST_REPORT_EXCERPT` を使い回さない: 用途ごとに別に置く
const MANAGER_STOP_FOLDED_TURN_EXCERPT = 240;

const REPORT_PAGE = 8_000;

// 全行を JSON.parse しない: 生ログは MB 級になりうるため末尾からこの文字数だけ見る
const REPORT_GENERATED_PROBE_CHARS = 200_000;

interface LastAssistantUtterance {
  timestamp: string | undefined;
  length: number;
  // 本文があっても終わったとは限らない: 道具を挟む前の語りも `type: 'text'` で、`stop_reason` は `tool_use` になる
  stopReason: string | undefined;
}

type AssistantUtteranceProbe =
  { kind: 'found'; utterance: LastAssistantUtterance } | { kind: 'empty' } | { kind: 'truncated' };

// 判定はしない: 見つけたことと、そのターンが終わっていることは別の軸のため `stopReason` を添えて返す
function probeLastAssistantUtterance(transcript: string): AssistantUtteranceProbe {
  const truncated = transcript.length > REPORT_GENERATED_PROBE_CHARS;
  const tail = truncated ? transcript.slice(-REPORT_GENERATED_PROBE_CHARS) : transcript;
  const rawLines = tail.split('\n');
  const lines = truncated ? rawLines.slice(1) : rawLines;

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!.trim();
    if (line.length === 0) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const record = entry as {
      type?: unknown;
      isSidechain?: unknown;
      timestamp?: unknown;
      message?: { content?: unknown; stop_reason?: unknown };
    };
    if (record.type !== 'assistant') continue;
    if (record.isSidechain === true) continue;
    const body = rawAssistantText(record.message?.content);
    if (body.length === 0) continue;
    return {
      kind: 'found',
      utterance: {
        timestamp: typeof record.timestamp === 'string' ? record.timestamp : undefined,
        length: body.length,
        stopReason:
          typeof record.message?.stop_reason === 'string' ? record.message.stop_reason : undefined,
      },
    };
  }
  return truncated ? { kind: 'truncated' } : { kind: 'empty' };
}

function rawAssistantText(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .filter(
      (block): block is { type: 'text'; text: string } =>
        typeof block === 'object' &&
        block !== null &&
        (block as { type?: unknown }).type === 'text' &&
        typeof (block as { text?: unknown }).text === 'string',
    )
    .map((block) => block.text)
    .join('\n')
    .trim();
}

// 読めなかったことを「無い」に潰さない
async function describeMissingReport(
  managers: ManagerPool,
  managerId: string,
  status: ManagerSummary['status'],
): Promise<string> {
  const base = `マネージャー ${managerId} からの報告はまだ無い（状態: ${status}）。`;
  let result: ManagerTranscript;
  // 末尾を読む口があれば使う: 判定は末尾の REPORT_GENERATED_PROBE_CHARS 文字しか見ず、全文（退避なら数十〜百 MB 級）をデーモンのループの上で文字へ戻すと1回で約1秒止まりうるため（#4638）
  const tailRead = managers.transcriptTail !== undefined;
  try {
    result =
      managers.transcriptTail !== undefined
        ? await managers.transcriptTail(managerId, REPORT_GENERATED_PROBE_CHARS)
        : await managers.transcript(managerId);
  } catch (error) {
    return (
      `${base} 生ログは読めなかった（` +
      reasonOf(error) +
      '）。「まだ書いていない」か「書いたのに届いていない」かは、これだけでは判定できない。'
    );
  }
  if (result.kind === 'removed') {
    // `missing` に畳まない: 退避はあったが本文が落とされており、「まだ書いていない」とも「読めなかった」とも別の状態のため
    return (
      `${base} 生ログは退避されていたが本文が消されている` +
      `（${result.removedAt} に ${result.bytes.toLocaleString('ja-JP')} バイトを落とした${describeArchiveRemovedBytesUnit()}。` +
      `archive id: ${result.archiveId}）。現物は確かめられない。`
    );
  }
  if (result.kind === 'unreadable') {
    return `${base} 生ログは読みに行けなかった。${result.detail}`;
  }
  if (result.kind === 'missing' || result.body.length === 0) {
    return (
      `${base} 生ログにも本文は無い` +
      '（走行中の runner のディスク・退避済みアーカイブ・預かった生ログ、3段のどこにも見当たらなかった）。'
    );
  }
  const transcript = result.body;

  const outcome = probeLastAssistantUtterance(transcript);
  if (outcome.kind === 'empty') {
    return `${base} 生ログにも本文は無い（生ログ全体を見た）。`;
  }
  if (outcome.kind === 'truncated') {
    return (
      `${base} 生ログの末尾 ${REPORT_GENERATED_PROBE_CHARS.toLocaleString('ja-JP')} 文字を遡ったが、` +
      'マネージャー自身の発言（本文つき）は見つからなかった。' +
      'それより前は見ていないので「無い」とは言い切れない——' +
      `manager_transcript managerId=${managerId} で自分で遡って確かめられる。`
    );
  }

  const { timestamp, length, stopReason } = outcome.utterance;
  const when = timestamp ?? '時刻不明（生ログの行に timestamp が無かった）';
  const state = `（状態: ${status}）`;
  const found = `生ログには ${when} に本文が在る（約 ${length.toLocaleString('ja-JP')} 文字）`;
  // 末尾だけを読んだ回は全体の長さが分からないので、読み始めを offset ではなく発言の時刻（since）で案内する
  const where = tailRead
    ? timestamp === undefined
      ? 'で読める（末尾だけを見たので、読み始めの位置は示せない）'
      : ` since=${timestamp} で、その発言から読める`
    : ` offset=${Math.max(0, transcript.length - TRANSCRIPT_PAGE)} で読める`;
  const howToDigIn =
    `manager_transcript managerId=${managerId}${where}` +
    '（作業者の発言は除いて探したが、混ざる余地が完全に無いとまでは確認していない）。';

  // 3つに割る: 「終わっていないと分かった」と「分からなかった」を1つに畳まない
  if (stopReason === 'end_turn') {
    return (
      `⚠ マネージャー ${managerId} からの報告としては届いていない${state}が、${found}。` +
      `＝ 生成されたが配られていない（#323）。${howToDigIn}`
    );
  }
  if (stopReason !== undefined) {
    return (
      `マネージャー ${managerId} からの報告はまだ無い${state}。${found}が、そのターンはまだ終わっていない` +
      `（stop_reason=${stopReason}）。＝ まだ書き終えていない側である。${howToDigIn}`
    );
  }
  return (
    `マネージャー ${managerId} からの報告はまだ無い${state}。${found}が、そのターンが終わっているかを判定できなかった` +
    `（行に stop_reason が無い）。${howToDigIn}`
  );
}

// daemon の `app-routes-managers.ts` の人間の直接送信の行（`excerptLine(text, 200)`）に合わせる
const MANAGER_ANSWER_MESSAGE_EXCERPT = 200;

// 頼んだ値を実際の値として名乗らない
function describeStartedCwd(
  manager: Pick<ManagerSummary, 'cwd' | 'cwdConfirmed' | 'requestedCwd'>,
): string {
  if (manager.cwdConfirmed !== true) {
    return `実際の cwd は未確認（頼んだ値: ${manager.cwd}）`;
  }
  if (manager.requestedCwd !== undefined) {
    return `頼んだ cwd（${manager.requestedCwd}）はこの器に無かったので、${manager.cwd} で開いた`;
  }
  return `cwd: ${manager.cwd}`;
}

// `tasks`（背景タスクの在り高）と混ぜない: 別の軸のため
// `count` が 0 でも出す: 「取れない」ではなく「0 と測れた」ため
function describeWithheldReports(manager: ManagerSummary): string | null {
  if (manager.awaitingBackground === undefined) return null;
  return (
    `配っていない報告 ${manager.awaitingBackground.withheldReports} 本` +
    '（中身は日誌の decision に在る）。'
  );
}

function unpushedWorkReportNote(
  manager: ManagerSummary,
  rescueAll: boolean = false,
): string | null {
  const note = describeUnpushedWorkObservation(manager, rescueAll ? 'full' : 'report');
  return note === null ? null : note.trimStart();
}

// 短めに切る: `manager_stop` 自体の応答が長々と待たされるほうが実害で、`pool.unpushedWork()` は失敗しても構わない設計のため
const MANAGER_STOP_UNPUSHED_WORK_TIMEOUT_MS = 5_000;

// ファイル名・差分の中身・コミットメッセージ・author を文言に含めない
function describeUnpushedWork(probe: ManagerUnpushedWork): string {
  if (probe.kind === 'unavailable') {
    return `未 push の実装・未コミットの変更: **確かめられなかった**（${probe.reason}）。`;
  }
  const { result } = probe;
  if (result.worktrees.length === 0) {
    // 「見つからなかった」と言い切らない: 探せなかっただけで未 push の実装が残っている可能性があるため
    const uncertain: string[] = [];
    if (result.scratchRootsUnknown !== undefined) {
      uncertain.push(
        '他マネージャー/作業者の /tmp スクラッチディレクトリの有無は確かめられなかった' +
          `（${result.scratchRootsUnknown}）`,
      );
    }
    if (result.unreadableDirCount !== undefined) {
      uncertain.push(
        `${result.cwd} の下の子ディレクトリの読み取りに${String(result.unreadableDirCount)}回失敗した` +
          '（/tmp スクラッチの起点そのものの読み失敗を含む）' +
          '——その下に未 push の実装が残っていた可能性がある',
      );
    }
    return uncertain.length === 0
      ? `未 push の実装・未コミットの変更: 作業ツリーが見つからなかった（${result.cwd} の下を探索した）。`
      : `未 push の実装・未コミットの変更: ${result.cwd} の下には作業ツリーが見つからなかったが、` +
          `${uncertain.join('、')}。**確認できていない。**`;
  }
  const lines = result.worktrees.map((worktree) => {
    const branch = worktree.branch ?? '(枝を指していない、または確かめられなかった)';
    const unpushed =
      worktree.unpushedCommitCount === undefined
        ? `未 push: 確かめられなかった（${worktree.unpushedCommitCountUnknown ?? '理由不明'}）`
        : `未 push ${String(worktree.unpushedCommitCount)}本`;
    const uncommitted =
      worktree.uncommittedChangeCount === undefined
        ? `未コミット: 確かめられなかった（${worktree.uncommittedChangeCountUnknown ?? '理由不明'}）`
        : `未コミット ${String(worktree.uncommittedChangeCount)}件`;
    return `  - ${worktree.relativePath}（枝: ${branch}）: ${unpushed} / ${uncommitted}`;
  });
  const truncatedNote =
    result.truncatedAtCount === undefined
      ? ''
      : `\n  ⚠️ 作業ツリーの探索は${String(result.truncatedAtCount)}件で打ち切った——さらに在る可能性がある。`;
  const stoppedEarlyNote =
    result.stoppedEarly === true
      ? '\n  ⚠️ 呼び出し元の期限切れで、一部の作業ツリーは調べる前に打ち切った（各行の理由を見よ）。'
      : '';
  const scratchRootsUnknownNote =
    result.scratchRootsUnknown === undefined
      ? ''
      : `\n  ⚠️ 他マネージャー/作業者の /tmp スクラッチディレクトリの有無を確かめられなかった` +
        `（${result.scratchRootsUnknown}）——そこに未 push の実装が残っている可能性があり、` +
        '上の一覧には含まれていない。';
  const unreadableDirNote =
    result.unreadableDirCount === undefined
      ? ''
      : `\n  ⚠️ ${result.cwd} の下で子ディレクトリの読み取りに${String(result.unreadableDirCount)}件` +
        '失敗した（/tmp スクラッチの起点そのものの読み失敗を含む）——そこに未 push の実装が残っている可能性があり、上の一覧には含まれていない。';
  return (
    `未 push の実装・未コミットの変更（${result.cwd} の下、${String(result.worktrees.length)}本の作業ツリー）:\n` +
    lines.join('\n') +
    truncatedNote +
    stoppedEarlyNote +
    scratchRootsUnknownNote +
    unreadableDirNote +
    '\n  ⚠️ 未 push の数は fetch していない remote-tracking ref を基準にしており、' +
    '実際には push 済みでも多めに出ることがある（安全側の誤り）。'
  );
}

/** 委譲が結び付いた task（`Job.taskId`）。読めない・見つからない・結び付いていないときは `undefined`（その回は委譲に数えない。走っている委譲は、閉じる直前に別に台帳を引いて見る）。 */
async function jobTaskIdOf(stores: Stores, managerId: string): Promise<string | undefined> {
  try {
    return (await stores.jobs.listJobs()).find((job) => job.id === managerId)?.taskId;
  } catch {
    return undefined;
  }
}

export function managerTools(context: ToolContext, shared: CloneToolsShared) {
  const { stores, getWorkConversationId } = shared;
  return [
    tool(
      'manager_start',
      [
        'マネージャー（あなたが起こす Claude Code）に仕事を任せる。',
        '起動して即返るので、完了を待たずに次の判断へ移ってよい。同時に何本走らせてもよい。',
        '依頼できるのは実装だけではない。調査・設計の相談・外部サービスの確認・レビューも同じように頼める。',
        'Codex に作業を頼めるマネージャーの器があれば（runner_list の peer の行）、依頼文に「Codex にやらせて」と' +
          '書けば、マネージャーが peer で Codex に頼む。その器を runnerId で名指しできる。',
        '置き先は資源で自動配置される（runner_list の説明を参照）。新しいプロセスを起こせない' +
          '（pids 飽和）と判定された器は、飽和していない器が居れば自動配置から外れる。' +
          '全台が飽和でも、runnerId で名指ししても断らず起こす——置き先が飽和と判定されていれば' +
          '応答に「⚠ 置き先の runner は pids 飽和と判定されている: 材料」の行が付くので、' +
          '落ちる前提で読むこと。',
        'failed / lost の前任の後継を立てるときは supersedes に前任の managerId を渡すこと。' +
          '渡さないと、鍵の回転で前任が起き上がって二重になりうる。' +
          '前任が終わっていない（running / waiting_human / 生きている done）と断られる——先に manager_stop で止めること。',
      ].join(' '),
      {
        request: z
          .string()
          .describe(
            `依頼内容。人間が Claude Code に書くのと同じ粒度で、背景と狙いを添えて書く（${formatStringLengthJa({ min: 1 })}。空白だけは断る）`,
          ),
        cwd: z.string().optional().describe('作業ディレクトリ。省略時はデーモンの既定'),
        attachments: z
          .array(z.string().min(1))
          .optional()
          .describe(MANAGER_ATTACHMENTS_DESCRIPTION),
        runnerId: z
          .string()
          .optional()
          .describe(
            '置き先の器を名指しで指名する（runner_list / manager_list が出す runnerId）。' +
              'これは配置の指名であって本数の制限ではない——省略すれば資源による自動配置。' +
              '指名した器が名簿に無い・使えない・名前が重複のときは失敗し、他の器へは' +
              '自動で落とさない（返ってきた文言をそのまま読むこと）。',
          ),
        supersedes: z
          .string()
          .optional()
          .describe(
            '前任の managerId（manager_list に出ている id）。failed / lost の前任の後継を立てるときに渡す。' +
              '前任の枠で止まった印を下ろし、自動の起こし直しの対象から外す。' +
              '前任が終わっていなければ断られる（先に manager_stop で止めること）。',
          ),
        taskId: z
          .string()
          .optional()
          .describe(
            'この委譲を結び付ける task の id（task_list）。渡すと task は待ちになり、委譲が終わる・失敗する・lost になると' +
              '判断待ち（needs_decision）に戻って、報告にもこの id が付く。閉じた task と、走っている委譲が既にある task は断られる（1つの task に走らせる委譲は同時に1本まで）。' +
              '人間の依頼の task のために委譲するときは渡すこと。渡さないと task に結び付かず、起点の会話へ返答した時点で、器が task を自動で done にする。',
          ),
      },
      async (rawArgs) => {
        const { request, cwd, runnerId, attachments, supersedes, taskId } = rawArgs as unknown as {
          request: string;
          supersedes?: string | undefined;
          cwd?: string | undefined;
          attachments?: string[] | undefined;
          runnerId?: string | undefined;
          taskId?: string | undefined;
        };
        if (!context.managers) return NO_POOL;
        // 空の依頼を断る: 日誌に「起こそうとしている」と書き、runner へ何もしない依頼を渡して1本ぶんの器を使うことになるため
        const requestError = describeStringLengthViolation('request', stripNul(request), {
          min: 1,
        });
        if (requestError !== null) return text(`${requestError}起こしていない。`);
        if (stripNul(request).trim().length === 0) {
          return text('request が空白だけなので起こしていない。任せたい仕事を書いて渡すこと。');
        }
        // task は日誌にも委譲にも触れる前に確かめる: 結び付かない委譲を黙って走らせると、終わっても task が動かず、渡したつもりのクローンが気づけないため
        if (taskId !== undefined) {
          let linked: Task | null;
          try {
            linked = await stores.tasks.get(taskId);
          } catch (error) {
            if (error instanceof UnreadableTaskError) {
              return text(
                `task ${taskId} は読めない形で入っている。マネージャーは起こしていない。`,
              );
            }
            throw error;
          }
          if (linked === null) {
            return text(
              `task ${taskId} は無い（task_list で実在する id を確かめること）。マネージャーは起こしていない。`,
            );
          }
          if (linked.status === 'done' || linked.status === 'cancelled') {
            return text(
              `task ${taskId} は閉じている（${linked.status}）。続きを頼むなら先に task_set_status で queued へ戻すこと。マネージャーは起こしていない。`,
            );
          }
          // 1つの task に同時に走る委譲は1本まで: 2本目が先に終わると、1本目が走っているのに task が判断待ちへ倒れる
          const running = (await stores.jobs.listJobs()).filter(
            (job) => job.taskId === taskId && taskStatusForJob(job.status) === 'waiting',
          );
          if (running.length > 0) {
            return text(
              `task ${taskId} には走っている委譲がある（${running.map((job) => `${job.id}: ${job.status}`).join('、')}）。` +
                '1つの task に同時に走らせる委譲は1本までなので、マネージャーは起こしていない。' +
                'その委譲が終わるのを待つか、manager_stop で止めてから頼むこと。' +
                '止められない（器が消えて running のまま残っている等）ときは、taskId を付けずに起こすか、task_set_status で task を動かすこと。',
            );
          }
        }
        // conversationId はクローンに渡させず呼び出し文脈から自動で読む: 手で維持する欄を新しく作らないため
        // 返信の宛先ではなく仕事の会話を読む: 報告を受けた内部ターンで続きを委譲したとき、起点が途切れないため
        const conversationId = getWorkConversationId();

        // 添付は日誌にも命令にも触れる前に読む: 見つからなければ何も送らず日誌も書かないため
        const handover = await loadManagerAttachments(
          stores,
          attachments ?? [],
          context.attachmentLimits ?? readAttachmentLimits().limits,
        );
        if (!handover.ok) return text(handover.message);
        const handedRefs = attachmentRefsOf(handover.attachments);
        const handedNote =
          handedRefs.length === 0
            ? ''
            : `（添付 ${handedRefs.length} 件を渡す: ${handedRefs.map((ref) => `${ref.id} ${ref.name}`).join(', ')}）`;

        // 日誌を先に書く: 書けなければ起こさずに道具のエラーで返すため
        await appendJournalOrThrow(
          'manager_start',
          stores.journal,
          {
            type: 'decision',
            decision: `マネージャーを起こそうとしている${
              runnerId === undefined ? '' : `（指名: runnerId=${runnerId}）`
            }${handedNote}: ${request}`,
            grounds: '委譲の判断',
          },
          'act-not-performed',
        );

        let started: ManagerSummary;
        try {
          started = await context.managers.start({
            request,
            ...(cwd === undefined ? {} : { cwd }),
            ...(runnerId === undefined ? {} : { runnerId }),
            ...(supersedes === undefined ? {} : { supersedes }),
            ...(conversationId === undefined ? {} : { conversationId }),
            ...(taskId === undefined ? {} : { taskId }),
            ...(handover.attachments.length === 0 ? {} : { attachments: handover.attachments }),
          });
        } catch (error) {
          await appendJournalOrDrop('manager_start', stores.journal, {
            type: 'decision',
            decision: `マネージャーを起こせなかった${
              runnerId === undefined ? '' : `（指名: runnerId=${runnerId}）`
            }${handedNote}: ${request}`,
            grounds: `委譲しようとしたが、状態の変更が失敗した: ${reasonOf(error)}`,
          });
          if (error instanceof ManagerAttachmentsRefusedError) {
            return text(`${reasonOf(error)}。マネージャーは起こしていない。`);
          }
          throw error;
        }

        // 日誌より先に控える: 日誌の追記が落ちても、起こした事実は変わらない（自動 done がこの委譲を見落とさない）
        context.noteDelegationStarted?.(taskId);
        await appendJournalOrDrop('manager_start', stores.journal, {
          type: 'decision',
          decision:
            `マネージャー ${started.managerId} を起こした（${describeStartedCwd(started)}` +
            `${runnerId === undefined ? '' : `, 指名: runnerId=${runnerId}`}）${handedNote}: ${request}`,
          grounds: '委譲の判断',
        });
        // pids 飽和の置き先でも断らない: 起こしたうえで、材料つきで知らせる
        const saturation =
          started.runnerId === undefined
            ? undefined
            : context.managers.runnerPidsSaturation?.(started.runnerId);
        return text(
          `マネージャー ${started.managerId} を起こした（${describeStartedCwd(started)}、` +
            `runner: ${started.runnerId ?? '未記録'}）。` +
            '報告・質問は後から受信箱に届く。' +
            (saturation === undefined
              ? ''
              : `\n⚠ 置き先の runner は pids 飽和と判定されている: ${describePidsSaturation(saturation)}。` +
                'この委譲は新しいプロセスを起こせず落ちるかもしれない——' +
                'runner_list で他の器を見て、必要なら止めて別の器へ置き直すこと。'),
        );
      },
    ),

    tool(
      'manager_send',
      [
        '走行中のマネージャーへ追加指示を送る、または止まっている質問・許可確認に答える。',
        'requestId か decision を付けたときだけ回答として扱う（止まっていたその仕事だけが再開する）。',
        'どちらも無い本文は、相手が返事待ちでも回答にはならず追加指示として届く。',
        '許可確認への回答では decision を必ず付けること。',
        // 答える先の無い合図に decision を付けさせない: requestId 無しの decision は待ちが1件ならその1件へ当たり、無関係の確認を許可してしまうため
        // 答え方の細則（allow のあとの撃ち直し・一時規則・伝える文言）はここに書かない: 確認の本文が言うため（`classifier-denial-streak.ts` の `DENIAL_ASK_AFTER_ANSWER_PARAGRAPH*`、`manager.ts` の `DENIAL_REPLY_ROUTE`）。ここに残すのは、本文に無い規則と、どの本文を読むかの指し先だけ
        '許可確認は2種類（分類器の拒否の確認は requestId が toolu_… の形、それ以外は UUID の形）で、答えたあとが違う。' +
          '答え方の細則は、届いた確認の本文が言う。' +
          'allow のあとに撃ち直し方を伝えるときは、decision を付けない追加指示で送ること。',
        '確認として届かない拒否の合図（拒否の報告だけが届いた回）には requestId が無く、許可として答える口は無い。' +
          'requestId 無しの decision は付けないこと（待っている別の確認へ当たりうる）。答え方は報告の本文が言う。',
        'manager_list が [running] と出していても、runner の側でセッションが畳まれていることがある' +
          '（その合図が届かなかった窓）。そのときは resume から入り直して届けるので、' +
          '返り値にそう書いてある。入り直せなかったときも「そんな id は無い」ではなく' +
          '「セッションが無い」と返る——委譲そのものは台帳に在るので、manager_start で' +
          '起こし直す前に、返ってきた文言をそのまま読むこと。',
        // 「セッションが無い」を「仕事が失われた」と読ませない: 完遂後に畳まれた回も同じ形に見え、決めつけると完遂済みの仕事を委譲し直すため
        // 「届けた」の保証の範囲はここに1回だけ詳しく書く: 返り値は送るたびに文脈へ積まれるので短くしてある
        '返り値の「届けた」が保証するのは、runner の resume の口を叩いて成功が返ったところまでで、' +
          '相手がこの本文を読んだかは見ていない。黙った器に載っている委譲へも送信は実際に届くので、' +
          '直後の manager_list が lost／セッション切断のままでも「届かなかった」とは読まず、' +
          '同じ本文で新しい委譲を立てないこと（同じ仕事が2本になる）。',
        'セッションが無いことは、その仕事が失われたことを意味しない——完遂した後に' +
          'セッションが畳まれ、終端イベントだけが届かなかった回も同じ形になる。' +
          '委譲し直す前に必ず manager_report を見ること（報告が空でも、生ログから' +
          '「生成されたが配られていない」報告を拾える）。',
      ].join(' '),
      {
        managerId: z.string().describe('manager_start が返した id'),
        message: z
          .string()
          .describe('マネージャーへの本文。deny のときは、なぜ駄目でどうしてほしいかを書く'),
        attachments: z
          .array(z.string().min(1))
          .optional()
          .describe(MANAGER_ATTACHMENTS_DESCRIPTION),
        // `deny` を機械的に流さない: 受け取るマネージャーは「人間が拒否した」としか読めず、人間の承認の偽造になるため
        decision: z
          .enum(['allow', 'deny'])
          .optional()
          .describe('許可確認への回答のとき必須。それ以外では不要'),
        // 生ログの id では通らない: 名前空間の違う id は「待っていない」に落ち、「まだ届いていない」と見分けが付かないため
        requestId: z
          .string()
          .optional()
          .describe(
            'どの確認への回答かを示す id（受信箱に届いた requestId）。' +
              '1本のマネージャーが複数を同時に待つことがあるので、回答では必ず添えること。' +
              '⚠️ 通るのは受信箱に確認として届いた requestId だけである。分類器の拒否の確認では toolu_… の形のことがあるが、' +
              '生ログから拾った toolu_…（tool_use_id）や req_…（API の request id）は、確認として届いていなければ通らない。' +
              '受信箱に届いていない確認に、生ログから答える手段は無い',
          ),
        closes: CLOSES_SCHEMA,
      },
      async ({ managerId, message, decision, requestId, attachments, closes }, extra: unknown) => {
        // 閉じる指定の誤りは、送る前に丸ごと断る（送ってから閉じる側だけ断ると、半分だけ済んだ呼びになるため）
        const closesError = describeClosesViolation(closes);
        if (closesError !== null) return text(closesError);
        // 送れなかった（早い断り・保留・失敗）呼びは1行も閉じず、そう書く
        const notDone = (res: ToolText) =>
          finishWithCloses(stores, res, closes, false, 'manager_send');
        if (!context.managers) return notDone(NO_POOL);
        // 空白だけは断らない: HTTP も通すため
        const messageError = describeStringLengthViolation('message', message, { min: 1 });
        if (messageError !== null) return notDone(text(messageError));
        const handover = await loadManagerAttachments(
          stores,
          attachments ?? [],
          context.attachmentLimits ?? readAttachmentLimits().limits,
        );
        if (!handover.ok) return notDone(text(handover.message));
        // 答える前に判断の行を書く: 答えが届いたのに跡が無い窓を作らないため。
        // この道具は自己記録なので PostToolUse の行が無く、この行が「クローンが人間に聞かず答えた」唯一の跡になる。
        // 行を書いたかを旗で持つ: 確認に当たらなかった送信では呼ばれず、書いていない行は打ち消さない
        // 閉包から代入するので、`let` ではなく箱にする（`let` だと代入後も `undefined` へ絞られる）
        const answerJournaled: { requestId?: string } = {};
        // 先に書いた行が効かなかったとき（答えが届かなかった）の打ち消し。書けなければ跡だけ残す
        const retractAnswerJournal = async (detail: string): Promise<void> => {
          if (answerJournaled.requestId === undefined) return;
          await appendJournalOrDrop('manager_send', stores.journal, {
            type: 'decision',
            decision:
              `クローンが担当 ${managerId} の確認（${answerJournaled.requestId}）へ答えるとした直前の回答の行は` +
              `効いていない（答えは届いていない）。理由: ${excerptLine(detail, MANAGER_ANSWER_MESSAGE_EXCERPT)}`,
            grounds: '先に書いた回答の行の後で、答えが届かなかったため打ち消す',
          });
        };
        const send = async (pool: ManagerPool): Promise<ManagerSendResult> => {
          try {
            return await pool.send(managerId, message, {
              ...(decision === undefined ? {} : { decision }),
              ...(requestId === undefined ? {} : { requestId }),
              ...(handover.attachments.length === 0 ? {} : { attachments: handover.attachments }),
              beforeAnswer: async (pending) => {
                await appendJournalOrThrow(
                  'manager_send',
                  stores.journal,
                  {
                    type: 'decision',
                    decision:
                      `クローンが担当 ${managerId} の確認（${pending.requestId}: ` +
                      `${excerptLine(pending.summary, JOURNAL_TEXT_EXCERPT)}）に自分で答える` +
                      `（decision=${decision ?? '指定なし（runner が本文から読む）'}。` +
                      `抜粋: ${excerptLine(message, MANAGER_ANSWER_MESSAGE_EXCERPT)}）`,
                    grounds:
                      'クローン自身が manager_send で、人間に聞かずに答えた（根拠は記憶。人間はこれを読んで後から否定する）',
                  },
                  'act-not-performed',
                );
                answerJournaled.requestId = pending.requestId;
              },
            });
          } catch (error) {
            await retractAnswerJournal(`送信が例外で終わった: ${reasonOf(error)}`);
            throw error;
          }
        };
        const result = await send(context.managers);
        if (result.outcome !== 'answered') await retractAnswerJournal(result.detail);
        // 届いた（delivered）か答えた（answered）ときだけ閉じる。それ以外は本来の作業が通っていない
        const sent = result.outcome === 'delivered' || result.outcome === 'answered';
        // 既存の委譲へ頼んだターンも、委譲に数える（その委譲に結び付いた task〔Job.taskId〕を、このターンの返答で自動 done にしない。#5469 P5）
        if (sent) context.noteDelegationStarted?.(await jobTaskIdOf(stores, managerId));
        // `session_missing` は必ず言い足す: そのものは居る側なので、`manager_start` で起こし直すと同じ仕事が2本になりうるため
        if (result.outcome === 'session_missing') {
          return notDone(
            text(
              `[${managerId}] ${result.detail}\n` +
                '**この委譲そのものは台帳に在る**（「そんな id は無い」ではない）。' +
                'runner に生きたセッションが無く、resume でも入り直せなかっただけである。' +
                'manager_list で状態を確かめ、時間で解ける理由（引き取り中・貸し出し期限）' +
                'なら少し置いてから送り直すこと。' +
                RESTART_BEFORE_CHECK_ADVICE,
            ),
          );
        }
        // 警告の文は HTTP（POST /managers/:id/messages）と共有する（`decisionUnusedNote`）
        const unusedNote = decisionUnusedNote(decision, requestId, result.outcome);
        if (result.outcome === 'held') return notDone(text(`${result.detail}${unusedNote}`));
        // 「届けた」が保証する範囲を名乗る: 観測したのは resume の口が成功を返したところまでで、相手がこの本文を読んだかは見ていないため
        // 「同じ本文で立て直さないこと」は落とさない: 送った直後の `manager_list` が `lost` のままで、クローンが指示を失ったと判断し出し直した実害があるため
        if (result.outcome === 'delivered') {
          // 毎回返る文なので短く保つ（理由の詳しい説明は道具の説明文の側に1回だけ置く）: 送るたびにクローンの文脈へ積まれ、読み直しの費用になるため
          // 脚注は同じ会話の2回目から札にする（結論の「同じ本文で新しい委譲を立てない」は札にも残す）。返す直前のここで呼ぶ
          const deliveredNote = foldFixedFor(context, extra)(
            'manager-send:delivered-note',
            '（「届けた」は resume の口が成功を返したところまで。読んだかは manager_report で見る。' +
              '同じ本文で新しい委譲を立てないこと）',
            '（届けたのは resume の口まで。同じ本文で新しい委譲を立てないこと）',
          );
          return finishWithCloses(
            stores,
            text(`[${managerId}] ${result.detail}${unusedNote}\n${deliveredNote}`),
            closes,
            sent,
            'manager_send',
          );
        }
        return finishWithCloses(stores, text(result.detail), closes, sent, 'manager_send');
      },
    ),

    // クローン用の停止を別に作らない: 挙動が2種類あると、人間とクローンで見えている状態が食い違うため
    // マネージャーには渡さない: 自分や隣の仕事を止められると M4 の制御面分離が意味を失うため
    tool(
      'manager_stop',
      [
        'マネージャーを止める。人間が Web UI から押す停止と同じもので、その1本だけが止まる。',
        '暴走しているとき、報告を出したのに終わらないとき、依頼自体が要らなくなったときに使う。',
        '止めたあと本当に止まったかを確かめて返すので、返ってきた状態まで読むこと。',
        '⚠️ いまターンの途中（running）の委譲は既定では止めない——畳むと進行中の作業が' +
          '失われるため。それでも止めるなら force: true を渡すこと。' +
          '止める前に一覧を読めなかったときも、走行中かどうか判定できないので同じく断る。',
      ].join(' '),
      {
        managerId: z.string().describe('manager_list に出ている id'),
        reason: z
          .string()
          .optional()
          .describe('なぜ止めたか。日誌と、その仕事の記録に残る。後から辿れるように書く'),
        force: z
          .boolean()
          .optional()
          .describe(
            'いまターンの途中（status: running）の委譲でも止める。既定（false/省略）だと、' +
              'running の委譲は abort を呼ばずに断って理由を返す——畳むと、そのターンが抱えて' +
              'いる進行中の作業（起こした作業者など。作業ツリーが見つかれば未 push の実装・監視中の CI も）が' +
              '失われるため。' +
              '止める前に一覧を読めなかったとき（走行中か判定できない）も同じく断る。' +
              '断りを読んだうえで、それでも畳んでよいと判断したら true で呼び直すこと。',
          ),
      },
      async ({ managerId, reason, force }) => {
        if (!context.managers) return NO_POOL;
        const pool = context.managers;
        // 3状態にする: `pool.list()` の失敗を `[]` に倒すと「居ない」と「読めなかった」が区別できないため
        type ManagerLookup =
          | { kind: 'found'; manager: ManagerSummary }
          | { kind: 'absent' }
          | { kind: 'unreadable'; reason: string };
        const find = async (): Promise<ManagerLookup> => {
          let list: ManagerSummary[];
          try {
            list = await pool.list();
          } catch (error: unknown) {
            return { kind: 'unreadable', reason: reasonOf(error) };
          }
          const manager = list.find((entry) => entry.managerId === managerId);
          return manager === undefined ? { kind: 'absent' } : { kind: 'found', manager };
        };

        const beforeLookup = await find();
        const before = beforeLookup.kind === 'found' ? beforeLookup.manager : undefined;

        if (beforeLookup.kind === 'unreadable' && force !== true) {
          return text(
            `[${managerId}] 止めていない。**いまの状態を一覧から読めなかった**ので、` +
              '走行中（running）かどうか判定できない — 走行中なら、畳むと、そのターンの' +
              '進行中の作業（起こした作業者など）が失われる。\n' +
              `読めなかった原因: ${beforeLookup.reason}\n` +
              'manager_list で状態を確かめること。読めても判断が同じなら、🔴 force: true で' +
              '呼び直すと止まる。',
          );
        }

        // running は既定で abort を呼ばずに断る: クローンには人間の画面のようにターンが走っている様子が見えないため
        // `force` を必ず残す: 暴走している委譲を止める道を塞ぐほうが、誤って畳むより危険なため
        // `waiting_human` は含めない: クローン自身が立てた問いで、待っていること自体は既に知っているため
        if (before?.status === 'running' && force !== true) {
          // 要点を先頭・短くする: 「⚠ の1行を足す」形の断りは読まれても流されるため、核心（force で止まる）を長い説明の奥に埋めない
          const lastReportLine =
            before.lastReportAt === undefined
              ? '直近の報告は一度も届いていない。'
              : `直近の報告は ${before.lastReportAt}` +
                '（最後に終えたターンのもの。いま走っているターンの中身ではない）。';

          // この調べものが失敗しても断りは必ず返す: 止める道が塞がっていないことを守るため、例外を投げない設計でも念のため捕まえる
          const unpushedWork = await pool
            .unpushedWork(managerId, {
              signal: AbortSignal.timeout(MANAGER_STOP_UNPUSHED_WORK_TIMEOUT_MS),
              source: 'stop-refusal',
            })
            .catch((error: unknown): ManagerUnpushedWork => ({
              kind: 'unavailable',
              reason: `確かめようとして例外が飛んだ: ${reasonOf(error)}`,
            }));

          // 具体（未 push・CI）は作業ツリーが見つかったか探索に失敗したときだけ足す: git を使わない仕事に git/CI 前提の文面を毎回出さないため
          const gitConcrete =
            unpushedWork.kind === 'unavailable' ||
            !isEmptyCompleteUnpushedWorkObservation({
              kind: 'observed',
              worktrees: unpushedWork.result.worktrees,
              truncatedAtCount: unpushedWork.result.truncatedAtCount,
              stoppedEarly: unpushedWork.result.stoppedEarly,
              scratchRootsUnknown: unpushedWork.result.scratchRootsUnknown,
              unreadableDirCount: unpushedWork.result.unreadableDirCount,
            });
          return text(
            `[${managerId}] 止めていない。**いまターンの途中**（running）— 畳むと、そのターンの進行中の作業が失われる` +
              (gitConcrete
                ? '（未 push の実装・起こした作業者・監視中の CI など）'
                : '（起こした作業者など）') +
              '。🔴 force: true で止まる。\n' +
              `${lastReportLine} ターンの中身は manager_report で先に読めること。` +
              (gitConcrete ? `\n${describeUnpushedWork(unpushedWork)}` : ''),
          );
        }

        const result = await pool.abort(managerId, reason, 'clone');

        if (result.outcome === 'unreadable') {
          // 読めない行を「居ない」と言わない
          return text(`${managerId} は止められなかった: ${result.detail}`);
        }
        if (result.outcome === 'absent') {
          if (beforeLookup.kind === 'unreadable') {
            // 読めなかったことを「居ない」と言い切らない
            return text(
              `${managerId} は止められなかった: ${result.detail}\n` +
                `止める前の状態を一覧から読めなかった（${beforeLookup.reason}）ので、` +
                '台帳にあるかどうかは分からない。manager_list で今あるものを確かめること。',
            );
          }
          if (!before) {
            return text(
              `${managerId} は居ない（id が違うか、台帳からも消えている）。` +
                'manager_list で今あるものが見える。',
            );
          }
          return text(
            `${managerId} は止められなかった: ${result.detail}\n` +
              `台帳では ${before.status} で、このデーモンからは話しかけられない（live: false）。` +
              '走らせていた器がもう無いので、止める手そのものが残っていない。',
          );
        }

        const afterLookup = await find();
        const after = afterLookup.kind === 'found' ? afterLookup.manager : undefined;
        // 読めなかったときは「消えている」と言わない
        const afterUnreadable =
          afterLookup.kind === 'unreadable'
            ? `止めた後の状態を一覧から読めなかった（${afterLookup.reason}）`
            : undefined;

        if (result.outcome === 'not_stopped') {
          return text(
            `[${managerId}] ${result.detail}\n` +
              `**止まっていない。** runner には ${managerId} のセッションがまだ残っている。` +
              `いまの状態: ${afterUnreadable ?? (after === undefined ? '一覧から消えている' : describeManagerState(after.status, after.live, after.awaitingBackground))}。` +
              ' manager_list で確かめ、必要ならもう一度止めること。',
          );
        }

        if (result.outcome === 'unknown') {
          // 「止めた」とも「止まっていない」とも言い切らない
          return text(
            `[${managerId}] ${result.detail}\n` +
              '止まったかは**未確認**である（runner に確認が取れなかった）。' +
              'manager_list で状態を確かめること。',
          );
        }

        const lines = [`[${managerId}] ${result.detail}`];

        if (before?.status === 'done') {
          // 「走っている手は無い」と断定しない: `done` はマネージャー自身のターンが終わっただけで、作業者の生存はデーモンから見えないため
          lines.push(
            'もともと待機中（done）だった仕事である。マネージャー自身のターンは終わっていたので、' +
              '畳んだのは記録である。ただし **`done` は「その下で誰も動いていない」ことまでは' +
              '意味しない** — 作業者が走っているかどうかはデーモンからは見えていない。',
          );
        }
        lines.push(
          afterUnreadable !== undefined
            ? `${afterUnreadable}。manager_list で状態を確かめること。`
            : after === undefined
              ? '一覧からも消えている。'
              : `いまの状態: ${describeManagerState(after.status, after.live, after.awaitingBackground)}。`,
        );
        // 届いていない本文を待ってこの応答を止めない: report イベントは HTTP 越しの runner では後から届くため、届いていれば抜粋を、届いていなければ `manager_report` への案内を出す
        lines.push(
          after?.lastFoldedTurn === undefined
            ? '畳んだターンの本文はまだ台帳に届いていない（別経路で後から届くことがある）。' +
                `届けば台帳へ残るので、manager_report ${managerId} で後から読めること。`
            : `畳んだターンの本文（${after.lastFoldedTurn.at} 受信）: ` +
                `${excerptLine(after.lastFoldedTurn.text, MANAGER_STOP_FOLDED_TURN_EXCERPT)} ` +
                `全文は manager_report ${managerId} で読めること。`,
        );
        return text(lines.join('\n'));
      },
    ),

    managerListTool(context),

    tool(
      'manager_report',
      [
        'マネージャーの依頼文・直近の報告を全文で読む。',
        'manager_list は抜粋なので、欠落に気づいたらここで全部読むこと。',
        'manager_list の行は退避 ref を件数と最新の1件しか出さない。ここ（manager_report）も報告の本文の前に、退避 ref を既定では種類ごとの本数に畳んで出す:',
        '生きている退避 ref（最新の1件つき）・消し終えた ref（消した理由ごと）・生きている間に消えた作業ツリー・送るもの無しは本数だけで、',
        '退避できていない（失われうる）作業ツリー（未追跡・submodule・送れなかった失敗）は、本数と代表の1本の行を必ず出す。',
        '全部（ref 名・退避できていない作業ツリーのすべて）は rescueAll: true で作業ツリーごとに読む。',
        '長い場合は続きの取り方が末尾に出るので、最後まで読み切ること。',
        'それでも足りない（報告に書かれていない中身を確かめたい）ときは manager_transcript で生ログまで降りられる。',
        '直近の報告の全文が既にあなたの発言（会話の上）に載っているときは、本文を繰り返さず、載っている時刻を示す注記だけを返す。引き直したいときは refetch: true を付ける（offset で頁を送る・依頼文は影響を受けない）。',
        '全文が載っている報告に未 push などの状態の注記だけが要るなら、引き直さず manager_list の行を見る。',
        'report が「まだ無い」と返ったときは、内部で生ログも見ている（#323）——',
        '「まだ書いていない」のか「書いたのに配られていない」のかを、応答の文言（⚠ の有無）で見分けられる。',
      ].join(' '),
      {
        managerId: z.string().describe('manager_list に出ている id'),
        part: z
          .enum(['report', 'request'])
          .optional()
          .describe('report=直近の報告（既定） / request=依頼文'),
        offset: z
          .number()
          .optional()
          .describe(
            `何文字目から読むか（${formatIntRangeJa({ min: 0 })}）。前回の応答が示した続きの位置を渡す`,
          ),
        rescueAll: z
          .boolean()
          .optional()
          .describe(
            '真なら退避 ref を畳まず作業ツリーごとに全部出す（既定は、種類ごとの本数と、退避できていない作業ツリーの本数・代表の1本だけ）',
          ),
        refetch: z
          .boolean()
          .optional()
          .describe(
            '真なら、報告の全文が既に会話の上に載っていても本文を必ず返す（既定は、載っているときは注記だけ返す）',
          ),
      },
      async (
        { managerId, part = 'report', offset = 0, rescueAll = false, refetch = false },
        extra: unknown,
      ) => {
        const offsetError = describeIntRangeViolation('offset', offset, { min: 0 });
        if (offsetError !== null) return text(offsetError);
        if (!context.managers) return NO_POOL;
        const managers = await context.managers.list();
        const found = managers.find((manager) => manager.managerId === managerId);
        if (!found) {
          // 読めない委譲の行は「居ない」と分けて言う: 見つからなかったときだけ台帳を読み直す（単票の取得のたびに一覧を読まない）
          const unreadableRow = (await context.stores.jobs.listUnreadableJobs()).find(
            (row) => row.id === managerId,
          );
          if (unreadableRow !== undefined) {
            return text(describeUnreadableManagerRow(managerId, unreadableRow.reason));
          }
          return text(
            `マネージャー ${managerId} は居ない（もう畳まれたか、id が違う）。` +
              'manager_list で今あるものが見える。',
          );
        }

        const modelLine = `モデル: ${describeManagerModels(managerModelsOf(context.managers, found))}`;
        // 在れば `lastReport` より優先して見せる: `lastFoldedTurn` は `lastReport` より後に届いた内容で、陰に隠れたままだと `manager_report` から一生読めなくなるため
        const foldedTurn = part === 'request' ? undefined : found.lastFoldedTurn;
        const body = part === 'request' ? found.request : (foldedTurn?.text ?? found.lastReport);
        if (body === undefined || body.length === 0) {
          if (part === 'request') {
            return text(`マネージャー ${managerId} の依頼文が記録に無い。`);
          }
          // 依頼文では見に行かない: 往復を無条件に増やさないため、report のときだけ生ログを見る
          const missing = await describeMissingReport(context.managers, managerId, found.status);
          // 報告の有無とは別の軸なので、報告が空の回だからこちらも出さない、にはしない
          const usageStopped = describeUsageStopped(found);
          const runnerVanished = describeRunnerVanished(found);
          const systemError = describeManagerSystemError(found);
          const cgroupEvents = describeManagerCgroupEvents(found);
          // 報告が空の回でも拒否は出す: 黙ると「まだ書いていない」と「番人に止められて書けない」を区別できないため
          const denied = describeDenials(context.managers.denials(managerId), found.lastReportAt);
          // この枝でも出す: `manager_list` で「何も届いていない」と読んだクローンが掘りに来る先で、黙ると順位を付けた意味が掘った先で消えるため
          const unobserved = describeUnobservedOutcome(found);
          const unpushedWork = unpushedWorkReportNote(found, rescueAll);
          const withheldReportsNote = describeWithheldReports(found);
          return text(
            [
              modelLine,
              missing,
              usageStopped,
              runnerVanished,
              systemError,
              cgroupEvents,
              denied,
              unobserved,
              unpushedWork,
              withheldReportsNote,
            ]
              .filter((s) => s !== null)
              .join('\n\n'),
          );
        }

        // 失敗した回は「報告」と呼ばない: 見出しが「直近の報告」のままだと、⚠ を見た直後に包みの内側だけを読んで報告として扱うため
        // `foldedTurn` が在る回は注記を出さない: `lastFailure` は畳まれる前の無関係な古いターンを指し、注記が予告する本文の種類と実際の本文が食い違うため
        const managerFailure =
          part === 'request' || foldedTurn !== undefined
            ? null
            : describeManagerFailure(
                found.lastFailure,
                found.lastReport,
                found.status,
                tokenGenerationMismatched(found),
              );
        const usageStopped = part === 'request' ? null : describeUsageStopped(found);
        const runnerVanished = part === 'request' ? null : describeRunnerVanished(found);
        const systemError = part === 'request' ? null : describeManagerSystemError(found);
        const cgroupEvents = part === 'request' ? null : describeManagerCgroupEvents(found);
        // 報告が在る回でも拒否は出す: 報告を書いた後で別の道具を止められていると、本文だけ読むと「報告どおり進んでいる」と読めるため
        // foldedTurn の回は `lastReportAt` の代わりに `foldedTurn.at` を渡す: `lastReportAt` は畳まれる前の古い値のままで、「拒否の後の報告はまだ届いていない」と誤判定するため
        const denied =
          part === 'request'
            ? null
            : describeDenials(
                context.managers.denials(managerId),
                foldedTurn !== undefined ? foldedTurn.at : found.lastReportAt,
              );
        // 依頼文（`part === 'request'`）では注記を出さない: 依頼文は報告・失敗・拒否の話ではないため
        const unobserved = part === 'request' ? null : describeUnobservedOutcome(found);
        const unpushedWork = part === 'request' ? null : unpushedWorkReportNote(found, rescueAll);
        const withheldReportsNote = part === 'request' ? null : describeWithheldReports(found);
        const label =
          part === 'request'
            ? '依頼文'
            : // 停止後に届いた本文は別の見出しで言い分ける: `isFoldedTurnReport` とは別の畳まれ方のため
              foldedTurn !== undefined
              ? `停止後に届いた、畳まれたターンの中身（${foldedTurn.at} 受信）`
              : isFoldedTurnReport(found)
                ? '直近のターンの中身'
                : '直近の報告';
        const part1 = page(body, offset, REPORT_PAGE);
        // 齢といまの status を見出しに添える: 読み手が直近に完了したターンの中身をいまの状態として読まないため
        const reportAgeStatus =
          part === 'request'
            ? ''
            : foldedTurn !== undefined
              ? // foldedTurn の回は `lastReportAt` の欄ごと出さない: 畳まれる前の別のターンの受信時刻で、いま読んでいる本文の齢に見えるため
                ` — いまの status: \`${found.status}\``
              : // 文言に「直近の報告」を含めない: 見出しを「直近のターンの中身」へ切り替えた回で混ざると、切り替えた意味が薄れるため
                ` — lastReportAt: ${found.lastReportAt ?? '一度も届いていない'} / いまの status: \`${found.status}\``;
        const head = `マネージャー ${managerId} の${label}（${describePage(part1)}）${reportAgeStatus}`;
        // foldedTurn の回はその材料で組む: `lastReportAt` / `lastReportStatus` は畳まれる前の別のターンの値で、そのまま渡すと無関係な drift を語るため
        const drift =
          part === 'request'
            ? ''
            : describeReportDrift({
                managerId,
                lastReportAt: foldedTurn !== undefined ? foldedTurn.at : found.lastReportAt,
                lastReportStatus: foldedTurn !== undefined ? 'stopped' : found.lastReportStatus,
                status: found.status,
                now: new Date(),
              });
        const driftNote = drift === '' ? '' : `${drift}\n\n`;
        // 失敗は本文の上に置く: 下だと包まれたエラー文を先に読んでから「実は報告ではない」と分かる順になるため。以下の注記も同じ順
        const failureNote = managerFailure === null ? '' : `${managerFailure}\n\n`;
        const usageStoppedNote = usageStopped === null ? '' : `${usageStopped}\n\n`;
        const runnerVanishedNote = runnerVanished === null ? '' : `${runnerVanished}\n\n`;
        const systemErrorNote = systemError === null ? '' : `${systemError}\n\n`;
        const cgroupEventsNote = cgroupEvents === null ? '' : `${cgroupEvents}\n\n`;
        const denialNote = denied === null ? '' : `${denied}\n\n`;
        const unobservedNote = unobserved === null ? '' : `${unobserved}\n\n`;
        const unpushedWorkNote = unpushedWork === null ? '' : `${unpushedWork}\n\n`;
        const withheldReportsFooterNote =
          withheldReportsNote === null ? '' : `${withheldReportsNote}\n\n`;
        // 本文だけを畳む: 状態の注記（失敗・拒否・退避 ref など）は発言の後に変わりうるので残す。依頼文・頁送り（offset > 0）・refetch は従来どおり本文を出す
        const shownAt =
          part === 'report' && offset === 0 && !refetch && !isSubagentCaller(context, extra)
            ? (context.managerReportShownAt?.(managerId, body) ?? null)
            : null;
        if (shownAt !== null) {
          return text(
            `${head}\n\n${modelLine}\n\n${driftNote}${failureNote}${usageStoppedNote}${runnerVanishedNote}${systemErrorNote}${cgroupEventsNote}${denialNote}${unobservedNote}${unpushedWorkNote}${withheldReportsFooterNote}` +
              `この報告の全文（${body.length.toLocaleString('en-US')} 文字）は ${shownAt.toISOString().slice(11, 16)}Z の発言に載っている（会話の上）。` +
              '引き直すには `refetch: true` を付ける。' +
              `\n\n（さらに掘るなら manager_transcript managerId=${managerId} で生ログへ）`,
          );
        }
        const tail = part1.more
          ? `\n\n…（ここで切れている。続きは manager_report managerId=${managerId}` +
            `${part === 'request' ? ' part=request' : ''} offset=${part1.to}）`
          : '';
        // 切れていない場合にも次の一手を常に添える: ここに載る `lastReport` は報告の全文で、セッションの生ログではないため
        const footer =
          '\n\n（さらに掘るなら manager_transcript managerId=' + managerId + ' で生ログへ）';
        return text(
          `${head}\n\n${modelLine}\n\n${driftNote}${failureNote}${usageStoppedNote}${runnerVanishedNote}${systemErrorNote}${cgroupEventsNote}${denialNote}${unobservedNote}${unpushedWorkNote}${withheldReportsFooterNote}${part1.body}${tail}${footer}`,
        );
      },
    ),
  ];
}
