import { excerptLine, renderListing } from './excerpt.js';
import { scanJournalPages } from './journal-scan.js';
import { describeAnsweredVia } from './schema.js';
import type { JournalEntry, JournalEntryInput, PendingApproval } from './schema.js';
import type { JournalStore, Stores } from './store.js';
import { describeTraceAction } from './trace-action.js';
import { CLONE_ACTOR_ID, CLONE_SUB_ACTOR_PREFIX } from './usage.js';

// inbound の `exchange` に印を立てない: ターンの途中で書かれた別の inbound まで錨に見えるため
export function stampAnsweredApproval(
  entry: JournalEntryInput,
  approvalId: string | null,
): JournalEntryInput {
  if (approvalId === null) return entry;
  switch (entry.type) {
    case 'decision':
    case 'memory_update':
    case 'tool_use':
      return { ...entry, answeredApprovalId: approvalId };
    case 'exchange':
      return entry.role === 'outbound' ? { ...entry, answeredApprovalId: approvalId } : entry;
    default:
      return entry;
  }
}

// 道具を1本ずつ直さない: 次に足す道具が印を落としても何も赤くならないため
// currentApprovalId は呼ぶたびに読む: 道具が書くのはターンの途中なので、作った時点の値で凍らせると外れるため
export function stampingJournal(
  journal: JournalStore,
  currentApprovalId: () => string | null,
): JournalStore {
  return {
    append: (entry) => journal.append(stampAnsweredApproval(entry, currentApprovalId())),
    list: (query) => journal.list(query),
    listPage: (query) => journal.listPage(query),
    get: (id) => journal.get(id),
    oldestAt: () => journal.oldestAt(),
    clear: () => journal.clear(),
  };
}

// 無制限にしない: 受信箱が詰まると答えのターンが遠くなり、その間の `tool_use` が数百行になりうるため
export const APPROVAL_TRACE_SCAN_LIMIT = 5000;

export const APPROVAL_TRACE_ACTION_LIMIT = 500;

export const APPROVAL_TRACE_STATES = [
  'unanswered',
  'withdrawn',
  'paired',
  'no_turn_start',
  'turn_before_recording',
  'unstamped_actions',
  'no_actions',
] as const;

export type ApprovalTraceState = (typeof APPROVAL_TRACE_STATES)[number];

export interface ApprovalTrace {
  approval: PendingApproval;
  state: ApprovalTraceState;
  questionEntry: JournalEntry | null;
  answerEntry: JournalEntry | null;
  turnStarts: JournalEntry[];
  actions: JournalEntry[];
  actionsOmitted: number;
  unstampedInTurn: number;
  scanned: number;
  truncated: boolean;
}

// 本文でも見る: 印が立つ前の入口は本文でしか見つからず、拾えないと `turn_before_recording` が `no_turn_start` に倒れるため
function isTurnStartFor(entry: JournalEntry, approvalId: string): boolean {
  if (entry.type !== 'exchange' || entry.with !== 'self' || entry.role !== 'inbound') return false;
  return (
    entry.answeredApprovalId === approvalId ||
    entry.text.includes(`human_answer approvalId=${approvalId}`)
  );
}

function isTurnBoundary(entry: JournalEntry): boolean {
  return (
    entry.type === 'exchange' &&
    entry.role === 'inbound' &&
    (entry.with === 'human' || entry.with === 'self')
  );
}

// 蒸留を数えない: 答えのターンと並行して走りうるため
function isCloneAction(entry: JournalEntry): boolean {
  switch (entry.type) {
    case 'decision':
      return true;
    case 'memory_update':
      return entry.cause === 'clone';
    case 'tool_use':
      return entry.actor === CLONE_ACTOR_ID || entry.actor.startsWith(CLONE_SUB_ACTOR_PREFIX);
    case 'exchange':
      return entry.role === 'outbound' && (entry.with === 'human' || entry.with === 'self');
    default:
      return false;
  }
}

export async function traceApproval(
  stores: Pick<Stores, 'jobs' | 'journal'>,
  approvalId: string,
): Promise<ApprovalTrace | null> {
  const approval = await stores.jobs.getApproval(approvalId);
  if (!approval) return null;

  let questionEntry: JournalEntry | null = null;
  let answerEntry: JournalEntry | null = null;
  const wantAnswer = approval.answeredAt !== undefined;
  await scanJournalPages(
    stores.journal,
    { types: ['escalation'], since: approval.createdAt, order: 'asc' },
    (page) => {
      for (const entry of page) {
        if (entry.type !== 'escalation' || entry.approvalId !== approvalId) continue;
        if (entry.answeredAt !== undefined) answerEntry ??= entry;
        else if (entry.withdrawnAt === undefined) questionEntry ??= entry;
      }
      return !(questionEntry !== null && (!wantAnswer || answerEntry !== null));
    },
    { maxScanned: APPROVAL_TRACE_SCAN_LIMIT },
  );

  const base = {
    approval,
    questionEntry,
    answerEntry,
    turnStarts: [] as JournalEntry[],
    actions: [] as JournalEntry[],
    actionsOmitted: 0,
    unstampedInTurn: 0,
    scanned: 0,
    truncated: false,
  };
  if (approval.withdrawnAt !== undefined) return { ...base, state: 'withdrawn' };
  if (approval.answeredAt === undefined) return { ...base, state: 'unanswered' };

  const turnStarts: JournalEntry[] = [];
  const actions: JournalEntry[] = [];
  let actionsOmitted = 0;
  let unstampedInTurn = 0;
  let inStampedTurn = false;
  const { scanned, truncated } = await scanJournalPages(
    stores.journal,
    {
      types: ['exchange', 'decision', 'memory_update', 'tool_use'],
      since: approval.answeredAt,
      order: 'asc',
    },
    (page) => {
      for (const entry of page) {
        if (isTurnStartFor(entry, approvalId)) {
          turnStarts.push(entry);
          inStampedTurn = entry.type === 'exchange' && entry.answeredApprovalId === approvalId;
          continue;
        }
        if (isTurnBoundary(entry)) {
          inStampedTurn = false;
          continue;
        }
        const stamp = 'answeredApprovalId' in entry ? entry.answeredApprovalId : undefined;
        if (stamp === approvalId) {
          if (actions.length < APPROVAL_TRACE_ACTION_LIMIT) actions.push(entry);
          else actionsOmitted += 1;
        } else if (inStampedTurn && isCloneAction(entry)) {
          unstampedInTurn += 1;
        }
      }
    },
    { maxScanned: APPROVAL_TRACE_SCAN_LIMIT },
  );

  const stampedStart = turnStarts.some(
    (entry) => entry.type === 'exchange' && entry.answeredApprovalId === approvalId,
  );
  const state: ApprovalTraceState =
    actions.length + actionsOmitted > 0
      ? 'paired'
      : turnStarts.length === 0
        ? 'no_turn_start'
        : !stampedStart
          ? 'turn_before_recording'
          : unstampedInTurn > 0
            ? 'unstamped_actions'
            : 'no_actions';
  return {
    ...base,
    state,
    turnStarts,
    actions,
    actionsOmitted,
    unstampedInTurn,
    scanned,
    truncated,
  };
}

