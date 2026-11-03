// マネージャーへの委譲（manager_start / manager_send / manager_stop / manager_list / manager_report）の道具。
// `tools.ts` から呼ぶ（`createCloneTools` が並びのまま連結する）。このファイルから `tools.ts` を import しない（一方向）。

import { createHash } from 'node:crypto';
import { z } from 'zod';
import { describeArchiveRemovedBytesUnit } from './archive-removed-bytes.js';
import { readAttachmentLimits } from './attachment.js';
import {
  attachmentRefsOf,
  loadManagerAttachments,
  ManagerAttachmentsRefusedError,
} from './manager-attachments.js';
import { isRunningJobStatus } from './job-status-running.js';
import { taskStatusForJob } from './task.js';
import { describeDenialStreakForList } from './classifier-denial-streak.js';
import {
  compareManagerPosition,
  encodeManagerCursor,
  normalizeManagerCursorStatus,
  resolveManagerCursor,
  type ManagerPosition,
} from './manager-cursor.js';
import {
  describePidsSaturation,
  RUNNER_CAPABILITY_AWAITING_BACKGROUND_SIGNAL,
} from './runner-protocol.js';
import { CGROUP_EVENTS_UNKNOWN_NOTE, formatCgroupEventsNote } from './cgroup-events.js';
import { formatSystemErrorFacts, SYSTEM_ERROR_UNKNOWN_NOTE } from './system-error.js';
import {
  classifyUnobservedOutcome,
  describeManagerState,
  describeSessionMissingKind,
  describeReportState,
  describeUnobservedOutcome,
  isManagerAwaitingJudgement,
  isManagerInFlight,
  isManagerOutcomeUnobserved,
  JUDGEMENT_RANK_NOT_APPLICABLE,
} from './digest.js';
import { reasonOf } from './dropped-record.js';
import {
  describePage,
  excerptLine,
  fillListingBudget,
  page,
  renderFilledListing,
  renderListingEntry,
} from './excerpt.js';
import {
  classifyManagerActivity,
  describeReportDrift,
  type ManagerActivityInput,
} from './manager-activity.js';
import { denialActorTag, describeDenialFollowUp } from './denial-format.js';
import { HELD_MESSAGE_TTL_MS } from './held-messages.js';
import {
  decisionUnusedNote,
  type ManagerPool,
  type ManagerSendResult,
  type ManagerSummary,
  type ManagerTranscript,
  type RunnerBacklogSnapshot,
  type TokenGenerationUnknownReason,
} from './manager.js';
import { tokenGenerationMismatched } from './manager-summary.js';
import type { ManagerDenial } from './denial-key.js';
import type { ManagerUnpushedWork } from './unpushed-work-observation.js';
import { stripNul } from './nul-guard.js';
import {
  externalOutputLimits,
  jobStatusSchema,
  type Task,
  type ExternalOutput,
  type Job,
  type JobStatus,
  type LastUnpushedWorkObservation,
  type RescueRemovalReason,
} from './schema.js';
import {
  UnreadableTaskError,
  describeUnreadableJobs,
  describeUnreadableManagerRow,
  type InboxPeek,
  type Stores,
} from './store.js';
import {
  RESTART_BEFORE_CHECK_ADVICE,
  RESTART_BEFORE_CHECK_ADVICE_CORE,
  STALE_TOKEN_RESTART_ADVICE,
  limitRecoveryOf,
  limitRecoveryOfAssistantError,
  withRecoveryNote,
} from './usage-limits.js';
import {
  describeHumanOriginatedInboxAlert,
  describeInboxBacklogBreakdown,
  describeInboxBacklogQueuedInMemory,
  describeNoReadableInboxEvents,
  summarizeInboxBacklog,
  type InboxBacklogBreakdown,
} from './inbox-backlog.js';
import { describeManagerFoldCandidate } from './manager-fold-candidate.js';
import { describeManagerModels, managerModelsOf } from './manager-models.js';
import {
  describeUnpushedWorkObservationIncompleteness,
  describeUnpushedWorkObservationProvenance,
  describeUnpushedWorkObservationSource,
  formatUnpushedWorkObservationWorktrees,
  isEmptyCompleteUnpushedWorkObservation,
  UNPUSHED_WORK_SHUTDOWN_OBSERVATION_NOT_ARRIVED_NOTE,
} from './unpushed-work-observation-format.js';
import { describeWaitingKind } from './waiting-kind-format.js';
import { formatElapsedAgo } from './format-elapsed.js';
import { RESCUE_NOT_PUSHED_TEXT, rescueNotPushedDetail } from './workspace-swap-hints.js';
import {
  describeIntRangeViolation,
  describeStringLengthViolation,
  formatIntRangeJa,
  formatStringLengthJa,
} from './tool-arg-checks.js';
import {
  type FixedFold,
  NO_FIXED_FOLD,
  describeRunnerLegState,
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

const MANAGER_ATTACHMENTS_DESCRIPTION =
  '人間の添付を担い手にも見せたいときに、その添付の id（通知行の id=… / conversation_read の添付行）を渡す。' +
  '渡したものは担い手の手元にファイルとして置かれ（通知行にパスが付くので Read で開ける）、画像は画像としても見える。' +
  '渡さない添付は担い手には見えない。**記憶には写らない**（日誌に残るのは渡した添付の参照だけで、中身は残らない）。' +
  '見つからない添付（保持期限切れ・id の誤り）があれば、何も送らずにエラーを返す。個数・合計には人間の発言と同じ上限がある。' +
  '確認への回答（requestId / decision）には載せられない。';

const LIST_REQUEST_EXCERPT = 160;

const LIST_REPORT_EXCERPT = 240;

// `LIST_REPORT_EXCERPT` を使い回さない: 値が同じ桁でも、片方だけ直したくなったときに一緒に動くため
const LIST_TURN_END_TAIL_EXCERPT = 160;

// `LIST_REPORT_EXCERPT` を使い回さない: 用途ごとに別に置く
const MANAGER_STOP_FOLDED_TURN_EXCERPT = 240;

// runner 側のキャップを根拠にしない: `AskUserQuestion` は `brief` を通らないため、出す側で締める
const LIST_WAITING_EXCERPT = 200;

const LIST_BUDGET = 8_000;

// 同じ会話で前回に全文で出した行と1字も違わない行を、managerId だけの短い1行にする。判定は行の全文の完全一致（可変部を含む）。
// 鍵に行の指紋を入れ、同じ担当の古い版は捨てる（`foldFixed` の supersedes）: A→B→A と変わったとき、2回前の A を「前回と同じ」と言わないため。
// 控えは `DigestSessionDelta.fixed` に乗るので、reset・compaction・失敗ターン・20ターン保険（forgetFixed）で全文へ戻る
const MANAGER_LIST_ROW_FOLD_PREFIX = 'manager-list:row:';

const MANAGER_ROW_SAME_MARK = '前回と同じ';

function rowFingerprint(row: string): string {
  return createHash('sha256').update(row).digest('hex').slice(0, 24);
}

function managerRowRef(manager: ManagerSummary): string {
  return `- ${manager.managerId} ${MANAGER_ROW_SAME_MARK}`;
}

// 見落とすと困る行は、前回と同じでも全文で出す。lost・失敗・枠で止まっている・runner 消失／セッション無し・⚠ の行
function managerRowAlwaysFull(manager: ManagerSummary, row: string): boolean {
  return (
    manager.status === 'lost' ||
    manager.status === 'failed' ||
    manager.lastFailure !== undefined ||
    manager.usageStoppedAt !== undefined ||
    manager.runnerVanished !== undefined ||
    manager.runnerLostSince !== undefined ||
    manager.sessionMissingSince !== undefined ||
    row.includes('⚠')
  );
}

// 行ごとに同じ長い固定文を繰り返さず、行には印だけを置いて意味は一覧の末尾に1回だけ書く（#5347）。
// 429 の波で runner が一斉に黙る・lost が並ぶときに、同じ文が行の数だけ積まれて LIST_BUDGET が尽き、後続の行が省略されるため
type ManagerListNoteMark = 'runner-lost' | 'session-missing' | 'lost';

const MANAGER_LIST_NOTE_MARKS: Record<ManagerListNoteMark, string> = {
  'runner-lost': '［runner 消失］',
  'session-missing': '［セッション無し］',
  lost: '［lost］',
};

const MANAGER_LIST_NOTE_BODIES: Record<ManagerListNoteMark, string> = {
  'runner-lost':
    '宛先の器が行の時刻以降 名乗っていない。新しい委譲の宛先からは外れている（置き先として数えない）。' +
    '**この委譲が失われたという意味ではない** — 黙っているのが器なのか経路なのかは、ここからは言えない（器の中でまだ走っていることもある）。' +
    '話しかけることは塞いでいない — 戻る先（session_id）が在れば manager_send が resume を試みる（届くとは限らない）。' +
    '器そのものは runner_list で見る。',
  'session-missing':
    '行の時刻の時点で、宛先の runner がこの委譲のセッションを持っていなかった（runner がそう答えた。聞けなかったのではない）。' +
    '**この委譲が失われたという意味ではない** — ' +
    '完遂した後にセッションが畳まれ、終端イベントだけが届かなかった回も同じ形に見える' +
    '（デーモンにこの2つを区別する材料は無い）。まず manager_report を見ること' +
    '（報告が空でも、生ログから「生成されたが配られていない」報告を拾える）。' +
    'session_id が残っていれば manager_send が resume から入り直す。',
  lost:
    '前のセッションへ戻れなかった。**戻れたかどうかしか見ていない** — ' +
    'この仕事が終わっていたかは分からない（成果がリモートの PR・ブランチ・' +
    'コミットまで届いていることがある）。まずそこを確かめ、続きが要ると' +
    '判断したときだけ manager_start で起こし直すこと。',
};

// 2回目からの札。安全上の結論（失われたという意味ではない・終わったかは分からない）は札にも残し、全文は同じ会話の最初の一覧を指す
const MANAGER_LIST_NOTE_REFS: Record<ManagerListNoteMark, string> = {
  'runner-lost':
    '宛先の器が名乗っていない。**この委譲が失われたという意味ではない**（器の中で走っていることもある）。' +
    '話しかけることは塞いでいない（全文は最初の一覧のとおり）。',
  'session-missing':
    'runner がこの委譲のセッションを持っていなかった。**この委譲が失われたという意味ではない**。' +
    'まず manager_report を見る（全文は最初の一覧のとおり）。',
  lost:
    '前のセッションへ戻れなかっただけで、**終わったかは分からない**（成果が外へ出ていることがある）。' +
    'まず成果を確かめ、続きが要るときだけ manager_start（全文は最初の一覧のとおり）。',
};

const MANAGER_LIST_NOTE_ORDER: readonly ManagerListNoteMark[] = [
  'runner-lost',
  'session-missing',
  'lost',
];

// 出ている行が使った印の分だけ書く（使われなければ1文字も足さない）。RESTART_BEFORE_CHECK_ADVICE は
// runner 消失・セッション無しの両方に掛かるので、並べずここで1回だけ言う
// `fold` は返す文に載せるときだけ渡す（呼んだ時点で「会話に出した」と控えるため、予算を測るだけの呼びには渡さない）
function managerListNotes(
  rowMarks: readonly ReadonlySet<ManagerListNoteMark>[],
  fold: FixedFold = NO_FIXED_FOLD,
): string {
  const used = MANAGER_LIST_NOTE_ORDER.filter((mark) => rowMarks.some((marks) => marks.has(mark)));
  if (used.length === 0) return '';
  const lines = used.map(
    (mark) =>
      `${MANAGER_LIST_NOTE_MARKS[mark]} ${fold(`manager-list:note-${mark}`, MANAGER_LIST_NOTE_BODIES[mark], MANAGER_LIST_NOTE_REFS[mark])}`,
  );
  if (used.includes('runner-lost') || used.includes('session-missing')) {
    lines.splice(
      used.includes('lost') ? used.length - 1 : used.length,
      0,
      `${used
        .filter((mark) => mark !== 'lost')
        .map((mark) => MANAGER_LIST_NOTE_MARKS[mark])
        .join('')} ${RESTART_BEFORE_CHECK_ADVICE}`,
    );
  }
  return `行の印の意味（同じ文を行ごとには繰り返さない）:\n${lines.join('\n')}`;
}

const MANAGER_WAITING_LIST_LIMIT = 10;

const LIST_DENIED_TOOLS = 3;

const LIST_TOOL_USE_STALL_LIMIT = 3;

// 「未処理の合図は無い」は、器の行も読めない行もメモリの待ち行列も0件のときにしか言わない
function describeInboxBacklog(
  peek: InboxPeek,
  now: number,
  queuedInMemory: number | undefined,
  fold: FixedFold = NO_FIXED_FOLD,
  // 真なら、前回と同じ内訳も全文で出し直す（控えは更新する）
  refetch = false,
): string {
  const rows = peek.entries;
  const queuedLine = describeInboxBacklogQueuedInMemory(queuedInMemory, fold);
  const noReadable = describeNoReadableInboxEvents(peek.unreadable);
  // 行が無い回は、会話に出した内訳の控えを捨てる: A→空→A の3回目を、空の回を挟んだのに「前回と同じ」と畳まないため
  // 控えを捨てる口は `supersedes` だけなので、全文を出す回の形（前置きで始まる控えを消して1件足す）で呼ぶ。この鍵は内訳の指紋と衝突しない
  if (rows.length === 0) {
    fold(`${MANAGER_LIST_INBOX_BREAKDOWN_PREFIX}none`, '', '', MANAGER_LIST_INBOX_BREAKDOWN_PREFIX);
  }
  if (rows.length === 0 && noReadable !== null) {
    return queuedLine === null ? noReadable : `${noReadable}\n${queuedLine}`;
  }
  if (rows.length === 0) {
    if (queuedLine === null) return 'クローンの受信箱に未処理の合図は無い。';
    return `器の行に未処理の合図は無い（メモリの配達待ち行列は別の軸——下）。\n${queuedLine}`;
  }
  const breakdown = summarizeInboxBacklog(rows, now, peek.unreadable);
  const oldest =
    breakdown.oldestAt === undefined ? '' : `（最も古いものは ${breakdown.oldestAt} から）`;
  const humanOriginatedAlert = describeHumanOriginatedInboxAlert(breakdown, fold);
  const fullBreakdown = describeInboxBacklogBreakdown(breakdown, fold);
  // 内訳（人間起点の行と内訳の本体）が、同じ会話で前回に全文で出した版と同じ中身なら1行ずつにする。
  // 件数と最も古い時刻の見出しは毎回出す。読めない行が在る回も `fold` は呼んで控えを最新にするが、出力は全文（⚠ を落とさない）。
  // `&&` で呼びを飛ばさない: 飛ばすと控えが古いまま残り、A→B（読めない行あり）→A の3回目を「前回と同じ」と畳む
  const sameAsShown =
    fold(
      `${MANAGER_LIST_INBOX_BREAKDOWN_PREFIX}${inboxBreakdownFingerprint(breakdown)}`,
      fullBreakdown,
      describeInboxBreakdownRef(breakdown),
      MANAGER_LIST_INBOX_BREAKDOWN_PREFIX,
    ) !== fullBreakdown;
  const folded = sameAsShown && !refetch && breakdown.unreadable === undefined;
  const humanOriginatedLine =
    humanOriginatedAlert === ''
      ? ''
      : `${folded ? describeHumanOriginatedAlertRef(breakdown) : humanOriginatedAlert}\n`;
  const queuedSuffix = queuedLine === null ? '' : `\n${queuedLine}`;
  return (
    `${humanOriginatedLine}` +
    `⚠ クローンの受信箱に未処理の合図が ${breakdown.total} 件ある${oldest}\n` +
    (folded ? describeInboxBreakdownRef(breakdown) : fullBreakdown) +
    queuedSuffix
  );
}

// 受信箱の内訳の控え。鍵に内訳の指紋を入れ、古い版は捨てる（`foldFixed` の supersedes）: A→B→A と変わったとき、2回前の A を「前回と同じ」と言わないため。
// 指紋は観測時刻（毎回変わる）を除いた内訳の全文: 件数・種類・送信元・齢の段（段が動けば別の版）が1つでも変われば全文へ戻る
const MANAGER_LIST_INBOX_BREAKDOWN_PREFIX = 'manager-list:inbox-breakdown:';

function inboxBreakdownFingerprint(breakdown: InboxBacklogBreakdown): string {
  const stable = { ...breakdown, observedAt: '' };
  return rowFingerprint(
    `${describeHumanOriginatedInboxAlert(stable)}\n${describeInboxBacklogBreakdown(stable)}`,
  );
}

function describeInboxBreakdownRef(breakdown: InboxBacklogBreakdown): string {
  return (
    `内訳（計 ${breakdown.total} 件）は前回と同じ（観測 ${breakdown.observedAt} 時点の値。` +
    '種類・送信元・齢の全文は前の一覧のとおり。引き直しは manager_list に refetch: true。' +
    '⚠ 器の入れ替え回数は配られた回数ではない。同一本文の件数: この数は上下どちらへもぶれる）'
  );
}

function describeHumanOriginatedAlertRef(breakdown: InboxBacklogBreakdown): string {
  const h = breakdown.humanOriginated;
  return (
    `⚠ 人間起点（human_message / human_answer）の滞留が ${h.total} 件ある` +
    `（うち、いまの器になってから積まれ、まだ片付いていない分が ${h.undelivered} 件。配達されていないとは言えない。前回と同じ）。`
  );
}

// 「いつ観測できた値か」を必ず添える: キャッシュを現在値と取り違えさせないため
// 「未報告」と言わない: `pendingEvents` は Outbox へ積み済みでデーモンへ未達の件数のため
function describeRunnerBacklog(snapshots: readonly RunnerBacklogSnapshot[]): string | null {
  const lines = snapshots
    .filter((snapshot) => snapshot.pendingEvents > 0)
    .map((snapshot) => {
      const oldest =
        snapshot.oldestPendingAt === undefined
          ? ''
          : `（最も古いものは ${snapshot.oldestPendingAt} から）`;
      return (
        `⚠ runner ${snapshot.runnerId} に未送出の出来事が ${snapshot.pendingEvents} 件ある${oldest}。` +
        `これは ${snapshot.observedAt} 時点に取った値で、いまの値ではない` +
        '（identity() を持つ runner なら10秒ごとの生存確認でも自動で更新されるが、' +
        'それでも「いまの値」ではない。すぐ最新が要るなら runner_list を resources: true で呼び直す）。' +
        ` ${describeRunnerLegState(snapshot)}`
      );
    });
  return lines.length === 0 ? null : lines.join('\n');
}

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

// app.ts の人間の直接送信の行（`excerptLine(text, 200)`）に合わせる
const MANAGER_ANSWER_MESSAGE_EXCERPT = 200;

// 長さの上限もエスケープも掛けない: journal 側に無い制約をここにだけ足す理由が無いため
function denialReasonTag(
  denial: Pick<ManagerDenial, 'reasonType' | 'reason' | 'message' | 'inputHead'>,
): string {
  const parts = [
    denial.reasonType === undefined ? undefined : `分類: ${denial.reasonType}`,
    denial.reason === undefined ? undefined : `理由: ${denial.reason}`,
    denial.message === undefined ? undefined : `モデルへの拒否文: ${denial.message}`,
    denial.inputHead === undefined ? undefined : `入力の先頭: ${denial.inputHead}`,
  ].filter((part): part is string => part !== undefined);
  return parts.length > 0 ? ` [${parts.join(' / ')}]` : '';
}

// 拒否の出所を断定しない: 器の分類器と alteroid 自身のフックの拒否は同じイベントで通り、帰結が違うため
// 「0 件」を「止められていない」と読ませない: 数は器を作り直せば消えるため
function describeDenials(
  denials: ManagerDenial[],
  lastReportAt: string | undefined,
): string | null {
  if (denials.length === 0) return null;
  const followUp = describeDenialFollowUp(denials, lastReportAt);
  const recent = [...denials].reverse();
  const shown = recent.slice(0, LIST_DENIED_TOOLS);
  const rest = recent.length - shown.length;
  const total = denials.reduce((sum, entry) => sum + entry.count, 0);
  return (
    `⚠ 確認へ上がらず止められた道具: ${shown.map((e) => `${e.tool} ${e.count}件${denialActorTag(e.actor)}${denialReasonTag(e)}`).join(' / ')}` +
    (rest > 0 ? `（ほか ${rest} 種、全 ${total} 件）` : '') +
    '。まず担い手自身に返っている拒否文を読ませること。出所はこの数からは取れない —— ' +
    '(a) 器の分類器か deny 規則なら、この確認はクローンには回ってきていないので手が止まる。' +
    '(b) alteroid 自身の `PreToolUse` フック（`bash-wait-guard.ts` 等）なら、理由と代替案は' +
    '担い手へ直接返っており、自力で抜けられることがある' +
    '（全件は journal_read に残っている。件数はデーモンを作り直すと数え直しになる）。' +
    (followUp === null ? '' : `${followUp}。`)
  );
}

/** 確認待ちの peer が残っている担当に1行（#4886）。確認に期限は無く、答えるまで peer は止まったままなので、一覧で見えるようにする。 */
function peerApprovalsLine(
  approvals: { count: number; oldestSince: string } | undefined,
): string | null {
  if (approvals === undefined) return null;
  return (
    `  ⚠ 確認待ちの peer が ${String(approvals.count)} 本ある（最古は ${approvals.oldestSince} から待っている）。` +
    '担当が peer_approve で答えるまで peer は止まったままで、確認の期限は無い。'
  );
}

function denialLine(denials: ManagerDenial[], lastReportAt: string | undefined): string | null {
  const note = describeDenials(denials, lastReportAt);
  return note === null ? null : `  ${note}`;
}

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

// `status` を `failed` へ置き換えない: 支出上限に当たった回もセッションは生きており、「もう続けられない」と読ませると起こし直す判断を誤るため
// SDK の語（`code` / `via`）をそのまま出す: 言い換えると型定義や生ログで引ける手がかりが消えるため
// 終端した枝には RESTART_BEFORE_CHECK_ADVICE を付けない: 二重起動の危険は死んでいるか確認できていないときにしか成り立たないため
function describeManagerFailure(
  failure: ManagerSummary['lastFailure'],
  lastReport: string | undefined,
  status: ManagerSummary['status'],
  staleToken = false,
): string | null {
  if (failure === undefined) return null;
  const opening =
    `⚠ 直近のターンは報告ではなく失敗で終わっている: ${failure.code}（${failure.via}, ${failure.at}）。` +
    'この行の下に出る本文は runner が包んだエラー文（「このターンは応答を返さずに終わった: …」）で' +
    'あって報告ではない——**完遂して畳んだと読まないこと。** ';
  // 終端した枝のクォート内の言い換えを、生きている側の文言の部分文字列にしない: `.not.toContain(ALIVE_CLAIM)` の陰性対照がクォートの中身にも当たるため
  const base = isManagerOutcomeUnobserved(status)
    ? opening +
      `ただし status: ${status}——セッションそのものが、依頼者が望まない終わり方で` +
      '既に終端している。「セッションが生きていて原因が解ければ進められる」という前提は' +
      'ここでは成り立たない——起こし直すには manager_send で resume を試みるしかなく、' +
      '届く保証は無い（届いた事実の判定は `systemErrorLine` 等の別の行を見ること）。'
    : status === 'stopped'
      ? opening +
        'ただし status: stopped——このセッションは、その後 人間・クローンが明示的に' +
        '停止させ、確かめたうえで既に終端している（`abort()` が runner の一覧を探って' +
        'セッションが消えたことを確かめた事実。`manager-liveness.ts` の `isLive()` の doc）。' +
        '「セッションが生きていて原因が解ければ進められる」という前提はここでは成り立たない' +
        '——起こし直すには manager_send で resume を試みるしかなく、届く保証は無い' +
        '（届いた事実の判定は `systemErrorLine` 等の別の行を見ること）。'
      : opening +
        'セッションは生きているので、原因が解ければ manager_send で続きから進む' +
        '（status が done のままなのはそのためで、この委譲が死んだという意味ではない）。' +
        RESTART_BEFORE_CHECK_ADVICE;
  // `stopped` でも「resume を試みるしかなく、届く保証は無い」を言う: `manager_send` からの起こし直し自体は塞がれていないため
  if (lastReport === undefined) return base;
  const fromText = limitRecoveryOf(lastReport);
  const recovery =
    fromText !== 'unknown'
      ? fromText
      : failure.via === 'assistant_error'
        ? limitRecoveryOfAssistantError(failure.code)
        : 'unknown';
  return withRecoveryNote(base, recovery, { staleToken });
}

// `ManagerSummary` ごと受け取る: 2つの欄だけだと呼び出し側が判定を組み立て直し、`manager_report` 側と割れるため
// `lastFoldedTurn` が在る回は出さない: `lastFailure` は畳まれる前の古いターンを指し、「直近」が事実と違うため
function failureLine(manager: ManagerSummary): string | null {
  if (manager.lastFoldedTurn !== undefined) return null;
  const note = describeManagerFailure(
    manager.lastFailure,
    manager.lastReport,
    manager.status,
    tokenGenerationMismatched(manager),
  );
  return note === null ? null : `  ${note}`;
}

// `failureLine` と排他にしない: 走行中は `usage_notice` が先に届き、まだ `lastFailure` が立っていない回があるため
// `stopped` も「セッションは生きている」と言わない: `abort()` は死を確かめて終端させ、印が残ったまま `stopped` になりうるため
function describeUsageStopped(manager: ManagerSummary): string | null {
  if (manager.usageStoppedAt === undefined) return null;
  if (isManagerOutcomeUnobserved(manager.status)) {
    return (
      `⚠ 枠(利用上限)で止まっている（${manager.usageStoppedAt} から）。` +
      `ただし status: ${manager.status}——セッションそのものが、依頼者が望まない` +
      '終わり方で既に終端している。「セッションは生きているので鍵が回れば続く」' +
      'はここでは成り立たない——起こし直すには manager_send で resume を試みる' +
      'しかなく、届く保証は無い（届いた事実の判定は `systemErrorLine` 等の' +
      '別の行を見ること）。'
    );
  }
  if (manager.status === 'stopped') {
    return (
      `⚠ 枠(利用上限)で止まっている（${manager.usageStoppedAt} から）。` +
      'ただし status: stopped——このセッションは、その後 人間・クローンが明示的に' +
      '停止させ、確かめたうえで既に終端している（`abort()` が runner の一覧を探って' +
      'セッションが消えたことを確かめた事実。`manager-liveness.ts` の `isLive()` の doc）。' +
      '「セッションは生きているので鍵が回ればこの委譲は続く」はここでは成り立たない' +
      '——起こし直すには manager_send で resume を試みるしかなく、届く保証は無い' +
      '（届いた事実の判定は `systemErrorLine` 等の別の行を見ること）。'
    );
  }
  return (
    `⚠ 枠(利用上限)で止まっている（${manager.usageStoppedAt} から）。` +
    'セッションは生きているので、鍵が回ればこの委譲は続く' +
    '——status はそれまで動かさない（仕様である）。'
  );
}

function usageStoppedLine(manager: ManagerSummary): string | null {
  const note = describeUsageStopped(manager);
  return note === null ? null : `  ${note}`;
}

// `status` を置き換えない: entry が消えていても `sessionId` が残っていれば `manager_send` は resume から入り直せることがあるため
function describeRunnerVanished(manager: ManagerSummary): string | null {
  if (manager.runnerVanished === undefined) return null;
  return (
    `⚠ 宛先の runner が名簿から消えている（この委譲の走り始めは ${manager.startedAt}。` +
    '消えた時刻は名簿に残っていないので分からない）。resume を試したわけではないので lost ではない' +
    '——manager_list status: ["lost"] の絞りには掛からない。'
  );
}

function runnerVanishedLine(manager: ManagerSummary): string | null {
  const note = describeRunnerVanished(manager);
  return note === null ? null : `  ${note}`;
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

// 本文の文言を見て判定しない: 判定は構造化された印だけで行う
export function isFoldedTurnReport(
  manager: Pick<ManagerSummary, 'lastFailure' | 'lastUnreported'>,
): boolean {
  return manager.lastFailure !== undefined || manager.lastUnreported !== undefined;
}

// D が A（枠 429）を飲み込まない: この欄には枠 429 も乗るため、D の文言自身が判定できなかったと名乗る
function describeManagerSystemError(manager: ManagerSummary): string | null {
  if (manager.status !== 'failed') return null;
  if (manager.lastSystemError === undefined) {
    return `⚠ セッションは失敗で畳まれた。${SYSTEM_ERROR_UNKNOWN_NOTE}。`;
  }
  return (
    `⚠ セッションは器の資源による落ち方で畳まれた可能性 ` +
    `（${manager.lastSystemError.at}）: ${formatSystemErrorFacts(manager.lastSystemError)}`
  );
}

function systemErrorLine(manager: ManagerSummary): string | null {
  const note = describeManagerSystemError(manager);
  return note === null ? null : `  ${note}`;
}

// 因果は名乗らない: 言えるのは「同じ時間帯に器でそれが起きた／起きなかった」までのため
function describeManagerCgroupEvents(manager: ManagerSummary): string | null {
  if (manager.status !== 'failed') return null;
  if (manager.lastCgroupEvents === undefined) {
    return `⚠ ${CGROUP_EVENTS_UNKNOWN_NOTE}。`;
  }
  return `${formatCgroupEventsNote(manager.lastCgroupEvents)}（${manager.lastCgroupEvents.at}）。`;
}

function cgroupEventsLine(manager: ManagerSummary): string | null {
  const note = describeManagerCgroupEvents(manager);
  return note === null ? null : `  ${note}`;
}

// 字面そのものはここで作らない: 作ると `manager_report` と割れるため
function unobservedOutcomeLine(manager: ManagerSummary): string | null {
  const note = describeUnobservedOutcome(manager);
  return note === null ? null : `  ${note}`;
}

export function describeReportDriftMark(
  manager: Pick<ManagerSummary, 'managerId' | 'lastReportAt' | 'lastReportStatus' | 'status'>,
  now: Date,
): string | null {
  const drift = describeReportDrift({
    managerId: manager.managerId,
    lastReportAt: manager.lastReportAt,
    lastReportStatus: manager.lastReportStatus,
    status: manager.status,
    now,
  });
  return drift === '' ? null : '⚠ status 食い違い（manager_report で詳細）';
}

type ManagerActivityFields = Pick<
  ManagerSummary,
  'turnEndReason' | 'turnEndedAt' | 'lastReportAt' | 'toolUseStallPending'
> & { waiting: readonly unknown[] };

function managerActivityInputOf(manager: ManagerActivityFields): ManagerActivityInput {
  return {
    turnEndReason: manager.turnEndReason,
    turnEndedAt: manager.turnEndedAt,
    lastReportAt: manager.lastReportAt,
    toolUseStallPending: manager.toolUseStallPending,
    waitingCount: manager.waiting.length,
  };
}

// 時刻を文字列比較しない: `turnEndedAt` は SDK が書いた形のままで、オフセット表記やミリ秒なしだと静かに間違えるため `Date.parse` の数値で比べる
// 比較できないときは「症状ではない」へ倒さず ⚠ 側へ落とす: 誤って黙る代償は止まった委譲が見つからないこと
export function describeTurnEnd(
  manager: ManagerActivityFields & Pick<ManagerSummary, 'turnEndTail'>,
): string | null {
  if (manager.turnEndReason === undefined) return null;

  if (classifyManagerActivity(managerActivityInputOf(manager)) !== 'stalled-turn-end') {
    return null;
  }

  if (manager.turnEndedAt === undefined) {
    return (
      '  ⚠ ターンは終わっているらしいが、いつ終わったかが分からない' +
      `（${manager.turnEndReason}。行に timestamp が無かった）。` +
      '**分からないだけで、症状ではないとは言えない** — 報告が届いたかどうかを' +
      'ここでは判定できない。まず manager_report を見ること（本文が空でも生ログから' +
      '拾える）、manager_transcript で生ログの全文が読める。' +
      RESTART_BEFORE_CHECK_ADVICE +
      'この委譲は止まっていない・切っていない — この助言はデーモンが計算しただけで、' +
      '委譲は動き続けてよい。'
    );
  }

  const stopSequenceNote =
    manager.turnEndReason === 'stop_sequence'
      ? '**枠の壁（利用上限）の可能性が高い** — 「報告が配られない」症状とは別の原因である。 '
      : '';
  const tailNote =
    manager.turnEndTail === undefined || manager.turnEndTail === ''
      ? ''
      : `末尾の抜粋: ${excerptLine(manager.turnEndTail, LIST_TURN_END_TAIL_EXCERPT)} `;
  return (
    `  ⚠ ターンは ${manager.turnEndedAt} に ${manager.turnEndReason} で終わっているが、` +
    '報告がまだ届いていない。' +
    stopSequenceNote +
    tailNote +
    'まず manager_report を見ること（本文が空でも生ログから拾える）、manager_transcript で' +
    '生ログの全文が読める。' +
    RESTART_BEFORE_CHECK_ADVICE +
    'この委譲は止まっていない・切っていない — この助言はデーモンが計算しただけで、' +
    '委譲は動き続けてよい。'
  );
}

// `waiting` が非空なら出さない: 確認は届いていてクローンがまだ答えていないだけの正常な状態で、⚠ を重ねると答えれば済むものが異常に見えるため
// 時刻の閾値を置かない: 置くとそれより短い窓の症状が出力から消えるため
// ⚠ 側の助言は「確かめること」で終えず、1つの手に着地させる: 確かめた後の分岐が読み手の記憶の中にしか無くなるため
export function describeToolUseStall(
  manager: ManagerActivityFields & Pick<ManagerSummary, 'toolUseStallAt'>,
): string | null {
  const pending = manager.toolUseStallPending;
  if (pending === undefined || pending.length === 0) return null;
  const activity = classifyManagerActivity(managerActivityInputOf(manager));
  if (activity !== 'stalled-tool-use' && activity !== 'tool-running') {
    return null;
  }

  const shown = pending.slice(0, LIST_TOOL_USE_STALL_LIMIT);
  const rest = pending.length - shown.length;
  const names = shown.map((item) => `${item.name ?? '（name 不明）'}(${item.id})`).join(' / ');
  // `toolUseStallAt` が無い形を潰さない: 行に `timestamp` が無かっただけで、矛盾（または実行中）は成立しているため
  const whenNote =
    manager.toolUseStallAt === undefined
      ? 'その行に timestamp が無かったので、いつからかは分からない'
      : `その行の timestamp は ${manager.toolUseStallAt}`;
  const countNote =
    `未応答の道具: ${names}` +
    (rest > 0 ? `（ほか ${rest} 件、全 ${pending.length} 件）` : '') +
    `。${whenNote}。`;

  if (activity === 'tool-running') {
    return (
      '  道具を実行中（矛盾ではない）。' +
      '生ログの末尾の assistant 行が stop_reason: tool_use で、対応する tool_result が生ログに無く、' +
      'デーモン側の返事待ち（waiting）も空だが、未応答の道具はどれも応答をデーモンだけが返す種類' +
      '（AskUserQuestion 等）ではない — 既定の permissionMode: auto ではこれらの道具の確認は' +
      'デーモンへ届かない（SDK 自身が応答を待つ）ので、waiting が空なのは矛盾ではない。' +
      countNote +
      '**時刻の閾値は置いていない** — 何分経ったかはこの行では判定していない。' +
      'この行そのものは何も止めていない — 委譲は動き続けてよい。急かさず、次の一覧まで待つこと。'
    );
  }

  return (
    '  ⚠ 道具の応答待ちのまま、誰もその応答を待っていない（矛盾）。' +
    `生ログの末尾の assistant 行が stop_reason: tool_use で、対応する tool_result が生ログに無く、` +
    `かつデーモン側の返事待ち（waiting）が空である。` +
    countNote +
    '**時刻の閾値は置いていない** — 何分経ったかはこの行では判定していないので、' +
    'timestamp を読んで判断すること。' +
    'この行そのものは何も止めていない — デーモンが計算して添えただけで、委譲は動き続けてよい。' +
    '次の一手は上から順に見て、当たったところで止まる: ' +
    '(1) この委譲の状態が running 以外（done / failed / lost / stopped / waiting_human）なら、' +
    'この行は読み捨てる — この旗を書き換える探りは running のものしか訪ねないので、' +
    'running を離れた時点の値がそのまま凍っている。' +
    '(2) running なら manager_transcript で生ログの末尾を読む — 長いので、' +
    'まず大きすぎる offset を渡して「全 N 文字」だけを受け取り、' +
    '次に offset を N の1ページぶん手前にして末尾を取る（2手）。' +
    '(3) その末尾に isApiErrorMessage: true の行（この repo ではなく CLI が生ログへ書く欄。' +
    '枠の壁などで API が返した文言を合成した行）が在れば、この委譲は既に死んでいる — ' +
    'manager_stop して引き継ぐこと。' +
    '(4) それが無いなら、確認がクローンの受信箱に一度も現れない症状そのものである。' +
    '確認の本文を生ログから写して Issue へ置いてから manager_stop して引き継ぐこと' +
    '（写さずに止めると、質問は誰にも読まれないまま消える）。' +
    RESTART_BEFORE_CHECK_ADVICE
  );
}

function assertNeverTokenGenerationUnknownReason(reason: never): never {
  throw new Error(`未知の認証トークン世代の不明理由: ${JSON.stringify(reason)}`);
}

// `manager_stop` → `manager_start` の対処を他の2つに書かない: 効かない手順を勧めることになるため
function describeTokenGenerationUnknownReason(reason: TokenGenerationUnknownReason): string {
  switch (reason) {
    case 'pool-not-wired':
      return (
        '  認証トークンの世代: 分からない（このデプロイは認証トークンの世代そのものを' +
        '配線していない構成。全ての委譲について同じ理由で分からない——この委譲固有の' +
        '問題ではなく、manager_stop → manager_start で起こし直しても変わらない）。'
      );
    case 'not-yet-observed':
      return (
        '  認証トークンの世代: 分からない（この委譲のセッションが、いまのデーモンの' +
        'プロセスではまだ一度も起きていない。start・明示的な resume・認証トークンの' +
        '回転のどれかが起きれば次の一覧から埋まる——いま何もしなくてよい）。'
      );
    case 'reattached-across-restart':
      return (
        '  認証トークンの世代: 分からない（デーモンの再起動をまたいで、runner に生きた' +
        'ままのセッションを引き取った。引き取っただけではこのセッションの環境変数に' +
        '触れていないので、抱えている世代を確かめる材料が無い——一致でも不一致でもない、' +
        '正直な「分からない」である）。この委譲へ daemon が次に明示的に触れば' +
        '（送信・回転のどちらでも）自動で埋まるが、429 が続くなど気になるようなら' +
        `起こし直すこと。${STALE_TOKEN_RESTART_ADVICE}`
      );
    default:
      return assertNeverTokenGenerationUnknownReason(reason);
  }
}

// 健全（世代が一致）でも `null` を返さない: 説明文で「出す」と約束している値そのものなため
function describeTokenGeneration(manager: ManagerSummary): string | null {
  if (manager.tokenGeneration === undefined) {
    return manager.tokenGenerationUnknownReason === undefined
      ? null
      : describeTokenGenerationUnknownReason(manager.tokenGenerationUnknownReason);
  }
  if (manager.activeTokenGeneration === undefined) {
    // 0 や「一致」を捏造しない: 比べる相手がいま取れないため
    return `  認証トークンの世代: ${manager.tokenGeneration}（現役は不明——比べられない）`;
  }
  if (!tokenGenerationMismatched(manager)) {
    return `  認証トークンの世代: ${manager.tokenGeneration}（現役と一致）`;
  }
  // セッションの終わった委譲には ⚠ を出さない（#4857）: 走っているセッションが無いので「古い鍵で走り続けている」は事実に反し、鍵が回るたびに一覧が終わった委譲の ⚠ で埋まる。done はセッションが生きて待っていることがあるので対象にしない
  if (manager.status === 'stopped' || manager.status === 'failed' || manager.status === 'lost') {
    return (
      `  認証トークンの世代: ${manager.tokenGeneration}（現役は世代 ${manager.activeTokenGeneration}。` +
      `この委譲のセッションは終わっている（status=${manager.status}）ので、古い鍵で走ってはいない。起こし直すと新しい鍵で起きる）`
    );
  }
  return (
    `  ⚠ 認証トークンの世代が食い違っている（世代 ${manager.tokenGeneration} を抱えたまま、` +
    `現役は世代 ${manager.activeTokenGeneration}）。この委譲のセッションが、` +
    'ターンの境界（確認待ち・背景処理が無い状態）に一度も達しないまま古い鍵で走り続けている' +
    '可能性がある（認証トークンを回した直後は、次のターンの境界に達するまでの短い遅れとして' +
    '普通に起こる——それ自体は症状ではない）。' +
    describeBackgroundTasksForStaleToken(manager) +
    '委譲が done なら、manager_send の時点で畳んで新しい鍵で起こし直す' +
    '（背景処理・確認待ちが残っていれば断る）。' +
    '背景処理・確認待ちが無いのにこの行が消えないまま 429 が続くようなら、' +
    `起こし直すこと。${STALE_TOKEN_RESTART_ADVICE}`
  );
}

// `undefined` は 0 本と言わず「分からない」と言う: 古い runner は欄を返さないため
function describeBackgroundTasksForStaleToken(manager: ManagerSummary): string {
  if (manager.liveBackgroundTasks === undefined) {
    return 'runner が見ている背景処理の本数は分からない（まだ聞けていない、または古い runner）。';
  }
  return manager.liveBackgroundTasks === 0
    ? 'runner が最後に見た背景処理は 0 本。'
    : `runner が最後に見た背景処理は ${manager.liveBackgroundTasks} 本（残っていると境界に達せず、自動では畳み直されない）。`;
}

// `describeTokenGeneration` と同じ行で ⚠ を二重に鳴らさない: 同じ結論を読み手が2回読むことになるため
// 「判定できない」を「世代ずれではない」へ倒さない: 材料が無いことは「健全」の証明ではないため
function describeResetTimeSkew(manager: ManagerSummary): string | null {
  if (
    manager.tokenGeneration !== undefined &&
    manager.activeTokenGeneration !== undefined &&
    manager.tokenGeneration !== manager.activeTokenGeneration
  ) {
    return null;
  }
  if (manager.resetTimeSkewMatch === 'stale') {
    return (
      '  ⚠ 認証トークンの世代ずれの疑い（429の文言に書かれていた resets 時刻が、' +
      '現役ではない鍵の冷却期限と一致した）。このセッションは古い鍵を掴んだまま' +
      '走っている可能性がある——鍵が通る状態へ戻っても、このセッション自身は' +
      'ターンの境界に達するまで戻らない。' +
      'この行が消えないまま 429 が続くようなら、' +
      `起こし直すこと。${STALE_TOKEN_RESTART_ADVICE}`
    );
  }
  if (manager.resetTimeSkewMatch === 'active') {
    return (
      '  認証トークン: 429の文言に書かれていた resets 時刻が、現役の鍵自身の' +
      '冷却期限と一致した——世代ずれではなく、待てば戻る。'
    );
  }
  return null;
}

function unpushedWorkObservationIncompleteSuffix(
  observation: Extract<LastUnpushedWorkObservation, { kind: 'observed' }>,
): string {
  const note = describeUnpushedWorkObservationIncompleteness(observation);
  return note === null ? '' : `\n  ${note}`;
}

// 一覧では外へ出した成果も退避 ref も件数と最後の1件だけにする: 一覧は予算で打ち切られ、1件の委譲が最大20行を取ると出る委譲の数が減るため。全件は `manager_report` が出す
function describeUnpushedWorkObservation(
  manager: ManagerSummary,
  outputs: 'brief' | 'full' | 'report' = 'brief',
  now?: Date,
): string | null {
  const lines = [
    describeUnpushedWorkObservationOnly(manager),
    describeRescue(manager, outputs, now),
    describeRescueStash(manager),
    // 'report' でも外へ出した成果は畳まない: 畳むのは退避 ref だけで、成果の記録は件数が上限で締まっている
    describeExternalOutputs(manager, outputs === 'report' ? 'full' : outputs),
    describeHeldMessages(manager),
  ].filter((line): line is string => line !== null);
  return lines.length === 0 ? null : lines.join('\n');
}

// 一覧で見えないと、クローンは届いたかを台帳で手書きで追い、送り直して二重に届ける（預かりそのものの理由と同じ）
export function describeHeldMessages(manager: ManagerSummary): string | null {
  const held = manager.heldMessages;
  if (held === undefined) return null;
  const expiresAt = new Date(Date.parse(held.oldestHeldAt) + HELD_MESSAGE_TTL_MS).toISOString();
  return (
    `  預かっている伝言（manager_send が届けられなかった分）: ${String(held.count)} 通` +
    `（最初の預かり ${held.oldestHeldAt}・その期限 ${expiresAt}）。` +
    '届けられるようになったら自動で届けて知らせる。送り直さないこと（二重に届く）'
  );
}

function formatExternalOutput(output: ExternalOutput): string {
  return (
    `${output.kind}: ${output.where}` +
    (output.summary === undefined ? '' : `（${output.summary}）`) +
    `、${output.at}`
  );
}

export function describeExternalOutputs(
  manager: ManagerSummary,
  mode: 'brief' | 'full',
): string | null {
  const outputs = manager.externalOutputs;
  if (outputs === undefined || outputs.length === 0) return null;
  const head = `  外へ出した成果（マネージャーの記録。直近 ${String(externalOutputLimits.keptPerJob)} 件まで）`;
  if (mode === 'brief') {
    const last = outputs[outputs.length - 1];
    return `${head}: ${String(outputs.length)} 件。最後: ${last === undefined ? '' : formatExternalOutput(last)}`;
  }
  return [`${head}:`, ...outputs.map((output) => `    ${formatExternalOutput(output)}`)].join('\n');
}

const RESCUE_REMOVAL_REASON_TEXT: Record<RescueRemovalReason, string> = {
  landed: '内容が origin の枝に入っていた',
  done: '委譲が done のまま猶予を過ぎた',
  failed: '委譲が failed のまま猶予を過ぎた',
  stopped: '委譲が stopped のまま猶予を過ぎた',
};

// 在りかを辿れるように件数と合計を出す。パスは出さない（担当へは器が入れ替わった後の知らせと `rescue_restore` の返事が運ぶ）
export function describeRescueStash(manager: ManagerSummary): string | null {
  const stash = manager.rescueStash;
  if (stash === undefined) return null;
  return (
    `  預かっている未追跡のファイル（デーモンの置き場。猶予は退避 ref と同じ）: ${String(stash.count)} 件・合計 ${String(stash.totalBytes)} バイト` +
    `（最後の預かり ${stash.latestAt}）。器が入れ替わった後、担当は rescue_restore で取り戻せる`
  );
}

type RescuePushed = NonNullable<
  NonNullable<ManagerSummary['lastRescue']>['worktrees'][number]['pushed']
>;

function describeRescuePushed(pushed: RescuePushed): string {
  const removal = pushed.removal;
  // 消した ref を「在る」と読ませない
  const state =
    removal === undefined
      ? ''
      : removal.failureKind === 'no-remote'
        ? '・送り先が台帳に無いので自動では消せない（手で消す）'
        : removal.failureKind === undefined
          ? `・${removal.at} に消した（${RESCUE_REMOVAL_REASON_TEXT[removal.reason]}）`
          : `・消せなかった（${removal.failureKind}。${removal.at} 時点で ${String(removal.attempts ?? 1)} 回目。次の機会に再試行する）`;
  return `${pushed.ref}（${pushed.commit.slice(0, 8)}, ${pushed.at}${state}）`;
}

// 一覧（brief）は件数と最新の1件だけにする: 作業ツリーごとに数行が付くと1件の委譲が予算を占有し、出る委譲の数が減って頁をめくらされるため。全部は `manager_report`（full）が出す
// 退避されなかったもの（push 失敗・未追跡・submodule）は件数だけ残す: 消すと「全部退避できた」と読めるため
// いまの器で、送るものが在るのに送れていない作業ツリー（#5117）。`goneAt` の行と、前の器の行（最新の行と `instanceId` が違う）は外す: 担当に push を促しても届かない分のため
function stuckRescueTrees(rescue: NonNullable<ManagerSummary['lastRescue']>): RescueTree[] {
  const newest = rescue.worktrees.reduce<RescueTree | undefined>(
    (best, tree) => (best === undefined || tree.at > best.at ? tree : best),
    undefined,
  );
  return rescue.worktrees.filter(
    (tree) =>
      tree.notPushed !== undefined &&
      tree.notPushed.reason !== 'nothing-tracked' &&
      tree.goneAt === undefined &&
      tree.instanceId === newest?.instanceId,
  );
}

function rescueNotPushedSinceOf(tree: RescueTree): string {
  return tree.notPushed?.since ?? tree.at;
}

// 一覧には、いちばん長く続いている1本と残りの本数だけを出す: 作業ツリーごとに並べると1件の委譲が予算を占有するため（`describeRescueBrief` と同じ理由）
function describeStuckRescueBrief(
  rescue: NonNullable<ManagerSummary['lastRescue']>,
  now: Date | undefined,
): string {
  const stuck = stuckRescueTrees(rescue);
  const oldest = stuck.reduce<RescueTree | undefined>(
    (best, tree) =>
      best === undefined || rescueNotPushedSinceOf(tree) < rescueNotPushedSinceOf(best)
        ? tree
        : best,
    undefined,
  );
  if (oldest?.notPushed === undefined) return '';
  const since = rescueNotPushedSinceOf(oldest);
  const elapsed =
    now === undefined
      ? ''
      : `・${formatElapsedAgo(since, now.getTime()).replace(/前$/, '')}続いている`;
  const rest = stuck.length > 1 ? ` ほか ${String(stuck.length - 1)} 本` : '';
  // too-large と secret-like は、担当が push すれば退避そのものが要らなくなる: 消える前に声を掛けられるよう、取れる手を添える
  const hint =
    oldest.notPushed.reason === 'too-large' || oldest.notPushed.reason === 'secret-like'
      ? '。担当が push すれば消えずに済む'
      : '';
  return (
    `。退避できていない: ${oldest.relativePath}（${oldest.notPushed.reason}。${since} から${elapsed}）${rest}` +
    hint
  );
}

function describeRescueBrief(
  rescue: NonNullable<ManagerSummary['lastRescue']>,
  now?: Date,
): string {
  const pushedTrees = rescue.worktrees.filter((tree) => tree.pushed !== undefined);
  const latest = pushedTrees.reduce<RescuePushed | undefined>(
    (best, tree) =>
      tree.pushed !== undefined && (best === undefined || tree.pushed.at > best.at)
        ? tree.pushed
        : best,
    undefined,
  );
  const unsavedTrees = rescue.worktrees.filter(
    (tree) =>
      tree.notPushed !== undefined ||
      tree.untracked !== undefined ||
      tree.submoduleCount !== undefined,
  ).length;
  const refs =
    latest === undefined
      ? '0 本'
      : `${String(pushedTrees.length)} 本（最新: ${describeRescuePushed(latest)}）`;
  const unsaved =
    unsavedTrees === 0 ? '' : `。退避されなかったものがある作業ツリー ${String(unsavedTrees)} 本`;
  return `  退避 ref ${refs}${unsaved}${describeStuckRescueBrief(rescue, now)}（走行中に自動で push。${rescue.at} に最後に更新。全部は manager_report を rescueAll: true で読む）`;
}

type RescueTree = NonNullable<ManagerSummary['lastRescue']>['worktrees'][number];

// manager_report の既定は件数に畳む。畳まないのは、退避できていない（push 失敗・未追跡・submodule で、失われうる）作業ツリーの存在だけ:
// 件数と代表の1本を必ず残す。生きている ref・消せなかった ref・生きている間に消えた作業ツリーは、読み手が何もできないか、ref 名が要るのは取り戻すときだけなので件数でよい（#5028 の続き）
// 軸は独立に数える（排他の分類にしない）: 作業ツリーが消えても、退避できていないものが在っても、ref が残っていれば「生きている ref」に数えるため
function isUnsavedRescueTree(tree: RescueTree): boolean {
  return (
    tree.untracked !== undefined ||
    tree.submoduleCount !== undefined ||
    (tree.notPushed !== undefined && tree.notPushed.reason !== 'nothing-tracked')
  );
}

function hasLiveRescueRef(tree: RescueTree): boolean {
  const removal = tree.pushed?.removal;
  return tree.pushed !== undefined && (removal === undefined || removal.failureKind !== undefined);
}

function describeRescueTreeRows(tree: RescueTree): string[] {
  const rows: string[] = [];
  const parts: string[] = [];
  if (tree.pushed !== undefined) {
    parts.push(describeRescuePushed(tree.pushed));
  } else {
    parts.push('退避された ref は無い');
  }
  if (tree.notPushed !== undefined) {
    parts.push(
      `直近の回: ${RESCUE_NOT_PUSHED_TEXT[tree.notPushed.reason]}${rescueNotPushedDetail(tree.notPushed)}` +
        (tree.notPushed.since === undefined || tree.notPushed.reason === 'nothing-tracked'
          ? ''
          : `（${tree.notPushed.since} から続いている）`),
    );
  }
  // 消さず印を添える: 台帳の項目は退避の記録そのもので、生きている間に消えた作業ツリーの ref も取り戻す材料として残す
  if (tree.goneAt !== undefined) {
    parts.push(`生きている間に消えた（観測 ${tree.goneAt}）`);
  }
  rows.push(`    ${tree.relativePath}: ${parts.join('。')}`);
  const unsaved: string[] = [];
  if (tree.untracked !== undefined) {
    const shown = tree.untracked.paths.slice(0, 5).join(', ');
    const rest = tree.untracked.count - Math.min(5, tree.untracked.paths.length);
    unsaved.push(
      `未追跡 ${tree.untracked.count} 件（${shown}${rest > 0 ? ` ほか ${rest} 件` : ''}）`,
    );
  }
  if (tree.submoduleCount !== undefined) {
    unsaved.push(`submodule ${tree.submoduleCount} 本（中の変更は退避されない）`);
  }
  if (unsaved.length > 0) rows.push(`      退避されなかったもの: ${unsaved.join('、')}`);
  return rows;
}

// 代表は、いまも担当が手を打てる（消えていない）ものの中でいちばん長く続いているもの。無ければ消えたものから選ぶ
function representativeUnsavedTree(unsaved: RescueTree[]): RescueTree | undefined {
  const pool = unsaved.some((tree) => tree.goneAt === undefined)
    ? unsaved.filter((tree) => tree.goneAt === undefined)
    : unsaved;
  return pool.reduce<RescueTree | undefined>(
    (best, tree) =>
      best === undefined || rescueNotPushedSinceOf(tree) < rescueNotPushedSinceOf(best)
        ? tree
        : best,
    undefined,
  );
}

function describeRescueReport(rescue: NonNullable<ManagerSummary['lastRescue']>): string[] {
  const trees = rescue.worktrees;
  const unsaved = trees.filter(isUnsavedRescueTree);
  const liveTrees = trees.filter(hasLiveRescueRef);
  const rest = trees.filter((tree) => !hasLiveRescueRef(tree));
  const goneWithRef = liveTrees.filter((tree) => tree.goneAt !== undefined).length;
  const stuckFailed = liveTrees.filter(
    (tree) => tree.pushed?.removal !== undefined && tree.pushed.removal.failureKind !== 'no-remote',
  ).length;
  const noRemote = liveTrees.filter(
    (tree) => tree.pushed?.removal?.failureKind === 'no-remote',
  ).length;
  // ref が無い側の内訳: 消し終えた ref は理由ごと、消えた作業ツリーで ref が最初から無いもの、送るもの無し
  const goneNoRef = rest.filter(
    (tree) => tree.goneAt !== undefined && tree.pushed === undefined,
  ).length;
  const nothing = rest.filter(
    (tree) => tree.goneAt === undefined && tree.pushed === undefined && !isUnsavedRescueTree(tree),
  ).length;
  const removedGroups = (Object.keys(RESCUE_REMOVAL_REASON_TEXT) as RescueRemovalReason[])
    .map((reason) => ({
      reason,
      count: rest.filter((tree) => tree.pushed?.removal?.reason === reason).length,
    }))
    .filter((group) => group.count > 0)
    .map((group) => `${RESCUE_REMOVAL_REASON_TEXT[group.reason]} ${String(group.count)} 本`);
  const latestLive = liveTrees.reduce<RescuePushed | undefined>(
    (best, tree) =>
      tree.pushed !== undefined && (best === undefined || tree.pushed.at > best.at)
        ? tree.pushed
        : best,
    undefined,
  );
  const counts = [
    latestLive === undefined
      ? null
      : `生きている ref ${String(liveTrees.length)} 本（最新: ${describeRescuePushed(latestLive)}）` +
        (goneWithRef === 0
          ? ''
          : `・うち作業ツリーが生きている間に消えて ref だけ残っている ${String(goneWithRef)} 本（取り戻す材料）`) +
        (stuckFailed === 0 ? '' : `・うち消せなかった ${String(stuckFailed)} 本`) +
        (noRemote === 0
          ? ''
          : `・うち送り先が台帳に無く自動では消せない ${String(noRemote)} 本（手で消す）`),
    removedGroups.length === 0 ? null : `消した ref: ${removedGroups.join('・')}`,
    goneNoRef === 0 ? null : `生きている間に消えた（ref は無い） ${String(goneNoRef)} 本`,
    nothing === 0 ? null : `送るもの無し ${String(nothing)} 本`,
  ].filter((part): part is string => part !== null);
  const lines = [
    `  退避 ref（走行中に自動で push。${rescue.at} に最後に更新）: 作業ツリー ${String(rescue.worktrees.length)} 本`,
  ];
  if (counts.length > 0) lines.push(`    ${counts.join('、')}`);
  const representative = representativeUnsavedTree(unsaved);
  if (representative !== undefined) {
    // 種類ごとの本数も添える: 代表の1本だけだと、残りが別の種類（too-large など担当が打てる手が違うもの）でも見えないため
    const causeCounts = new Map<string, number>();
    for (const tree of unsaved) {
      const causes = [
        tree.notPushed !== undefined && tree.notPushed.reason !== 'nothing-tracked'
          ? RESCUE_NOT_PUSHED_TEXT[tree.notPushed.reason]
          : null,
        tree.untracked === undefined ? null : '未追跡',
        tree.submoduleCount === undefined ? null : 'submodule',
      ];
      for (const cause of causes) {
        if (cause !== null) causeCounts.set(cause, (causeCounts.get(cause) ?? 0) + 1);
      }
    }
    const causes = [...causeCounts].map(([cause, count]) => `${cause} ${String(count)}`).join('・');
    lines.push(
      `    ⚠ 退避できていない作業ツリー ${String(unsaved.length)} 本（失われうる。${causes}）。代表の1本:`,
      ...describeRescueTreeRows(representative).map((row) => `  ${row}`),
    );
  }
  lines.push('    全部は manager_report を rescueAll: true で読む');
  return lines;
}

export function describeRescue(
  manager: ManagerSummary,
  mode: 'brief' | 'full' | 'report' = 'full',
  now?: Date,
): string | null {
  const rescue = manager.lastRescue;
  if (rescue === undefined || rescue.worktrees.length === 0) return null;
  if (mode === 'brief') return describeRescueBrief(rescue, now);
  if (mode === 'report') return describeRescueReport(rescue).join('\n');
  const lines = [`  退避 ref（走行中に自動で push。${rescue.at} に最後に更新）:`];
  for (const tree of rescue.worktrees) lines.push(...describeRescueTreeRows(tree));
  return lines.join('\n');
}

// `cwd`（探索の起点の絶対パス）は載せない: 絶対パスそのものは出さない線を、この欄の写しにも適用するため
// 時刻だけを出さず、観測自身の `source` から出どころを行の中に書く: 読み手が「いまの状態」と誤読するため
// 観測が `undefined` でも器の入れ替えで応答不能な分岐では `null` を返さない: 「0件」と「沈黙」が読み手から区別できなくなるため
function describeUnpushedWorkObservationOnly(manager: ManagerSummary): string | null {
  const observation = manager.lastUnpushedWorkObservation;

  if (manager.sessionMissingSince !== undefined) {
    if (manager.shutdownObservationArrivedAfterSwap === true && observation !== undefined) {
      if (observation.kind === 'unavailable') {
        return (
          `  未push観測: 器が止まる直前（${observation.at}）に取ろうとしたが取れなかった: ` +
          observation.reason
        );
      }
      if (isEmptyCompleteUnpushedWorkObservation(observation)) return null;
      return (
        `  未push観測: 器が止まる直前（${observation.at}）の観測: ` +
        formatUnpushedWorkObservationWorktrees(observation.worktrees) +
        unpushedWorkObservationIncompleteSuffix(observation)
      );
    }
    const shown =
      observation === undefined
        ? '表示中の観測は無い（一度も取れていない）'
        : observation.kind === 'unavailable'
          ? `表示中の観測は ${observation.at} 時点・${describeUnpushedWorkObservationSource(observation.source)} のもの（取れなかった: ${observation.reason}）`
          : `表示中の観測は ${observation.at} 時点・${describeUnpushedWorkObservationSource(observation.source)} のもの: ${formatUnpushedWorkObservationWorktrees(observation.worktrees)}` +
            unpushedWorkObservationIncompleteSuffix(observation);
    return `  ${UNPUSHED_WORK_SHUTDOWN_OBSERVATION_NOT_ARRIVED_NOTE}` + shown;
  }

  if (observation === undefined) return null;
  if (isEmptyCompleteUnpushedWorkObservation(observation)) return null;
  const provenance = describeUnpushedWorkObservationProvenance(observation.source, 'manager_list');
  if (observation.kind === 'unavailable') {
    return (
      `  未push観測（${provenance}）: 取れなかった（${observation.at}）: ` + observation.reason
    );
  }
  return (
    `  未push観測（${provenance}、${observation.at}）: ` +
    formatUnpushedWorkObservationWorktrees(observation.worktrees) +
    unpushedWorkObservationIncompleteSuffix(observation)
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

/** `manager_list` の行に出す、委譲の起点の会話。 */
type JobOrigins = { kind: 'read'; byId: ReadonlyMap<string, Job> } | { kind: 'unreadable' };

async function readJobOrigins(stores: Stores): Promise<JobOrigins> {
  try {
    return {
      kind: 'read',
      byId: new Map((await stores.jobs.listJobs()).map((job) => [job.id, job])),
    };
  } catch {
    return { kind: 'unreadable' };
  }
}

function describeJobOrigin(origins: JobOrigins, managerId: string): string {
  if (origins.kind === 'unreadable') {
    return '  起点の会話: 分からない（台帳を読めなかった。起点が無いという意味ではない）';
  }
  const job = origins.byId.get(managerId);
  if (job === undefined) {
    return '  起点の会話: 分からない（台帳にこの委譲が見つからない。起点が無いという意味ではない）';
  }
  // 「結び付いた task へ」と出すのは taskId があるときだけ。無い委譲は task_list で探す・task_add で足す手順
  const hint = job.taskId === undefined ? ORIGIN_HINT_NO_TASK_FULL : ORIGIN_HINT_FULL;
  const origin =
    job.conversationId === undefined
      ? '  起点の会話: 無し（会話の外で起こした委譲）'
      : `  起点の会話: ${job.conversationId}${hint}`;
  return job.taskId === undefined
    ? origin
    : `${origin}\n  結び付いた task: ${job.taskId}（task_say で書ける。task_list で読める）`;
}

// `status === 'lost'` を直に書かず `digest.ts` の述語から組み立てる: 書き下ろすと分け方が割れるため
// 2つの述語を1つに畳まない: `isManagerInFlight` へ `lost` を足すと日報の `MAX_ITEMS` の枠を食って最近終わった委譲が押し出される。
// 群の数はこの一覧の側の判断であって、述語の側の判断ではない
// 順位を数にする: `if` の連鎖だとどの2つの比較が抜けても「たまたま並ぶ」になるため
function managerAttentionRank(status: JobStatus): 0 | 1 | 2 {
  if (isManagerInFlight(status)) return 0;
  // `lost` は終端だが、その他の終端より先に出す: 確かめるまで終われず、窓から落ちると id が本文に出ず名指しもできないため
  if (isManagerAwaitingJudgement(status)) return 1;
  return 2;
}

// 判定は `digest.ts` の純関数から取る: `lastReport === undefined` を書き下ろすと分け方が字面の側と割れ、「順位は先頭なのに文は delivered と言う」形が黙って作れるため
function managerJudgementRank(entry: ManagerSummary): 0 | 1 | 2 {
  const outcome = classifyUnobservedOutcome(entry);
  return outcome === null ? JUDGEMENT_RANK_NOT_APPLICABLE : outcome.rank;
}

// `q` が当たる文: 依頼文・managerId・直近の報告の本文・未 push の観測にある枝の名前。
// 枝は `branch` が null（detached HEAD など）の行を飛ばす。`unavailable` の観測は枝を持たない
function managerQueryHaystacks(manager: ManagerSummary): string[] {
  const observation = manager.lastUnpushedWorkObservation;
  return [
    manager.request,
    manager.managerId,
    ...(manager.lastReport === undefined ? [] : [manager.lastReport]),
    ...(observation?.kind === 'observed'
      ? observation.worktrees.flatMap((worktree) =>
          worktree.branch === null ? [] : [worktree.branch],
        )
      : []),
  ];
}

// NFKC の後に小文字へ: 順序を逆にすると、小文字化で字形が変わる全角英字が半角へ揃う前に素通りするため
function normalizeManagerQuery(value: string): string {
  return value.normalize('NFKC').toLowerCase().trim();
}

function managerPositionOf(entry: ManagerSummary): ManagerPosition {
  return {
    rank: managerAttentionRank(entry.status),
    judgementRank: managerJudgementRank(entry),
    startedAt: entry.startedAt,
    managerId: entry.managerId,
  };
}

// `ManagerPool.list()` 側を並べ替えて解かない: HTTP の窓の錨と `order` を足さないという判断があの並びに乗っているため
// 並び替えと cursor は `compareManagerPosition` を共有する: 別々に書くと片方だけがずれたときに黙って行が飛ぶため
function compareManagerAttention(a: ManagerSummary, b: ManagerSummary): number {
  return compareManagerPosition(managerPositionOf(a), managerPositionOf(b));
}

// 1応答に最大5回出る RESTART_BEFORE_CHECK_ADVICE（件数の行の lost・消失、印の意味、失敗の行ごと）を、初出の1回だけ全文にする。
// 2回目以降は結論（確かめる前に起こし直さない）を短く残して「上と同じ」と言う: 行ごとの失敗の説明は別の行として読まれるため、消さずに短くする
const RESTART_ADVICE_AGAIN = '**確かめる前に起こし直さないこと**（上と同じ）。';

function dedupeRestartAdvice(response: string): string {
  const first = response.indexOf(RESTART_BEFORE_CHECK_ADVICE);
  if (first < 0) return response;
  const head = first + RESTART_BEFORE_CHECK_ADVICE.length;
  return (
    response.slice(0, head) +
    response.slice(head).replaceAll(RESTART_BEFORE_CHECK_ADVICE, RESTART_ADVICE_AGAIN)
  );
}

// 行の中の固定の一文（起点の会話の使い方・lost などの行の「本文は届いているが…」）を、出ている行だけ畳む。
// 行を組む時点では畳まない: 予算で出ない行が先に「全文を出した」と控えられ、会話の上に無い全文を参照してしまうため。
// 畳むのは `manager_list` が組んだ行の形に厳密に合う行だけ: 報告の抜粋の中に同じ字面が在っても書き換えないため。
// 1応答の中の2行目以降も参照になる（`fold` は id ごとに最初の1回だけ全文を返す）
const ORIGIN_HINT_FULL = '（報告を人間へ知らせるなら、結び付いた task へ task_say で書く）';

const ORIGIN_HINT_REF = '（知らせるなら結び付いた task へ task_say）';

// 委譲に task が結び付いていないとき
const ORIGIN_HINT_NO_TASK_FULL =
  '（報告を人間へ知らせるなら、この会話を起点にした task を task_list で探して task_say で書く。無ければ task_add で足す）';

const ORIGIN_HINT_NO_TASK_REF =
  '（知らせるなら task_list で探した task へ task_say。無ければ task_add）';

const ORIGIN_LINE_PREFIX = '  起点の会話: ';

const UNOBSERVED_NONE_LINE = `  ${describeReportState('none')}`;

const UNOBSERVED_NONE_REF =
  '  ⚠ 終端までに本文が1文字も届いていない（何をしたかはこの一覧から読めない。全文は最初の一覧のとおり）。';

const UNOBSERVED_DELIVERED_LINE = `  ${describeReportState('delivered')}`;

const UNOBSERVED_DELIVERED_REF =
  '  ⚠ 本文は届いているが、完遂した報告とは限らない（台帳では区別できない。理由は最初の一覧のとおり）。';

function foldRowPhrases(response: string, fold: FixedFold): string {
  return response
    .split('\n')
    .map((line) => {
      if (line === UNOBSERVED_NONE_LINE) {
        return fold('manager-list:row-unobserved-none', line, UNOBSERVED_NONE_REF);
      }
      if (line === UNOBSERVED_DELIVERED_LINE) {
        return fold('manager-list:row-unobserved-delivered', line, UNOBSERVED_DELIVERED_REF);
      }
      if (line.startsWith(ORIGIN_LINE_PREFIX) && line.endsWith(ORIGIN_HINT_FULL)) {
        return (
          line.slice(0, line.length - ORIGIN_HINT_FULL.length) +
          fold('manager-list:row-origin-hint', ORIGIN_HINT_FULL, ORIGIN_HINT_REF)
        );
      }
      if (line.startsWith(ORIGIN_LINE_PREFIX) && line.endsWith(ORIGIN_HINT_NO_TASK_FULL)) {
        return (
          line.slice(0, line.length - ORIGIN_HINT_NO_TASK_FULL.length) +
          fold(
            'manager-list:row-origin-hint-no-task',
            ORIGIN_HINT_NO_TASK_FULL,
            ORIGIN_HINT_NO_TASK_REF,
          )
        );
      }
      return line;
    })
    .join('\n');
}

// 件数の行の固定の読み方。2回目から参照にする（`describeManagerCounts`）。参照にも要点（読み違えると打つ手が変わる点）を残す
const COUNTS_RUNNING_FULL =
  '**「走行中」は「進んでいる」ではない** — 宛先の器が黙って消えても ' +
  'status は running のままで、それを終端へ動かす経路はデーモンに無い。' +
  'いま何本動いているかを数えるなら、走行中の本数ではなく' +
  '「話しかけられる」ほうを見ること。';

const COUNTS_RUNNING_REF =
  '（読み方は前の一覧の全文のとおり: 「走行中」は「進んでいる」ではない。動いている本数は「話しかけられる」ほうで数える）';

const COUNTS_LOST_FULL =
  ' **「戻れなかった(lost)」は「終わった」ではない** — 前のセッションへ戻れたかだけを' +
  '見ていて、成果が既に外へ出ていることがある（PR・コミット・送信済みのメール・登録済みの予定・投稿先など）。' +
  'この一覧の本文は文字数の予算で切れるので、名指しで引くなら status: ["lost"] を渡すこと' +
  '（絞りは予算より前に効く）。' +
  // 残りへ辿る綴りは `lost` が在るときだけ置く: 「全部見た」と読みかけるときだけで、それぞれの行には既に ⚠ が付くため
  '**ただし lost を全部確かめても、落ちた委譲を全部見たことにはならない** — ' +
  '宛先の器が黙って消えた委譲は running のまま残り、直近のターンが失敗で終わった委譲は ' +
  'done のまま残る。前者は status: ["running"]、後者は status: ["done"] で引き、' +
  '行に付く ⚠ を見ること。' +
  RESTART_BEFORE_CHECK_ADVICE;

const COUNTS_LOST_REF =
  ' （lost は「終わった」ではなく、成果が外へ出ていることがある。名指しは status: ["lost"]。' +
  '全部ではない: running のまま残る委譲は status: ["running"]、失敗で終わった委譲は status: ["done"] で引き、行の ⚠ を見る。' +
  `${RESTART_BEFORE_CHECK_ADVICE_CORE}。全文は最初の一覧のとおり）`;

const COUNTS_USAGE_STOPPED_FULL =
  ' **「枠(利用上限)で止まっている」は status の分割ではなく横断する軸である** — ' +
  '走行中・返事待ち・戻れなかった(lost)・手が空いている（done）等のどれとも重なりうるので、' +
  '上の内訳には足し合わせない。名指しで絞る綴りは無い（`status` の値ではないため）——' +
  'この一覧の各行に付く注記（⚠ 枠(利用上限)で止まっている）を見て、どの委譲かを辿ること。';

const COUNTS_USAGE_STOPPED_REF =
  ' （「枠(利用上限)で止まっている」は横断する軸で、他の内訳に足し合わせない。' +
  '絞る綴りは無いので、各行の ⚠ 枠(利用上限)で止まっている から辿る）';

const COUNTS_RUNNER_VANISHED_FULL =
  ' **「宛先の runner が名簿から消えている」は status の分割ではなく横断する軸である** — ' +
  '必ず「走行中」の内側に座るが、`lost`（戻れなかった）とは別の集合で、' +
  '`manager_list status: ["lost"]` の絞りでは拾えない。名指しで絞る綴りは無い' +
  '（`status` の値ではないため）——この一覧の各行に付く注記' +
  '（⚠ 宛先の runner が名簿から消えている）を見て、どの委譲かを辿ること。' +
  RESTART_BEFORE_CHECK_ADVICE;

const COUNTS_RUNNER_VANISHED_REF =
  ' （「宛先の runner が名簿から消えている」は横断する軸で、走行中の内側にあり lost とは別の集合。' +
  '`status: ["lost"]` では拾えず、各行の ⚠ 宛先の runner が名簿から消えている から辿る。' +
  `${RESTART_BEFORE_CHECK_ADVICE_CORE}）`;

// 絞り込みの注記の固定の言い回し。絞りの値・件数は畳まず、言い回しだけを2回目から札にする
const FILTER_COUNTS_SCOPE_FULL = '（すぐ上の件数は絞る前の全体である）。';

const FILTER_COUNTS_SCOPE_REF = '（上の件数は絞る前の全体）。';

const FILTER_STATUS_EMPTY_FULL =
  '（渡さなかったのと同じ結果である。人間の GET /managers に揃えてある——' +
  '0件へ倒すと絞りを解除した呼びが「マネージャーが消えた」ように見えるため）。' +
  '**journal_read の types は [] を0件として扱うので、' +
  'この道具だけ倒し方が違う**（理由は tools.ts の doc に在る）。';

const FILTER_STATUS_EMPTY_REF =
  '（[] は絞らない扱い。**journal_read の [] は0件で、この道具だけ逆**）。';

const FILTER_Q_MATCH_FULL =
  '（依頼文の全文・managerId・直近の報告の本文・未 push の観測にある枝の名前への部分一致。大文字小文字と全角半角は区別しない）';

const FILTER_Q_MATCH_REF =
  '（依頼文の全文・managerId・直近の報告の本文・未 push の観測にある枝の名前への部分一致）';

const FILTER_Q_EMPTY_FULL = '（渡さなかったのと同じ結果である。status: [] と同じ倒し方）。';

const FILTER_Q_EMPTY_REF = '（絞らない扱い）。';

// 「…ほか N 件は省略」の固定の文。続きの取り方（cursor）は毎回変わるので畳まず、その前後の固定の2文だけを畳む
const OMITTED_ORDER_FULL =
  '走行中・返事待ちを先に出し、次に lost（判断待ち）、そのあとに残りを出す。' +
  '各群の中は startedAt の新しい順である。' +
  '**省略されたのは終端したもの（またはより古いもの）の側である。**';

const OMITTED_ORDER_REF =
  '（並びは前の一覧のとおり: 走行中・返事待ち → lost → 残り、群の中は startedAt の新しい順。省略されたのは終端したもの・より古いものの側である）';

const OMITTED_PAGING_FULL =
  '委譲の台帳には保持期間も掃除の機構も無いので、辿る頁数は台帳の本数に比例して増える。' +
  'status や q で絞れば頁数を減らせる。';

const OMITTED_PAGING_REF = '（頁数は台帳の本数に比例して増える。status や q で絞れば減らせる）';

// 一覧を数えて答えさせない: 一覧は予算で打ち切られ、`status` だけを数えると上振れする（`running` は終端へ勝手には行かない）ため2軸で数える
// 0 の行は作らない: 「切断 0本」と書くと、観測して 0 だったのか数えていないのかが読めなくなるため、在るときだけ書く
// `usageStopped` を上の内訳へ足し合わせない: `status` と独立の横断する軸で、同じ委譲を2回数えることになるため
function describeManagerCounts(
  managers: readonly ManagerSummary[],
  fold: FixedFold = NO_FIXED_FOLD,
): string {
  const live = managers.filter((m) => m.live).length;
  const parts = [`全 ${managers.length} 本`];
  // `m.status === 'running'` を直書きしない: 将来「実行中」を意味する新しい値が足されてもこの行の件数からだけ静かに漏れるため
  const running = managers.filter((m) => isRunningJobStatus(m.status));
  if (running.length > 0) {
    const reachable = running.filter((m) => m.live).length;
    parts.push(`走行中 ${running.length} 本（うち話しかけられる ${reachable} 本）`);
  }
  const orphaned = managers.filter((m) => m.runnerLostSince !== undefined).length;
  if (orphaned > 0) parts.push(`宛先の器が名乗らなくなった ${orphaned} 本`);
  // 「器が黙った」とは別の区分: 畳むと打つ手が変わるため（器の側を見るのか、送り直すのか）
  const sessionMissing = managers.filter((m) => m.sessionMissingSince !== undefined).length;
  if (sessionMissing > 0) parts.push(`runner にセッションが無い ${sessionMissing} 本`);
  const waiting = managers.filter((m) => m.status === 'waiting_human').length;
  if (waiting > 0) parts.push(`返事待ち ${waiting} 本`);
  // 判定は `digest.ts` の述語から取る: `status === 'lost'` を書き下ろすと `situation.ts` と分け方が割れるため
  const lost = managers.filter((m) => isManagerAwaitingJudgement(m.status)).length;
  if (lost > 0) parts.push(`戻れなかった(lost) ${lost} 本`);
  const usageStopped = managers.filter((m) => m.usageStoppedAt !== undefined).length;
  if (usageStopped > 0)
    parts.push(
      `枠(利用上限)で止まっている ${usageStopped} 本（横断する軸。他の区分とは足し合わせない）`,
    );
  // `runnerVanished` も横断する軸で、上の内訳には足し合わせない: `lost` の絞りでは拾えない集合を名指しするための別軸のため
  const runnerVanished = managers.filter((m) => m.runnerVanished !== undefined).length;
  if (runnerVanished > 0)
    parts.push(
      `宛先の runner が名簿から消えている ${runnerVanished} 本（横断する軸。他の区分とは足し合わせない）`,
    );
  return (
    `件数: ${parts.join(' / ')}。話しかけられる委譲は全体で ${live} 本である。` +
    fold('manager-list:counts-running', COUNTS_RUNNING_FULL, COUNTS_RUNNING_REF) +
    // `lost` が在るときだけ足す: 本数だけだと「終わった本数」と読まれ、`lost` は確かめるまで終われない側のため
    // 畳むのも足したときだけ: 足さない回に `fold` を呼ぶと、出していない全文を「出した」と控えてしまうため
    (lost === 0 ? '' : fold('manager-list:counts-lost', COUNTS_LOST_FULL, COUNTS_LOST_REF)) +
    (usageStopped === 0
      ? ''
      : fold(
          'manager-list:counts-usage-stopped',
          COUNTS_USAGE_STOPPED_FULL,
          COUNTS_USAGE_STOPPED_REF,
        )) +
    // `lost` を条件に混ぜない: `lost` が 0 のまま器が黙って消えた委譲だけが在る回を取りこぼすため
    (runnerVanished === 0
      ? ''
      : fold(
          'manager-list:counts-runner-vanished',
          COUNTS_RUNNER_VANISHED_FULL,
          COUNTS_RUNNER_VANISHED_REF,
        ))
  );
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

    // `resources()` を毎回呼ばない: 一覧のためにネットワーク往復を足し、`runner_list resources: true` というクローンの明示的な opt-in を自動で踏み潰すため、代わりにキャッシュの `runnerBacklog()` を読む
    tool(
      'manager_list',
      [
        'マネージャーの一覧と状態を見る。何が走っていて、何が返事待ちかが分かる。',
        // 状態の名前を「観測」より強く読ませない: running は「走らせた」で「進んでいる」ではなく、done は「ターンが終わった」で「仕事が終わった」ではないため
        '状態の名前はデーモンが観測できた範囲でしかないので、⚠ の行まで読むこと。',
        'done/背景処理待ち×N は、そのマネージャーが自分で起こした背景処理（run_in_background の子）や' +
          '作業者への委譲の完了を待って畳んだだけで、手が空いたのではないという意味である。' +
          'N は器が名乗った背景タスクの在り高であって、握り潰した報告の本数ではない' +
          '（同じ1本が3つのタスクを待ちながら2回畳めば、在り高3・握り潰し2になる）。' +
          '握り潰した報告の中身は manager_report と日誌（decision）に在る。' +
          '**この印は器が名乗った分にだけ立つ** — この欄を送らない古い器では、背景処理を待っていても' +
          '立たない。だから **印が無いことを「手が空いている」と読まないこと。**',
        '背景処理待ち×N の直後に「（<時刻> から）」が付くことがある。それはこの委譲が' +
          '最初に背景処理待ちへ入った時刻（ISO 8601、UTC）で、経過時間そのもの（「N時間」等）' +
          'ではない——ここは呼ばれるたびに答えが変わる計算をしない場所なので、経過は' +
          'いまの時刻と見比べて自分で出すこと。時刻が付かないのは「そう名乗られていない」' +
          '場合であって「待ち始めていない」ではない（この印が立つ条件は直前の断りと同じ）。',
        '依頼文と報告は抜粋なので、全文が要るなら manager_report で取ること。',
        `同じ会話で前回に全文で出した行と1字も変わらない行は「- <managerId> ${MANAGER_ROW_SAME_MARK}」の1行に畳む（⚠・lost・失敗の行は畳まない）。畳んだ件数は一覧に出る。全部を全文で引き直すなら refetch: true。`,
        '「runner にセッションが無い」は、10秒ごとの生存確認が runner に一覧を' +
          '聞いて観測する（走行中・返事待ちのものだけを見る）。誰かが manager_send を' +
          '打つのを待たない。ただし観測できた回にだけ立つので、**行が出ないことを' +
          '「セッションは在る」と読まないこと** — 器に聞けなかっただけの回もある。' +
          '待機中（done）のものはこの観測の対象外である（完遂してセッションを畳んだ' +
          '回と区別が付かず、区別できないものに ⚠ を付けると本当に困っている1本が埋もれる）。',
        '器（runner）側の未送出の滞留は、runner_list を resources: true で明示的に呼んだとき、' +
          'または10秒ごとの生存確認が対応する runner から自動で拾ったときに、それぞれ' +
          'キャッシュされる（それ以外の経路では更新されない）。生存確認からの自動更新に' +
          '対応しない古い runner・LocalRunner は、runner_list を resources: true で' +
          '呼ばない限り一度も warm しない——この一覧に行が出ないことを「滞留0」と' +
          '読まないこと。0件だったか、まだ観測していないかのどちらかである。出ている行も' +
          '観測した時点の値であって現在値ではないので、最新の値が要るなら runner_list を' +
          'resources: true で呼び直すこと。',
        '生ログの末尾が stop_reason: tool_use のまま対応する tool_result が無く、かつ返事待ちが空の' +
          'ものには ⚠ の行が出る（道具を回しているなら、その応答を待っているのはデーモンのはずなので、' +
          'これは矛盾である）。この行に時刻の閾値は置いていない——何分経ったかは判定していないので、' +
          '行に出ている timestamp を読んで判断すること。返事待ちが在るものにはこの行を出さない' +
          '（確認は届いていて、クローンがまだ答えていないだけの正常な状態である）。',
        '「畳む候補」の ⚠ は、status が done で背景処理待ちの印が無く、状態の判定が' +
          'active で、最後のターン終了から一定時間が経った委譲に出す印である。' +
          'ただし、器が「背景処理待ちの印を送る版」だと名乗った（runner の hello の能力）委譲にしか出ない' +
          '——名乗らない古い器や、名乗りをまだ受けていない器の委譲には出ない' +
          '（出ていないことを「畳む候補が無い」と読まないこと）。' +
          'この道具（manager_list）自身は畳まない——ここは表示だけである。' +
          '畳むのは runner_list を resources: true で呼んだときだけで、その器の pids が' +
          '逼迫していれば（上限の80%以上）、同じ候補の判定を満たす委譲をデーモンが自動で畳む' +
          '（未 push の実装・未コミットの変更が無いことも確かめたうえで）。' +
          '何を畳んだ・見送ったかは runner_list の応答と日誌（journal_read、decision）に出る。',
        '走行中・返事待ち（running / waiting_human）を先に出し、次に lost（前のセッションへ戻れなかったもの。' +
          '成果がリモートに届いているかを誰も確かめていない＝判断待ちである）、' +
          'そのあとに残りの終端（done / failed / stopped）を出す。' +
          '各群の中は startedAt の新しい順である。',
        // status の説明は欄（status の describe）へ集めてある: 2か所に分かれていると、読み手が欄だけ見て呼ぶときに片方を取りこぼすため
        'q で依頼文の全文・managerId・直近の報告の本文・未 push の観測にある枝の名前を部分一致で探せる（依頼文の札や語、持っている PR の番号、作業中の枝で担当を探すとき。大文字小文字・全角半角は区別しない）。status と併用できる。' +
          '各行の退避 ref は件数と最新の1件だけで、全部は manager_report を rescueAll: true で呼ぶと、退避 ref を作業ツリーごとに全部出す。',
        '絞った先が予算で切れたら、断り書きが次に打つ cursor を案内する。それを cursor へ渡すと続きから読める。',
        '認証トークンの世代の行（`describeTokenGeneration` の doc）が出ているマネージャーでは、' +
          'この委譲が最後に起こした／自動で開き直した時点の世代と、いまの現役の世代を比べられる。' +
          '⚠ が付いていれば世代が食い違っている——回した直後の短い遅れなら自然に消える。' +
          `429 が続いたまま消えないなら、起こし直すこと。${STALE_TOKEN_RESTART_ADVICE}` +
          '世代が測れていないときも行は出る——' +
          '「分からない」の理由（プール未配線／未観測／デーモンの再起動をまたいだ引き取り）を' +
          '名乗る。再起動をまたいだ場合だけ manager_stop → manager_start が効く。',
        '429 で落ちたとき、SDK が返す文言に書かれていた resets 時刻を、認証トークンの' +
          'プールの各鍵の冷却期限と突き合わせた行も出ることがある。「世代ずれの疑い」なら、' +
          'この委譲は現役ではない古い鍵を掴んだまま走っている可能性が高い——鍵が通る状態へ' +
          '戻っても、このセッション自身は起こし直すまで戻らない。' +
          '「待てば戻る」なら、現役の鍵自身がいま冷却中なだけで世代ずれではなく、対処は要らない。' +
          '行が出ないのは「健全」ではなく「まだ判定できない」という意味である——' +
          '429 の通知がまだ届いていないか、文言・プールのどちらとも一致しなかったかのどちらか。' +
          '上の世代番号の比較が既に食い違いを名指ししているときは、二重に鳴らさないので' +
          'この行は出ない。',
      ].join(' '),
      {
        // `jobStatusSchema` をそのまま使う: 綴りを間違えた呼びが「その状態のものは0件」として返り、絞り込みが効いていないことに気づけない形を作らないため
        status: z
          .array(jobStatusSchema)
          .optional()
          .describe(
            '例 {"status":["waiting_human"]}。配列で渡し、値は引用符で囲む。' +
              '状態（running / waiting_human / done / failed / lost / stopped の6つ。`waiting` ではなく `waiting_human`）で絞る。' +
              '省略すると絞らない。走っているものだけを見たいなら ["running","waiting_human"]。' +
              // `[]` の倒し方はクローンが読む面にも書く: 他の一覧は `[]` を0件として扱うので、ここだけ違うことを黙っていると読み手が「0件だ」と読むため
              '空の配列 [] も絞らない（渡さなかったのと同じ全件が出て、応答に「絞らずに全件を出した」と書く）。' +
              '**journal_read の types とは倒し方が違う**（あちらは [] を0件として扱う）。' +
              '先頭の件数の行は絞る前の全体を出す',
          ),
        q: z
          .string()
          .optional()
          .describe(
            '依頼文の全文・managerId・直近の報告の本文・未 push の観測にある枝の名前に部分一致で絞る（例: 依頼文の札 "WORLDBUILD-7"、PR の番号 "6387"、枝 "feat/mob-add-kinds"）。' +
              '大文字小文字は区別せず、全角と半角は NFKC で揃えて比べる（【】と [] のような別の字は揃わない）。' +
              'status と併用できる（両方に当たるものだけが出る）。' +
              '省略・空文字・空白だけは絞らない（応答にその旨が出る）。' +
              '先頭の件数の行は絞る前の全体を出す。0件のときは q の値つきでそう言う',
          ),
        cursor: z
          .string()
          .optional()
          .describe(
            '一覧の続きを読む位置。前回の応答の断り書きに出た cursor をそのまま渡す' +
              '（自分で組み立てない）。省略すると先頭から。' +
              'status と q はカーソルを取った呼びと揃えること（食い違うと明示のエラーになる）。',
          ),
        refetch: z
          .boolean()
          .optional()
          .describe(
            `真なら、前回と変わらず「${MANAGER_ROW_SAME_MARK}」に畳まれる行・受信箱の内訳も全文で出し直す（会話の上の全文を見失ったとき）`,
          ),
      },
      async ({ status, q, cursor, refetch }, extra: unknown) => {
        if (!context.managers) return NO_POOL;
        // サブエージェントの呼びは全文で返し、控えも更新しない: 札が指す全文はサブエージェントの文脈にしか載らず、本体の控えが「出した」になるのを防ぐ
        const fold = isSubagentCaller(context, extra)
          ? NO_FIXED_FOLD
          : (context.foldFixed ?? NO_FIXED_FOLD);
        const managers = await context.managers.list();
        // この一覧ぜんぶで同じ「いま」を使う: 行ごとに `new Date()` を呼ぶと、同じ応答の中で判定の基準がずれるため
        const now = new Date();
        // 受信箱の滞留は早期リターンの前に確かめる: マネージャーが1本も居なくても合図が溜まっていることがあるため
        // 文にするのは返す直前: 固定の言い回しの `fold` は呼んだ時点で「会話に出した」と控えるので、cursor の誤りなどで返す別の応答の手前で呼ぶと、出していない全文を出したことにしてしまうため
        const inboxPeek = await context.stores.inbox.peekPending();
        const inboxPeekedAt = Date.now();
        const inboxQueued = context.queuedInMemory?.();
        const renderInboxBacklog = (): string =>
          describeInboxBacklog(inboxPeek, inboxPeekedAt, inboxQueued, fold, refetch === true);
        // `?.() ?? []` で読まない: 「この口を持たない実装」と「持っているが1件も観測していない」を同じ `[]` へ畳み、この一覧が区別しようとしているものを潰すため
        const runnerBacklog = describeRunnerBacklog(context.managers.runnerBacklog());
        const origins = await readJobOrigins(context.stores);
        // 読めない委譲の行は「居ない」と分けて名乗る: `list()` は読めない行を飛ばすので、黙っていると壊れた行だけの台帳が「1本も居ない」に見えるため
        const unreadableJobNote = describeUnreadableJobs(
          await context.stores.jobs.listUnreadableJobs(),
        );
        if (managers.length === 0) {
          return text(
            [
              unreadableJobNote === null
                ? '（マネージャーは1本も居ない）'
                : '（読めたマネージャーは無い。居ないとは言えない）',
              unreadableJobNote,
              renderInboxBacklog(),
              runnerBacklog,
            ]
              .filter((line): line is string => line !== null)
              .join('\n'),
          );
        }

        // 走行中・返事待ち → lost → その他の3群で出す: `ManagerPool.list()` は稼働状態を見ない `startedAt` 降順で、終端した委譲が溜まると走行中が窓の外へ押し出され id が本文に出なくなるため
        // `ManagerPool.list()` は変えない: HTTP の錨と digest の契約があの並びに依存しており、並べ直すのはこの一覧の中だけにする
        // `lost` は第2群として前へ出す: 成果の有無を観測していないので確かめるまで終われず、終端の袋に入れると判断が要るものが窓の外へ落ちるため
        // 再通知は作らない: `manager_message` は束ねられず、`lost` の本数がそのままクローンのターン数になるため
        const attention = [...managers].sort(compareManagerAttention);
        // 絞りは文字数の予算より前に当てる: 後だと絞りに当たらない行が窓を食い尽くし、狙った行が窓の外へ落ちるため
        // `status: []`（空配列）は「絞らない」へ倒す。**この面の他の一覧とは逆である**: ストアを通らず、同じ引数名が面によって逆の答えを返すほうが、面の中で倒し方が揃わないことより重いため（`GET /managers?status=` に揃える）
        // 黙って無視しない: `[]` を0件だと思って渡した呼び手には、出力で「絞らずに全件を出した」と言う
        const filtering = status !== undefined && status.length > 0;
        // `q` は依頼文の全文（`manager.request`。一覧に出す抜粋ではない）と managerId に当てる: 抜粋に当てると、抜粋の後ろに在る札や語で探せないため
        // 両側を NFKC に揃えて小文字にする: 全角の【】・英数と半角、英字の大小を呼び手が合わせなくても当たるように
        // 空白だけの `q` は絞らない側へ倒す（`status: []` と同じ。0件へ倒すと絞りを外した呼びが「マネージャーが消えた」ように見える）
        const queryNeedle = q === undefined ? '' : normalizeManagerQuery(q);
        const queryFiltering = queryNeedle !== '';
        const statusView = filtering
          ? attention.filter((manager) => status.includes(manager.status))
          : attention;
        const view = queryFiltering
          ? statusView.filter((manager) =>
              managerQueryHaystacks(manager).some((text) =>
                normalizeManagerQuery(text).includes(queryNeedle),
              ),
            )
          : statusView;
        // cursor は `status` と `q` で絞った後・予算で切る前で解決する: 順序を変えると絞りに当たらない行が窓を食い尽くすため
        const cursorStatus = normalizeManagerCursorStatus(status);
        const cursorQuery = queryFiltering ? queryNeedle : null;
        const cursorOutcome = resolveManagerCursor(
          view,
          managerPositionOf,
          cursorStatus,
          cursor,
          cursorQuery,
        );
        if (cursorOutcome.kind === 'malformed') {
          return text(
            'cursor が壊れている（この道具が返したものではないか、書き換えられている）。' +
              '一覧を先頭から読み直すには cursor を付けずに manager_list を呼ぶこと。',
          );
        }
        if (cursorOutcome.kind === 'status-mismatch') {
          const cursorStatusText =
            cursorOutcome.cursorStatus === null
              ? '絞っていない'
              : cursorOutcome.cursorStatus.join(',');
          return text(
            `cursor は status: ${cursorStatusText} の一覧から出た続きの位置で、` +
              `いまの呼び（status: ${status === undefined ? '未指定' : status.join(',')}）と食い違う。` +
              'status を cursor を取ったときと揃えて呼び直すか（' +
              `manager_list ${cursorOutcome.cursorStatus === null ? '' : `status=${JSON.stringify(cursorOutcome.cursorStatus)} `}cursor=${cursor}）、` +
              'cursor を付けずに status だけで先頭から呼び直すこと。',
          );
        }
        if (cursorOutcome.kind === 'q-mismatch') {
          return text(
            `cursor は q: ${cursorOutcome.cursorQuery === null ? '絞っていない' : JSON.stringify(cursorOutcome.cursorQuery)} の一覧から出た続きの位置で、` +
              `いまの呼び（q: ${queryFiltering ? JSON.stringify(q) : '未指定または空'}）と食い違う。` +
              'q を cursor を取ったときと揃えて呼び直すか、cursor を付けずに先頭から呼び直すこと。',
          );
        }
        const paged = cursorOutcome.view;
        // 予算を先に決めて入るところまで積む: 件数から出力量を決めると何件で壊れるかが運任せになるため
        const items = paged.map((manager) => {
          // 印は行を新しく増やさず既存の行へ添える: 行を1本増やすと予算に張り付いた一覧では出る件数が減るため
          const drift = describeReportDriftMark(manager, now);
          const driftMark = drift === null ? '' : `、${drift}`;
          // 条件3は器の機能申告で確かめる: 名乗りを受けていない・旧い器・runnerId が無い委譲は「送っているはず」と仮定しない
          // 条件5の材料は `turnEndedAt` ではなく `updatedAt`: `turnEndedAt` は `status: 'running'` の委譲でしか計算されないため
          const foldCandidateLine = describeManagerFoldCandidate(
            {
              status: manager.status,
              hasAwaitingBackgroundSignal: manager.awaitingBackground !== undefined,
              awaitingBackgroundSignalVersionConfirmed:
                manager.runnerId !== undefined &&
                (context.managers?.runnerHasCapability?.(
                  manager.runnerId,
                  RUNNER_CAPABILITY_AWAITING_BACKGROUND_SIGNAL,
                ) ??
                  false),
              activityKind: classifyManagerActivity(managerActivityInputOf(manager)),
              hasHeldMessages: manager.heldMessages !== undefined,
              lastTurnEndedAt: manager.updatedAt,
            },
            now,
          );
          const marks = new Set<ManagerListNoteMark>();
          if (manager.runnerLostSince !== undefined) marks.add('runner-lost');
          if (manager.sessionMissingSince !== undefined) marks.add('session-missing');
          if (manager.status === 'lost') marks.add('lost');
          const entry = renderListingEntry({
            id: manager.managerId,
            title: `[${describeManagerState(manager.status, manager.live, manager.awaitingBackground)}]`,
            createdAt: manager.startedAt,
            updatedAt: manager.updatedAt,
            summary: `依頼: ${excerptLine(manager.request, LIST_REQUEST_EXCERPT)}`,
            extra: [
              // 行ごとに同じ長い固定文を繰り返さない（#5347）: 行には印と固有の値（since・kind）だけを残し、印の意味は一覧の末尾に1回だけ書く（`managerListNotes`）
              // runnerId は空欄にしない: 空欄だと「取れていない」のか「読み忘れ」なのか区別できないため「未記録」と書く
              // 断定は「器が黙っている」までにする: その中で走っていたかはこの観測から言えない
              // 「いま話しかけられない」と書かない: 名簿が `lost` と判定した器の委譲へも `send()` は実際に届くため
              `  runner: ${manager.runnerId ?? '未記録'}${
                manager.runnerLostSince === undefined
                  ? ''
                  : `（この器は ${manager.runnerLostSince} 以降 名乗っていない${MANAGER_LIST_NOTE_MARKS['runner-lost']}）`
              }`,
              // 取れない側は「不明」と書き、既定の帯（opus / sonnet）と推測しない
              `  モデル: ${describeManagerModels(managerModelsOf(context.managers, manager))}`,
              // 別の行として出し `describeManagerState` は動かさない: `manager_list` と要約で字面が割れるのを防ぐための関数のため
              manager.sessionMissingSince === undefined
                ? null
                : `  ⚠ 宛先の runner は ${manager.sessionMissingSince} の時点で、この委譲のセッションを持っていなかった${MANAGER_LIST_NOTE_MARKS['session-missing']}。` +
                  // 由来を畳まない: 「resume でも入り直せなかった」と「名簿に載っていなかっただけ」では読み手の次の一手が違うため
                  describeSessionMissingKind(manager.sessionMissingKind),
              `  cwd: ${manager.cwd}`,
              // `lost` を状態名だけで済ませない: 「終わった」と読まれると完了していない仕事がそのまま片付くため
              // 言い切るのは観測した分までにする: 落ちる直前にマージまで済ませていた仕事が、その
              // 1分半後の器の作り直しで `lost` になり、この行が「途中で失われて
              // いる（完了ではない）」と嘘をついた実害があるため
              manager.status === 'lost'
                ? `  ⚠ 前のセッションへ戻れなかった${MANAGER_LIST_NOTE_MARKS.lost}。`
                : null,
              describeJobOrigin(origins, manager.managerId),
              // 前任・後継は短く1行で出す: 自動の起こし直しの対象外か、どれの後継かを一覧で読めるように（#4861）
              manager.supersededBy === undefined
                ? null
                : `  後継: ${manager.supersededBy}（以後は自動で起こさない）`,
              manager.supersedes === undefined ? null : `  前任: ${manager.supersedes}`,
              unobservedOutcomeLine(manager),
              // 拒否は `status` に映らないので、状態の値は増やさず状態に添える
              denialLine(context.managers?.denials(manager.managerId) ?? [], manager.lastReportAt),
              // 拒否の行の直後に置く: 上限を越えた担当は、この後の返事待ちが分類器の倒した確認で埋まりうるため、返事待ちより先に読ませる
              describeDenialStreakForList(manager.classifierDenials),
              peerApprovalsLine(manager.pendingPeerApprovals),
              // 待ちの要約も抜粋を通す: `AskUserQuestion` の経路は質問文を連ねて runner 側のキャップを通らないため
              // 件数にも上限を置く: `manager.waiting` は増える一方で、伸びると1本のマネージャーが予算を占有し他が押し出されるため
              ...manager.waiting
                .slice(0, MANAGER_WAITING_LIST_LIMIT)
                .map(
                  (item) =>
                    `  返事待ち(requestId: ${item.requestId}, ${describeWaitingKind(item.kind)}, ` +
                    `${item.askedAt} から): ${excerptLine(item.summary, LIST_WAITING_EXCERPT)}`,
                ),
              manager.waiting.length > MANAGER_WAITING_LIST_LIMIT
                ? `  …ほか ${manager.waiting.length - MANAGER_WAITING_LIST_LIMIT} 件の返事待ちは省略` +
                  `（全 ${manager.waiting.length} 件。manager_send に requestId を渡せば個別に答えられる）。`
                : null,
              // 失敗は報告の上に置く: 下だと包まれたエラー文を先に読んでから「実は報告ではない」と分かる順になるため
              failureLine(manager),
              usageStoppedLine(manager),
              runnerVanishedLine(manager),
              systemErrorLine(manager),
              cgroupEventsLine(manager),
              manager.lastReport === undefined
                ? null
                : // 時刻は既存の行に添えるだけ: 行を1本増やすと予算に張り付いた一覧では出る件数が減るため、`lastReportAt` が無い行には「未受信」のような行を作らない
                  // 失敗した回・畳まれた回は「報告」と呼ばない: 見出しが「直近の報告」のままだと包みの内側だけを読んで報告として扱うため
                  `  ${isFoldedTurnReport(manager) ? '直近のターンの中身' : '直近の報告'}${manager.lastReportAt === undefined ? '' : `（${manager.lastReportAt} 受信${driftMark}）`}: ${excerptLine(manager.lastReport, LIST_REPORT_EXCERPT)}`,
              describeTurnEnd(manager),
              describeToolUseStall(manager),
              describeTokenGeneration(manager),
              describeResetTimeSkew(manager),
              foldCandidateLine,
              describeUnpushedWorkObservation(manager, 'brief', now),
              // `describeWithheldReports` はここには足さない: 「背景処理待ち×N」の `tasks` と並べると別行でも混同が起き、行を増やしても読み手の次の一手は変わらないため
            ],
          });
          return { entry, marks, manager };
        });
        const itemTexts = items.map((item) => item.entry);
        // 末尾の注は予算の内側で数える: 外に置くと lost が多い一覧で LIST_BUDGET を越える。出る行が減れば要る注も減るので、2回目の締めは1回目の部分集合で収まる
        const firstFill = fillListingBudget(itemTexts, LIST_BUDGET, false);
        const firstNotes = managerListNotes(
          items.slice(0, firstFill.shown).map((item) => item.marks),
        );
        const secondFill = fillListingBudget(
          itemTexts,
          Math.max(0, LIST_BUDGET - firstNotes.length),
          false,
        );
        // 予算は全文の長さで測り（畳んだ分は余るだけ）、畳む呼びはこの1回だけにする
        const noteBlock = managerListNotes(
          items.slice(0, secondFill.shown).map((item) => item.marks),
          fold,
        );
        // 前回と変わらない行を短い1行にする。対象は予算の内側で全文のまま出る行だけ（省略された行・切り詰めた先頭行は「出した」と控えない）
        const rowLines = secondFill.lines.map((line, index) => {
          const item = items[index]!;
          if (line !== item.entry || managerRowAlwaysFull(item.manager, line)) return line;
          const folded = fold(
            `${MANAGER_LIST_ROW_FOLD_PREFIX}${item.manager.managerId}\u0000${rowFingerprint(line)}`,
            line,
            managerRowRef(item.manager),
            `${MANAGER_LIST_ROW_FOLD_PREFIX}${item.manager.managerId}\u0000`,
          );
          return refetch === true ? line : folded;
        });
        const foldedRows = rowLines.filter(
          (line, index) => line !== secondFill.lines[index],
        ).length;
        return text(
          dedupeRestartAdvice(
            foldRowPhrases(
              [
                // 本数は一覧の外に出す: 一覧は予算で打ち切られ、出ている行を数えても全体の本数にならないため。件数は絞る前の全件で出す: 絞りのせいで全体の実像が見えなくなる形にしないため
                describeManagerCounts(managers, fold),
                unreadableJobNote,
                // 絞り込みの注記の固定の言い回しは `fold` に包む。絞りの値・件数は毎回出す
                // 絞ったことは件数の行とは別の行で言う: 混ぜると「絞る前の全体」と「絞った後」がどちらの数なのかを読み分ける負担が読み手に移るため
                // `status: []` は「絞らなかった」と言う: 黙って無視しないため
                status === undefined
                  ? null
                  : filtering
                    ? `絞り込み: status: ${status.join(',')} に当たるのは ${statusView.length} 件で、` +
                      `この一覧は${queryFiltering ? 'その中の q にも当たるものだけ' : 'その中だけ'}を出している` +
                      fold(
                        'manager-list:filter-status-scope',
                        FILTER_COUNTS_SCOPE_FULL,
                        FILTER_COUNTS_SCOPE_REF,
                      )
                    : '絞り込み: status に空の配列が渡ったので、絞らずに全件を出した' +
                      fold(
                        'manager-list:filter-status-empty',
                        FILTER_STATUS_EMPTY_FULL,
                        FILTER_STATUS_EMPTY_REF,
                      ),
                // `q` の注記も件数の行とは別の行で言う。空白だけの `q` は黙って無視せず、絞らなかったと言う
                q === undefined
                  ? null
                  : queryFiltering
                    ? `絞り込み: q: ${JSON.stringify(q)}` +
                      fold('manager-list:filter-q-match', FILTER_Q_MATCH_FULL, FILTER_Q_MATCH_REF) +
                      `に当たるのは ${view.length} 件` +
                      `${filtering ? `（status で絞った ${statusView.length} 件の中）` : `（全 ${managers.length} 本の中）`}で、` +
                      'この一覧はその中だけを出している' +
                      fold(
                        'manager-list:filter-q-scope',
                        FILTER_COUNTS_SCOPE_FULL,
                        FILTER_COUNTS_SCOPE_REF,
                      )
                    : '絞り込み: q が空（または空白だけ）だったので、q では絞らなかった' +
                      fold('manager-list:filter-q-empty', FILTER_Q_EMPTY_FULL, FILTER_Q_EMPTY_REF),
                // 絞った結果が0件なのと委譲が1本も無いのを分ける: 「無い」と読めると、絞りが厳しかっただけなのに台帳の側を疑うことになるため
                view.length === 0
                  ? queryFiltering
                    ? `（${filtering ? 'この status と ' : ''}q: ${JSON.stringify(q)} の絞り込みに当たる委譲は0件だった。絞る前の件数は上の行に在る）`
                    : '（この status の絞り込みに当たる委譲は無い。絞る前の件数は上の行に在る）'
                  : // cursor で辿り切った最後の頁を、絞り込みの0件とは別の文にする
                    paged.length === 0
                    ? '（cursor より後ろの、この絞り込みに当たる委譲は無い。これが最後の頁）'
                    : renderFilledListing(rowLines, secondFill, {
                        // `status` の有無ではなく `filtering` で分ける: `status: []` は絞っていないので、有無で分けると渡した文字が無いのに絞ったと言う嘘になるため
                        // 母数は `renderListing` が渡す `total` ではなく `view.length` を使う: 頁が進んでも変わらない数にするため
                        omitted: ({ rest, shown }) => {
                          const total = view.length;
                          const lastShown = paged[shown - 1]!;
                          const nextCursor = encodeManagerCursor({
                            ...managerPositionOf(lastShown),
                            status: cursorStatus === null ? null : [...cursorStatus],
                            q: cursorQuery,
                          });
                          const statusArg = filtering ? ` status=${JSON.stringify(status)}` : '';
                          const queryArg = queryFiltering ? ` q=${JSON.stringify(q)}` : '';
                          const narrowed = [
                            filtering ? `status: ${status.join(',')}` : null,
                            queryFiltering ? `q: ${JSON.stringify(q)}` : null,
                          ].filter((part): part is string => part !== null);
                          return (
                            `…ほか ${rest} 件は省略（` +
                            (narrowed.length > 0
                              ? `${narrowed.join(' と ')} に絞った ${total} 件のうち ${shown} 件を出した`
                              : `全 ${total} 件`) +
                            '）。' +
                            fold(
                              'manager-list:omitted-order',
                              OMITTED_ORDER_FULL,
                              OMITTED_ORDER_REF,
                            ) +
                            // cursor は毎回変わる（位置・絞りを含む）ので畳まない: 畳むと続きが取れなくなる
                            `続きは manager_list cursor=${nextCursor}${statusArg}${queryArg} で取れる（status と q は同じまま呼ぶこと）。` +
                            fold(
                              'manager-list:omitted-paging',
                              OMITTED_PAGING_FULL,
                              OMITTED_PAGING_REF,
                            )
                          );
                        },
                      }),
                foldedRows === 0
                  ? null
                  : `前回と同じ行 ${foldedRows} 本は省いた（上の「${MANAGER_ROW_SAME_MARK}」の行。順序は変えていない）。` +
                    '全文は manager_report <managerId>、一覧を丸ごと引き直すなら manager_list に refetch: true',
                '（依頼と報告は抜粋。全文は manager_report <managerId> で取れる）',
                noteBlock === '' ? null : noteBlock,
                renderInboxBacklog(),
                runnerBacklog,
              ]
                .filter((line): line is string => line !== null)
                .join('\n'),
              fold,
            ),
          ),
        );
      },
    ),

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
