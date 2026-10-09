import { isDaemonAnsweredTool } from './daemon-answered-tool.js';
import { describeValidity, statusValidity } from './inbox-validity.js';
import type { JobStatus } from './schema.js';

// `unknown` を `active` へ倒さない: 観測が無いのと進んでいるのは別で、依頼者が待つか諦めるかの分かれ目になる。
// `tool-running` を `stalled-tool-use` と分ける: 既定の `permissionMode: 'auto'` では `Bash` などの普通の道具は `canUseTool` を通らず、`waiting` が空でも矛盾ではない。
export type ManagerActivityKind =
  'stalled-turn-end' | 'stalled-tool-use' | 'tool-running' | 'active' | 'unknown';

// `ManagerSummary` / `ManagerRecord` のどちらにも依存しない構造的な型にする: 判定を `tools.ts` と `manager.ts` の2箇所でコピーせず、1本を両方から呼ぶため。
export interface ManagerActivityInput {
  readonly turnEndReason?: string;
  readonly turnEndedAt?: string;
  readonly lastReportAt?: string;
  readonly toolUseStallPending?: readonly { readonly id: string; readonly name?: string }[];
  readonly waitingCount: number;
}

// 分からないものを「止まっていない」へ倒さない: 欠けている・`NaN` はすべて止まっている側に倒す。
function isTurnEndStalled(
  turnEndedAt: string | undefined,
  lastReportAt: string | undefined,
): boolean {
  if (turnEndedAt === undefined) return true;
  if (lastReportAt === undefined) return true;
  const turnEndedAtMs = Date.parse(turnEndedAt);
  const lastReportAtMs = Date.parse(lastReportAt);
  if (Number.isNaN(turnEndedAtMs) || Number.isNaN(lastReportAtMs)) return true;
  return !(turnEndedAtMs <= lastReportAtMs);
}

// 名前が取れなかった道具（欄が無い・空白だけ）は「満たす」側に数える: 普通の道具だと決め打って `tool-running`（何もしなくてよい）へ落とすと、本当に止まっていたときに見逃す。
function hasDaemonAnsweredStallTrigger(
  pending: NonNullable<ManagerActivityInput['toolUseStallPending']>,
): boolean {
  return pending.some(
    (item) => item.name === undefined || item.name.trim() === '' || isDaemonAnsweredTool(item.name),
  );
}

// ここが何を返しても呼び出し元の `status` は動かない。
// ターン終わり型を道具待ち型より優先する（`manager.ts` 側の計算順と同じ）。
// 未応答の道具に1件でも `isDaemonAnsweredTool` を満たすものがあれば `stalled-tool-use` に倒す: `AskUserQuestion` と `Bash` が並行しているとき、`Bash` の存在で `AskUserQuestion` 側の矛盾を覆い隠さないため。
export function classifyManagerActivity(input: ManagerActivityInput): ManagerActivityKind {
  const hasTurnEndObservation = input.turnEndReason !== undefined;
  const pending = input.toolUseStallPending;
  const hasToolUseStallObservation = pending !== undefined && pending.length > 0;

  if (!hasTurnEndObservation && !hasToolUseStallObservation) return 'unknown';

  if (hasTurnEndObservation && isTurnEndStalled(input.turnEndedAt, input.lastReportAt)) {
    return 'stalled-turn-end';
  }

  if (hasToolUseStallObservation && input.waitingCount === 0) {
    return hasDaemonAnsweredStallTrigger(pending) ? 'stalled-tool-use' : 'tool-running';
  }

  return 'active';
}

// `'active'` も空文字にせず必ず字を出す: 空だと「進んでいる」と「判定の結線が壊れて1行も足されなかった」が字面で区別できず、静かに失敗する。
// 一覧（`describeTurnEnd` など。全マネージャーを並べるので `null` で黙る）と違い、この文面は既に異常と分かっている委譲について30分に1回だけ出るので、1行増える費用は無視できる。
// `'unknown'` は `'active'` と字面で区別する: 「進んでいるので待つ」と「観測が無いので分からない」を読み違えないため。
export function describeManagerActivityForFlush(kind: ManagerActivityKind): string {
  switch (kind) {
    case 'stalled-turn-end':
      return (
        ' ⚠ この委譲はターンが終わっているらしいのに、報告がまだ届いていない' +
        '（#567 の形）。manager_list で `turnEndedAt` / `turnEndReason` を確かめること。'
      );
    case 'stalled-tool-use':
      return (
        ' ⚠ この委譲は道具の応答待ちのまま、誰もその応答を待っていない' +
        '（#572 の形）。manager_list で `toolUseStallPending` を確かめること。'
      );
    case 'tool-running':
      return (
        ' 道具を実行中。止まっている兆候ではない（Issue #2173）。' +
        'manager_list で `toolUseStallPending` の name を確かめること。急かさなくてよい。'
      );
    case 'unknown':
      return (
        ' 進んでいるか止まっているかは判定できない（観測がまだ無い）。' +
        '急かさず、次の一覧まで待つこと。'
      );
    case 'active':
      return ' 進んでいる（止まっている兆候は無い）。急かさなくてよい。';
    default: {
      const exhaustive: never = kind;
      throw new Error(`未知の ManagerActivityKind: ${JSON.stringify(exhaustive)}`);
    }
  }
}

// drift が無い回・記録した status が無い古い行・報告が一度も届いていない回は空文字を返す: `manager_list` / `manager_report` が「1文字も足さない」の合図として使う。
// `running` / `waiting_human` のような status の名簿は作らず、判定は `statusValidity` の `changed` をそのまま使う。
// `now` を引数で受け取る: 純関数に保つため。
export function describeReportDrift(input: {
  readonly managerId: string;
  readonly lastReportAt?: string;
  readonly lastReportStatus?: JobStatus;
  readonly status: JobStatus;
  readonly now: Date;
}): string {
  if (input.lastReportAt === undefined) return '';
  const validity = statusValidity(input.lastReportStatus, { status: input.status });
  if (validity.kind !== 'changed') return '';
  const elapsedMs = input.now.getTime() - Date.parse(input.lastReportAt);
  // `NaN`・未来向きの経過は age を言わず drift だけを言う: drift 自体は `statusValidity` が確かめ済みで揺るがない。
  const ageClause =
    Number.isNaN(elapsedMs) || elapsedMs < 0
      ? 'この報告は'
      : `この報告は${formatMinutesAgo(elapsedMs)}のもので、`;
  return (
    `${describeValidity(validity, input.managerId, '台帳へ書かれた')} ` +
    `${ageClause}いま走っているターンの中身ではない。`
  );
}

// `clone.ts` の `formatElapsed` を共通化しない: あちらは private で、丸め方の粒度（秒単位から／分単位から）が違い、共通化すると字面が変わる。
function formatMinutesAgo(elapsedMs: number): string {
  const minutes = Math.floor(elapsedMs / 60000);
  if (minutes < 1) return '1分未満前';
  if (minutes < 60) return `${minutes}分前`;
  const hours = Math.floor(minutes / 60);
  const remainderMinutes = minutes % 60;
  if (hours < 24) return `${hours}時間${remainderMinutes}分前`;
  const days = Math.floor(hours / 24);
  const remainderHours = hours % 24;
  return `${days}日${remainderHours}時間前`;
}
