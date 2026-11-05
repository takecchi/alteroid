// マネージャーへの委譲の道具のうち `manager_list`。`clone-tools-manager.ts` の `managerTools` が並びのまま連結する。
// このファイルから `clone-tools-manager.ts` を import しない（一方向）。他の道具とも使う補助は `clone-tools-manager-describe.ts` に在る。

import { z } from 'zod';
import { isRunningJobStatus } from './job-status-running.js';
import { describeDenialStreakForList } from './classifier-denial-streak.js';
import {
  compareManagerPosition,
  encodeManagerCursor,
  normalizeManagerCursorStatus,
  resolveManagerCursor,
  type ManagerPosition,
} from './manager-cursor.js';
import { RUNNER_CAPABILITY_AWAITING_BACKGROUND_SIGNAL } from './runner-protocol.js';
import {
  classifyUnobservedOutcome,
  describeManagerState,
  describeSessionMissingKind,
  describeUnobservedOutcome,
  isManagerAwaitingJudgement,
  isManagerInFlight,
  JUDGEMENT_RANK_NOT_APPLICABLE,
} from './digest.js';
import {
  excerptLine,
  fillListingBudget,
  renderFilledListing,
  renderListingEntry,
} from './excerpt.js';
import {
  classifyManagerActivity,
  describeReportDrift,
  type ManagerActivityInput,
} from './manager-activity.js';
import {
  type ManagerSummary,
  type RunnerBacklogSnapshot,
  type TokenGenerationUnknownReason,
} from './manager.js';
import { tokenGenerationMismatched } from './manager-summary.js';
import type { ManagerDenial } from './denial-key.js';
import { jobStatusSchema, type Job, type JobStatus } from './schema.js';
import { describeUnreadableJobs, type InboxPeek, type Stores } from './store.js';
import { RESTART_BEFORE_CHECK_ADVICE, STALE_TOKEN_RESTART_ADVICE } from './usage-limits.js';
import {
  describeHumanOriginatedInboxAlert,
  describeInboxBacklogBreakdown,
  describeInboxBacklogQueuedInMemory,
  describeNoReadableInboxEvents,
  summarizeInboxBacklog,
} from './inbox-backlog.js';
import { describeManagerFoldCandidate } from './manager-fold-candidate.js';
import { describeManagerModels, managerModelsOf } from './manager-models.js';
import { describeWaitingKind } from './waiting-kind-format.js';
import {
  describeRunnerLegState,
  text,
  tool,
  NO_POOL,
  noteSubagentCallerGauge,
} from './clone-tools-common.js';
import type { ToolContext } from './clone-tools-context.js';
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

const LIST_REQUEST_EXCERPT = 160;

const LIST_REPORT_EXCERPT = 240;

// `LIST_REPORT_EXCERPT` を使い回さない: 値が同じ桁でも、片方だけ直したくなったときに一緒に動くため
const LIST_TURN_END_TAIL_EXCERPT = 160;

// runner 側のキャップを根拠にしない: `AskUserQuestion` は `brief` を通らないため、出す側で締める
const LIST_WAITING_EXCERPT = 200;

const LIST_BUDGET = 8_000;

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

const MANAGER_LIST_NOTE_ORDER: readonly ManagerListNoteMark[] = [
  'runner-lost',
  'session-missing',
  'lost',
];