export { describeTraceAction } from './trace-action.js';

export interface ApprovalTraceRenderOptions {
  budget: number | null;
  summaryLimit: number | null;
  detailHint: string;
}

function describeMissingPair(trace: ApprovalTrace): string {
  const window = trace.truncated
    ? `（答えの後 ${trace.scanned} 行までしか見ていない。この窓の外に在りうる）`
    : '';
  switch (trace.state) {
    case 'unanswered':
      return 'まだ答えが無い。';
    case 'withdrawn':
      return `答えは無い（${trace.approval.withdrawnAt} に取り下げ）。`;
    case 'no_turn_start':
      return `答えを受けたターンの入口の行が無い。まだ配られていないか、見た窓の外である${window}。`;
    case 'turn_before_recording':
      return (
        '答えを受けたターンは在るが、答えと行動を対で記録し始める前のものである。' +
        '⟹ 行動が無いのではなく、記録していない（issue #847 の案B より前の答え）。'
      );
    case 'unstamped_actions':
      return (
        `⚠️ 答えのターンの区間に、この承認の印を持たないクローンの行動が ${trace.unstampedInTurn} 件在る。` +
        '記録が動いていない疑いがある（区間の終わりは推定で、人間が API から直接書いた判断も混ざりうる）。'
      );
    case 'no_actions':
      return `答えの後にこの承認に紐づいた行動は記録されていない${window}。`;
    case 'paired':
      return '';
  }
}

export function renderApprovalTrace(
  trace: ApprovalTrace,
  options: ApprovalTraceRenderOptions,
): string {
  const { approval } = trace;
  const cut = (text: string) =>
    options.summaryLimit === null ? text : excerptLine(text, options.summaryLimit);
  const lines = [
    `承認 ${approval.id}（${approval.createdAt}）`,
    `問い: ${cut(approval.question)}` +
      (trace.questionEntry === null
        ? '（日誌に問いの行が見当たらない）'
        : `（日誌 ${trace.questionEntry.id}）`),
  ];
  if (approval.answeredAt === undefined) {
    lines.push(`答え: ${describeMissingPair(trace)}`);
    return lines.join('\n');
  }
  lines.push(
    `答え（${approval.answeredAt}）: ${cut(approval.answer ?? '')}` +
      // 記録が無い行では何も足さない: 「わからない」を「operator ではない」に化けさせないため
      (approval.answeredVia === undefined
        ? ''
        : `（回答経路: ${describeAnsweredVia(approval.answeredVia)}）`) +
      (trace.answerEntry === null
        ? '（日誌に答えの行が見当たらない）'
        : `（日誌 ${trace.answerEntry.id}）`),
  );
  lines.push(
    trace.turnStarts.length === 0
      ? 'ターンの入口: 無い'
      : `ターンの入口: ${trace.turnStarts.map((entry) => `${entry.id}（${entry.at}）`).join(', ')}`,
  );
  if (trace.state !== 'paired') {
    lines.push(`その後の行動: ${describeMissingPair(trace)}`);
    return lines.join('\n');
  }
  const total = trace.actions.length + trace.actionsOmitted;
  lines.push(`その後の行動（この承認の印を持つもの。古い順）: ${total} 件`);
  const items = trace.actions.map(
    (entry) => `- ${entry.id}（${entry.at}）${cut(describeTraceAction(entry))}`,
  );
  lines.push(
    options.budget === null
      ? items.join('\n')
      : renderListing(items, {
          budget: options.budget,
          omitted: ({ rest, shown }) =>
            `…ほか ${rest} 件は省略（古い順に先頭から ${shown} 件だけ出した）。`,
        }),
  );
  if (trace.actionsOmitted > 0) {
    lines.push(`…印を持つ行動のうち ${trace.actionsOmitted} 件は数えただけで持っていない。`);
  }
  if (trace.unstampedInTurn > 0) {
    lines.push(
      `⚠️ 同じターンの区間に、印を持たないクローンの行動が ${trace.unstampedInTurn} 件在る（区間の終わりは推定）。`,
    );
  }
  if (trace.truncated) {
    lines.push(`（答えの後 ${trace.scanned} 行までしか見ていない。これより後の行動は含まれない）`);
  }
  lines.push(options.detailHint);
  return lines.join('\n');
}