// 出ている行が使った印の分だけ書く（使われなければ1文字も足さない）。RESTART_BEFORE_CHECK_ADVICE は
// runner 消失・セッション無しの両方に掛かるので、並べずここで1回だけ言う
function managerListNotes(rowMarks: readonly ReadonlySet<ManagerListNoteMark>[]): string {
  const used = MANAGER_LIST_NOTE_ORDER.filter((mark) => rowMarks.some((marks) => marks.has(mark)));
  if (used.length === 0) return '';
  const lines = used.map(
    (mark) => `${MANAGER_LIST_NOTE_MARKS[mark]} ${MANAGER_LIST_NOTE_BODIES[mark]}`,
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

const LIST_TOOL_USE_STALL_LIMIT = 3;

// 「未処理の合図は無い」は、器の行も読めない行もメモリの待ち行列も0件のときにしか言わない
function describeInboxBacklog(
  peek: InboxPeek,
  now: number,
  queuedInMemory: number | undefined,
): string {
  const rows = peek.entries;
  const queuedLine = describeInboxBacklogQueuedInMemory(queuedInMemory);
  const noReadable = describeNoReadableInboxEvents(peek.unreadable);
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
  const humanOriginatedAlert = describeHumanOriginatedInboxAlert(breakdown);
  const humanOriginatedLine = humanOriginatedAlert === '' ? '' : `${humanOriginatedAlert}\n`;
  const queuedSuffix = queuedLine === null ? '' : `\n${queuedLine}`;
  return (
    `${humanOriginatedLine}` +
    `⚠ クローンの受信箱に未処理の合図が ${breakdown.total} 件ある${oldest}\n` +
    describeInboxBacklogBreakdown(breakdown) +
    queuedSuffix
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

function usageStoppedLine(manager: ManagerSummary): string | null {
  const note = describeUsageStopped(manager);
  return note === null ? null : `  ${note}`;
}

function runnerVanishedLine(manager: ManagerSummary): string | null {
  const note = describeRunnerVanished(manager);
  return note === null ? null : `  ${note}`;
}

function systemErrorLine(manager: ManagerSummary): string | null {
  const note = describeManagerSystemError(manager);
  return note === null ? null : `  ${note}`;
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
  const hint = job.taskId === undefined ? ORIGIN_HINT_NO_TASK : ORIGIN_HINT;
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

const ORIGIN_HINT = '（報告を人間へ知らせるなら、結び付いた task へ task_say で書く）';

// 委譲に task が結び付いていないとき
const ORIGIN_HINT_NO_TASK =
  '（報告を人間へ知らせるなら、この会話を起点にした task を task_list で探して task_say で書く。無ければ task_add で足す）';

// 件数の行の固定の読み方（`describeManagerCounts`）
const COUNTS_RUNNING =
  '**「走行中」は「進んでいる」ではない** — 宛先の器が黙って消えても ' +
  'status は running のままで、それを終端へ動かす経路はデーモンに無い。' +
  'いま何本動いているかを数えるなら、走行中の本数ではなく' +
  '「話しかけられる」ほうを見ること。';

const COUNTS_LOST =
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

const COUNTS_USAGE_STOPPED =
  ' **「枠(利用上限)で止まっている」は status の分割ではなく横断する軸である** — ' +
  '走行中・返事待ち・戻れなかった(lost)・手が空いている（done）等のどれとも重なりうるので、' +
  '上の内訳には足し合わせない。名指しで絞る綴りは無い（`status` の値ではないため）——' +
  'この一覧の各行に付く注記（⚠ 枠(利用上限)で止まっている）を見て、どの委譲かを辿ること。';

const COUNTS_RUNNER_VANISHED =
  ' **「宛先の runner が名簿から消えている」は status の分割ではなく横断する軸である** — ' +
  '必ず「走行中」の内側に座るが、`lost`（戻れなかった）とは別の集合で、' +
  '`manager_list status: ["lost"]` の絞りでは拾えない。名指しで絞る綴りは無い' +
  '（`status` の値ではないため）——この一覧の各行に付く注記' +
  '（⚠ 宛先の runner が名簿から消えている）を見て、どの委譲かを辿ること。' +
  RESTART_BEFORE_CHECK_ADVICE;

// 絞り込みの注記の固定の言い回し。絞りの値・件数は毎回出す
const FILTER_COUNTS_SCOPE = '（すぐ上の件数は絞る前の全体である）。';

const FILTER_STATUS_EMPTY =
  '（渡さなかったのと同じ結果である。人間の GET /managers に揃えてある——' +
  '0件へ倒すと絞りを解除した呼びが「マネージャーが消えた」ように見えるため）。' +
  '**journal_read の types は [] を0件として扱うので、' +
  'この道具だけ倒し方が違う**（理由は tools.ts の doc に在る）。';

const FILTER_Q_MATCH =
  '（依頼文の全文・managerId・直近の報告の本文・未 push の観測にある枝の名前への部分一致。大文字小文字と全角半角は区別しない）';

const FILTER_Q_EMPTY = '（渡さなかったのと同じ結果である。status: [] と同じ倒し方）。';

// 「…ほか N 件は省略」の固定の文。続きの取り方（cursor）は毎回変わるので、その前後の固定の2文を分けて持つ
const OMITTED_ORDER =
  '走行中・返事待ちを先に出し、次に lost（判断待ち）、そのあとに残りを出す。' +
  '各群の中は startedAt の新しい順である。' +
  '**省略されたのは終端したもの（またはより古いもの）の側である。**';

const OMITTED_PAGING =
  '委譲の台帳には保持期間も掃除の機構も無いので、辿る頁数は台帳の本数に比例して増える。' +
  'status や q で絞れば頁数を減らせる。';

// 一覧を数えて答えさせない: 一覧は予算で打ち切られ、`status` だけを数えると上振れする（`running` は終端へ勝手には行かない）ため2軸で数える
// 0 の行は作らない: 「切断 0本」と書くと、観測して 0 だったのか数えていないのかが読めなくなるため、在るときだけ書く
// `usageStopped` を上の内訳へ足し合わせない: `status` と独立の横断する軸で、同じ委譲を2回数えることになるため
function describeManagerCounts(managers: readonly ManagerSummary[]): string {
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
    COUNTS_RUNNING +
    // `lost` が在るときだけ足す: 本数だけだと「終わった本数」と読まれ、`lost` は確かめるまで終われない側のため
    (lost === 0 ? '' : COUNTS_LOST) +
    (usageStopped === 0 ? '' : COUNTS_USAGE_STOPPED) +
    // `lost` を条件に混ぜない: `lost` が 0 のまま器が黙って消えた委譲だけが在る回を取りこぼすため
    (runnerVanished === 0 ? '' : COUNTS_RUNNER_VANISHED)
  );
}

// ---- `manager_list` の出力を部分ごとに組む関数 ----
// 各関数は出力の1つの部分を文字列（または行の配列）で返す。`managerListTool` はそれらを呼んでつなぐだけにする。

type ManagerListPool = ToolContext['managers'];

/** 絞り込み（status・q）と cursor の解決結果。各節の文がどの絞りを名乗るかを決める。 */
interface ManagerListScope {
  status: readonly JobStatus[] | undefined;
  q: string | undefined;
  filtering: boolean;
  queryFiltering: boolean;
  cursorStatus: readonly JobStatus[] | null;
  cursorQuery: string | null;
}

interface ManagerListItem {
  entry: string;
  marks: Set<ManagerListNoteMark>;
  manager: ManagerSummary;
}

type ManagerCursorFailure = Exclude<ReturnType<typeof resolveManagerCursor>, { kind: 'ok' }>;

/** 入力の検査と早期の戻り: 委譲が0本のときの全文。 */
function describeEmptyManagerList(
  unreadableJobNote: string | null,
  inboxBacklog: string,
  runnerBacklog: string | null,
): string {
  return [
    unreadableJobNote === null
      ? '（マネージャーは1本も居ない）'
      : '（読めたマネージャーは無い。居ないとは言えない）',
    unreadableJobNote,
    inboxBacklog,
    runnerBacklog,
  ]
    .filter((line): line is string => line !== null)
    .join('\n');
}

/** 入力の検査と早期の戻り: cursor が壊れている・`status` / `q` が cursor と食い違うときの全文。 */
function describeManagerCursorFailure(
  cursorOutcome: ManagerCursorFailure,
  scope: ManagerListScope,
  cursor: string | undefined,
): string {
  const { status, q, queryFiltering } = scope;
  if (cursorOutcome.kind === 'malformed') {
    return (
      'cursor が壊れている（この道具が返したものではないか、書き換えられている）。' +
      '一覧を先頭から読み直すには cursor を付けずに manager_list を呼ぶこと。'
    );
  }
  if (cursorOutcome.kind === 'status-mismatch') {
    const cursorStatusText =
      cursorOutcome.cursorStatus === null ? '絞っていない' : cursorOutcome.cursorStatus.join(',');
    return (
      `cursor は status: ${cursorStatusText} の一覧から出た続きの位置で、` +
      `いまの呼び（status: ${status === undefined ? '未指定' : status.join(',')}）と食い違う。` +
      'status を cursor を取ったときと揃えて呼び直すか（' +
      `manager_list ${cursorOutcome.cursorStatus === null ? '' : `status=${JSON.stringify(cursorOutcome.cursorStatus)} `}cursor=${cursor}）、` +
      'cursor を付けずに status だけで先頭から呼び直すこと。'
    );
  }
  return (
    `cursor は q: ${cursorOutcome.cursorQuery === null ? '絞っていない' : JSON.stringify(cursorOutcome.cursorQuery)} の一覧から出た続きの位置で、` +
    `いまの呼び（q: ${queryFiltering ? JSON.stringify(q) : '未指定または空'}）と食い違う。` +
    'q を cursor を取ったときと揃えて呼び直すか、cursor を付けずに先頭から呼び直すこと。'
  );
}

/** 絞り込みと並び替え: `status` と `q` で絞った載せる委譲（`statusView` は `status` だけで絞った段）。 */
function filterManagerView(
  attention: readonly ManagerSummary[],
  status: readonly JobStatus[] | undefined,
  filtering: boolean,
  queryNeedle: string,
  queryFiltering: boolean,
): { statusView: readonly ManagerSummary[]; view: readonly ManagerSummary[] } {
  const statusView =
    status !== undefined && filtering
      ? attention.filter((manager) => status.includes(manager.status))
      : attention;
  const view = queryFiltering
    ? statusView.filter((manager) =>
        managerQueryHaystacks(manager).some((text) =>
          normalizeManagerQuery(text).includes(queryNeedle),
        ),
      )
    : statusView;
  return { statusView, view };
}

/** 1本の委譲の注記の印（行に添える `MANAGER_LIST_NOTE_MARKS` の種類。意味は末尾の節に1回だけ書く）。 */
function managerRowNoteMarks(manager: ManagerSummary): Set<ManagerListNoteMark> {
  const marks = new Set<ManagerListNoteMark>();
  if (manager.runnerLostSince !== undefined) marks.add('runner-lost');
  if (manager.sessionMissingSince !== undefined) marks.add('session-missing');
  if (manager.status === 'lost') marks.add('lost');
  return marks;
}

/** 1本の委譲の「畳む候補」の注記の行。 */
function describeManagerRowFoldCandidate(
  manager: ManagerSummary,
  now: Date,
  pool: ManagerListPool,
): string | null {
  // 条件3は器の機能申告で確かめる: 名乗りを受けていない・旧い器・runnerId が無い委譲は「送っているはず」と仮定しない
  // 条件5の材料は `turnEndedAt` ではなく `updatedAt`: `turnEndedAt` は `status: 'running'` の委譲でしか計算されないため
  return describeManagerFoldCandidate(
    {
      status: manager.status,
      hasAwaitingBackgroundSignal: manager.awaitingBackground !== undefined,
      awaitingBackgroundSignalVersionConfirmed:
        manager.runnerId !== undefined &&
        (pool?.runnerHasCapability?.(
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
}

/** 1本の委譲の行の本文の前半: runner・モデル・セッション・cwd・lost・起点・前任後継・報告の観測の行。 */
function managerRowIdentityLines(
  manager: ManagerSummary,
  origins: JobOrigins,
  pool: ManagerListPool,
): (string | null)[] {
  return [
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
    `  モデル: ${describeManagerModels(managerModelsOf(pool, manager))}`,
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
  ];
}

/** 1本の委譲の注記の行: 拒否・承認待ち・返事待ち（件数の上限と「…ほか N 件」を含む）。 */
function managerRowWaitingLines(manager: ManagerSummary, pool: ManagerListPool): (string | null)[] {
  return [
    // 拒否は `status` に映らないので、状態の値は増やさず状態に添える
    denialLine(pool?.denials(manager.managerId) ?? [], manager.lastReportAt),
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
  ];
}

/** 1本の委譲の注記の行: 失敗・枠・runner 消失・報告の抜粋・ターン終了・トークン世代・畳む候補・未 push。 */
function managerRowReportLines(
  manager: ManagerSummary,
  driftMark: string,
  foldCandidateLine: string | null,
  now: Date,
): (string | null)[] {
  return [
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
  ];
}

/** 1本の委譲の行の全文（先頭3行＋上の3つの注記の行）。 */
function renderManagerListItem(
  manager: ManagerSummary,
  now: Date,
  origins: JobOrigins,
  pool: ManagerListPool,
): ManagerListItem {
  // 印は行を新しく増やさず既存の行へ添える: 行を1本増やすと予算に張り付いた一覧では出る件数が減るため
  const drift = describeReportDriftMark(manager, now);
  const driftMark = drift === null ? '' : `、${drift}`;
  const foldCandidateLine = describeManagerRowFoldCandidate(manager, now, pool);
  const marks = managerRowNoteMarks(manager);
  const entry = renderListingEntry({
    id: manager.managerId,
    title: `[${describeManagerState(manager.status, manager.live, manager.awaitingBackground)}]`,
    createdAt: manager.startedAt,
    updatedAt: manager.updatedAt,
    summary: `依頼: ${excerptLine(manager.request, LIST_REQUEST_EXCERPT)}`,
    extra: [
      ...managerRowIdentityLines(manager, origins, pool),
      ...managerRowWaitingLines(manager, pool),
      ...managerRowReportLines(manager, driftMark, foldCandidateLine, now),
    ],
  });
  return { entry, marks, manager };
}

/** 予算（`LIST_BUDGET`）で切る頁と、その内側で数えた末尾の印の意味の節。 */
function fitManagerListBudget(items: readonly ManagerListItem[]): {
  fill: ReturnType<typeof fillListingBudget>;
  noteBlock: string;
} {
  const itemTexts = items.map((item) => item.entry);
  // 末尾の注は予算の内側で数える: 外に置くと lost が多い一覧で LIST_BUDGET を越える。出る行が減れば要る注も減るので、2回目の締めは1回目の部分集合で収まる
  const firstFill = fillListingBudget(itemTexts, LIST_BUDGET, false);
  const firstNotes = managerListNotes(items.slice(0, firstFill.shown).map((item) => item.marks));
  const secondFill = fillListingBudget(
    itemTexts,
    Math.max(0, LIST_BUDGET - firstNotes.length),
    false,
  );
  const noteBlock = managerListNotes(items.slice(0, secondFill.shown).map((item) => item.marks));
  return { fill: secondFill, noteBlock };
}

/** 絞り込みの注記: `status` の行。 */
function describeStatusFilterNote(scope: ManagerListScope, statusViewCount: number): string | null {
  const { status, filtering, queryFiltering } = scope;
  // 絞ったことは件数の行とは別の行で言う: 混ぜると「絞る前の全体」と「絞った後」がどちらの数なのかを読み分ける負担が読み手に移るため
  // `status: []` は「絞らなかった」と言う: 黙って無視しないため
  return status === undefined
    ? null
    : filtering
      ? `絞り込み: status: ${status.join(',')} に当たるのは ${statusViewCount} 件で、` +
        `この一覧は${queryFiltering ? 'その中の q にも当たるものだけ' : 'その中だけ'}を出している` +
        FILTER_COUNTS_SCOPE
      : `絞り込み: status に空の配列が渡ったので、絞らずに全件を出した${FILTER_STATUS_EMPTY}`;
}

/** 絞り込みの注記: `q` の行。 */
function describeQueryFilterNote(
  scope: ManagerListScope,
  counts: { view: number; statusView: number; managers: number },
): string | null {
  const { q, filtering, queryFiltering } = scope;
  // `q` の注記も件数の行とは別の行で言う。空白だけの `q` は黙って無視せず、絞らなかったと言う
  return q === undefined
    ? null
    : queryFiltering
      ? `絞り込み: q: ${JSON.stringify(q)}` +
        FILTER_Q_MATCH +
        `に当たるのは ${counts.view} 件` +
        `${filtering ? `（status で絞った ${counts.statusView} 件の中）` : `（全 ${counts.managers} 本の中）`}で、` +
        'この一覧はその中だけを出している' +
        FILTER_COUNTS_SCOPE
      : `絞り込み: q が空（または空白だけ）だったので、q では絞らなかった${FILTER_Q_EMPTY}`;
}

/** 予算で切った頁の末尾: 「…ほか N 件は省略」と続きの cursor の案内。 */
function describeOmittedManagerRows(
  part: { rest: number; shown: number },
  view: readonly ManagerSummary[],
  paged: readonly ManagerSummary[],
  scope: ManagerListScope,
): string {
  const { rest, shown } = part;
  const { status, q, filtering, queryFiltering, cursorStatus, cursorQuery } = scope;
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
    status !== undefined && filtering ? `status: ${status.join(',')}` : null,
    queryFiltering ? `q: ${JSON.stringify(q)}` : null,
  ].filter((part): part is string => part !== null);
  return (
    `…ほか ${rest} 件は省略（` +
    (narrowed.length > 0
      ? `${narrowed.join(' と ')} に絞った ${total} 件のうち ${shown} 件を出した`
      : `全 ${total} 件`) +
    '）。' +
    OMITTED_ORDER +
    `続きは manager_list cursor=${nextCursor}${statusArg}${queryArg} で取れる（status と q は同じまま呼ぶこと）。` +
    OMITTED_PAGING
  );
}

/** 行の塊: 絞った結果が0件・cursor の最後の頁・または行と「ほか N 件は省略」を足した頁。 */
function describeManagerRowsBlock(
  fill: ReturnType<typeof fillListingBudget>,
  view: readonly ManagerSummary[],
  paged: readonly ManagerSummary[],
  scope: ManagerListScope,
): string {
  const { q, filtering, queryFiltering } = scope;
  // 絞った結果が0件なのと委譲が1本も無いのを分ける: 「無い」と読めると、絞りが厳しかっただけなのに台帳の側を疑うことになるため
  return view.length === 0
    ? queryFiltering
      ? `（${filtering ? 'この status と ' : ''}q: ${JSON.stringify(q)} の絞り込みに当たる委譲は0件だった。絞る前の件数は上の行に在る）`
      : '（この status の絞り込みに当たる委譲は無い。絞る前の件数は上の行に在る）'
    : // cursor で辿り切った最後の頁を、絞り込みの0件とは別の文にする
      paged.length === 0
      ? '（cursor より後ろの、この絞り込みに当たる委譲は無い。これが最後の頁）'
      : renderFilledListing(fill.lines, fill, {
          // `status` の有無ではなく `filtering` で分ける: `status: []` は絞っていないので、有無で分けると渡した文字が無いのに絞ったと言う嘘になるため
          // 母数は `renderListing` が渡す `total` ではなく `view.length` を使う: 頁が進んでも変わらない数にするため
          omitted: (part) => describeOmittedManagerRows(part, view, paged, scope),
        });
}

export function managerListTool(context: ToolContext) {
  // `resources()` を毎回呼ばない: 一覧のためにネットワーク往復を足し、`runner_list resources: true` というクローンの明示的な opt-in を自動で踏み潰すため、代わりにキャッシュの `runnerBacklog()` を読む
  return tool(
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
    },
    async ({ status, q, cursor }, extra: unknown) => {
      if (!context.managers) return NO_POOL;
      noteSubagentCallerGauge(context, extra);
      const managers = await context.managers.list();
      // この一覧ぜんぶで同じ「いま」を使う: 行ごとに `new Date()` を呼ぶと、同じ応答の中で判定の基準がずれるため
      const now = new Date();
      // 受信箱の滞留は早期リターンの前に確かめる: マネージャーが1本も居なくても合図が溜まっていることがあるため
      const inboxPeek = await context.stores.inbox.peekPending();
      const inboxPeekedAt = Date.now();
      const inboxQueued = context.queuedInMemory?.();
      const renderInboxBacklog = (): string =>
        describeInboxBacklog(inboxPeek, inboxPeekedAt, inboxQueued);
      // `?.() ?? []` で読まない: 「この口を持たない実装」と「持っているが1件も観測していない」を同じ `[]` へ畳み、この一覧が区別しようとしているものを潰すため
      const runnerBacklog = describeRunnerBacklog(context.managers.runnerBacklog());
      const origins = await readJobOrigins(context.stores);
      // 読めない委譲の行は「居ない」と分けて名乗る: `list()` は読めない行を飛ばすので、黙っていると壊れた行だけの台帳が「1本も居ない」に見えるため
      const unreadableJobNote = describeUnreadableJobs(
        await context.stores.jobs.listUnreadableJobs(),
      );
      if (managers.length === 0) {
        return text(
          describeEmptyManagerList(unreadableJobNote, renderInboxBacklog(), runnerBacklog),
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
      const { statusView, view } = filterManagerView(
        attention,
        status,
        filtering,
        queryNeedle,
        queryFiltering,
      );
      // cursor は `status` と `q` で絞った後・予算で切る前で解決する: 順序を変えると絞りに当たらない行が窓を食い尽くすため
      const cursorStatus = normalizeManagerCursorStatus(status);
      const cursorQuery = queryFiltering ? queryNeedle : null;
      const scope: ManagerListScope = {
        status,
        q,
        filtering,
        queryFiltering,
        cursorStatus,
        cursorQuery,
      };
      const cursorOutcome = resolveManagerCursor(
        view,
        managerPositionOf,
        cursorStatus,
        cursor,
        cursorQuery,
      );
      if (cursorOutcome.kind !== 'ok') {
        return text(describeManagerCursorFailure(cursorOutcome, scope, cursor));
      }
      const paged = cursorOutcome.view;
      // 予算を先に決めて入るところまで積む: 件数から出力量を決めると何件で壊れるかが運任せになるため
      const items = paged.map((manager) =>
        renderManagerListItem(manager, now, origins, context.managers),
      );
      const { fill, noteBlock } = fitManagerListBudget(items);
      return text(
        dedupeRestartAdvice(
          [
            // 本数は一覧の外に出す: 一覧は予算で打ち切られ、出ている行を数えても全体の本数にならないため。件数は絞る前の全件で出す: 絞りのせいで全体の実像が見えなくなる形にしないため
            describeManagerCounts(managers),
            unreadableJobNote,
            describeStatusFilterNote(scope, statusView.length),
            describeQueryFilterNote(scope, {
              view: view.length,
              statusView: statusView.length,
              managers: managers.length,
            }),
            describeManagerRowsBlock(fill, view, paged, scope),
            '（依頼と報告は抜粋。全文は manager_report <managerId> で取れる）',
            noteBlock === '' ? null : noteBlock,
            renderInboxBacklog(),
            runnerBacklog,
          ]
            .filter((line): line is string => line !== null)
            .join('\n'),
        ),
      );
    },
  );
}
