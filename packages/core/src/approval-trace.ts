import { excerptLine, renderListing } from './excerpt.js';
import { scanJournalPages } from './journal-scan.js';
import { describeAnsweredVia } from './schema.js';
import type { JournalEntry, JournalEntryInput, PendingApproval } from './schema.js';
import type { JournalStore, Stores } from './store.js';
import { describeTraceAction } from './trace-action.js';
import { CLONE_ACTOR_ID, CLONE_SUB_ACTOR_PREFIX } from './usage.js';

/**
 * 承認の答えと、その後にクローンが取った行動を**対で**読む口（issue #847 の案B）。
 *
 * ## なぜ在るか
 *
 * 答え（`approvals` と日誌の `escalation`）とその後の行動（`decision` /
 * `memory_update` / `tool_use` / 返信）は、どちらも記録には残っていたが、
 * **別々の行として散らばっていた。** 行動の側に「どの答えの後か」を運ぶ欄が
 * 無く（人間の会話への返信の `approvalId` だけが例外。#782）、対は日誌の到着順の
 * 近さでしか結べなかった——並行して届いた別の合図への行動を拾っても区別が
 * 付かない。
 *
 * 直し方は2段である。(1) 書く側: 答えのターンの中でクローン自身が書いた行へ
 * `answeredApprovalId` を立てる（`clone.ts` の `case 'human_answer'` と
 * `#journalToolUse`、`#toolContext` の日誌の包み。立てる規則は
 * {@link stampAnsweredApproval} の1か所に在る）。(2) 読む側: この印で串刺しに
 * した1本の読み口（{@link traceApproval}）。クローンの `approval_trace`・
 * `GET /approvals/:id/trace`・CLI の `/approval-trace` の3つが同じこの関数を通る
 * （PRD「インターフェース」——片方でしかできないことを作らない）。
 *
 * ## ⛔ 一般化した「基準」をここで作らない
 *
 * issue #847 の受け入れ基準「一般化した『基準』を機械が書かない」。ここが返すのは
 * **並べた対だけ**である——要約・分類・「この答えから言えること」を1文字も
 * 足さない。何を学ぶかは人間とクローンの会話の側が決める（案A を採らなかった
 * 理由が issue に逐語で在る——1件からの一般化は外す）。
 *
 * ## 「対が無い」を1つの顔にしない
 *
 * 対が0件になる理由は複数あり、**どれも「行動が無い」とは限らない**。
 * {@link ApprovalTraceState} が分ける:
 *
 * - `no_turn_start`: 答えを受けたターンの入口の行が、見た窓の中に無い（まだ
 *   配られていない／窓の外）
 * - `turn_before_recording`: 入口は在るが、印（`answeredApprovalId`）を持たない
 *   ——**この記録を始める前のターンである。行動が無いのではなく、記録していない**
 * - `unstamped_actions`: 印を持つ入口が在るのに、同じターンらしき区間に印の無い
 *   クローンの行動が在る——**記録が動いていない疑い**（issue の受け入れ基準
 *   「対が0件と記録が動いていないを区別できる」）
 * - `no_actions`: 印を持つ入口が在り、その区間にクローンの行動が1件も無い
 */

/**
 * 答えのターンの中で書く1行へ、その承認の id を立てる（書く側の規則の1か所）。
 *
 * **立てるのは「クローン自身の行動」の型だけである**: `decision` /
 * `memory_update` / `tool_use` / outbound の `exchange`。inbound の `exchange`
 * （ターンの入口の行）はここでは立てない——入口は「行動」ではなく対の錨なので、
 * `clone.ts` の `case 'human_answer'` が明示的に立てる（ここで立てると、ターンの
 * 途中で書かれた別の inbound まで錨に見える）。
 *
 * **`approvalId` が `null` なら入力をそのまま返す**（承認に由来しないターン）。
 * 呼び出し側に条件分岐を書かせないための形で、印が付くかどうかの判断は全部ここに
 * 在る。
 */
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

/**
 * 道具（`tools.ts`）へ渡す日誌を包み、`append` の度に {@link stampAnsweredApproval}
 * を通す。
 *
 * **道具の側を1本ずつ直さない理由。** `decision` / `memory_update` を書く道具は
 * 何本もあり（`journal_write`・`memory_*`・`commitment_*`…）、1本ずつ印を足すと
 * 次に足す道具が落としても何も赤くならない（`digest.ts` の冒頭が記録している
 * 「書き忘れても何も落ちなかった」形）。器の口で包めば、道具は印の存在を知らない
 * まま全部が同じ規則を通る。
 *
 * `currentApprovalId` は呼ぶたびに読む——包みは `#toolContext()` が作るが、
 * 道具が実際に書くのはターンの途中なので、作った時点の値で凍らせると外れる。
 */
export function stampingJournal(
  journal: JournalStore,
  currentApprovalId: () => string | null,
): JournalStore {
  return {
    append: (entry) => journal.append(stampAnsweredApproval(entry, currentApprovalId())),
    list: (query) => journal.list(query),
    get: (id) => journal.get(id),
    oldestAt: () => journal.oldestAt(),
    clear: () => journal.clear(),
  };
}

/**
 * 答えの後を何件まで見るか（`scanJournalPages` の `maxScanned`）。
 *
 * **無制限にしない。** 答えのターンは通常すぐ後に在るが、受信箱が詰まっていれば
 * 遠くなり、その間の `tool_use` は1ターンで数百行になりうる。上限に当たったら
 * `truncated` を出力に出す（「無い」ではなく「この窓には無い」）。5,000 は
 * `JOURNAL_SCAN_PAGE_SIZE`（500）の10往復ぶんで、経験則である。
 */
export const APPROVAL_TRACE_SCAN_LIMIT = 5000;

/**
 * 印の付いた行動を何件まで持つか。超えた分は数だけ数える（`actionsOmitted`）。
 * HTTP の応答に全文の行をそのまま載せるので、ヒープと応答の大きさを有界にする。
 */
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

/**
 * 対の状態。意味はこのファイル冒頭の doc「『対が無い』を1つの顔にしない」。
 * 配列を正本にしてあるのは、HTTP の応答の schema（`apps/daemon/src/openapi.ts`）が
 * 同じ値の列を `z.enum` で引くため——手で写すと片方だけ増える。
 */
export type ApprovalTraceState = (typeof APPROVAL_TRACE_STATES)[number];

export interface ApprovalTrace {
  approval: PendingApproval;
  state: ApprovalTraceState;
  /** 問いの日誌の行（`escalation`、`answeredAt` も `withdrawnAt` も無いもの）。見つからなければ null。 */
  questionEntry: JournalEntry | null;
  /** 答えの日誌の行（`escalation` の `answeredAt` 付き）。未回答・見つからなければ null。 */
  answerEntry: JournalEntry | null;
  /** 答えを受けたターンの入口の行（配り直しで複数ありうる）。 */
  turnStarts: JournalEntry[];
  /** 印（`answeredApprovalId`）がこの承認を指す行動。古い順。 */
  actions: JournalEntry[];
  /** {@link APPROVAL_TRACE_ACTION_LIMIT} を超えて持たなかった行動の件数。 */
  actionsOmitted: number;
  /**
   * 印を持つ入口の直後から次のターンの入口らしき行までの区間で、**印の無い**
   * クローンの行動の件数。区間の終わりは推定である（{@link isTurnBoundary}）。
   */
  unstampedInTurn: number;
  /** 答えの後に見た日誌の行数。 */
  scanned: number;
  /** {@link APPROVAL_TRACE_SCAN_LIMIT} に当たって走査を止めたか。 */
  truncated: boolean;
}

/**
 * 答えを受けたターンの入口の行か。
 *
 * **印（構造化した欄）と本文の両方で見る。** 印はこの変更から立つので、それより
 * 前の入口は本文（`turn-input.ts` の `ターンの入力: human_answer approvalId=<id>`）
 * でしか見つからない——本文で拾えないと、古い答えが `turn_before_recording`
 * ではなく `no_turn_start` に倒れ、「記録していない」と「ターンが無い」が混ざる。
 */
function isTurnStartFor(entry: JournalEntry, approvalId: string): boolean {
  if (entry.type !== 'exchange' || entry.with !== 'self' || entry.role !== 'inbound') return false;
  return (
    entry.answeredApprovalId === approvalId ||
    entry.text.includes(`human_answer approvalId=${approvalId}`)
  );
}

/**
 * 次のターンの入口らしき行か。**推定である**——ターンの境界そのものは日誌に
 * 構造化されていない。人間の発言（`human` の inbound）とターンの入力の行
 * （`self` の inbound）で区切る。外れても影響するのは `unstampedInTurn` の数
 * だけで、印の付いた行動（対の本体）はこの推定を通らない。
 */
function isTurnBoundary(entry: JournalEntry): boolean {
  return (
    entry.type === 'exchange' &&
    entry.role === 'inbound' &&
    (entry.with === 'human' || entry.with === 'self')
  );
}

/**
 * クローン本体の行動か（`unstampedInTurn` を数える側の定義）。
 *
 * 蒸留（`memory_update.cause: 'distill'`・`clone:distill` の `tool_use`）は
 * 答えのターンと並行して走りうるので数えない。**`decision` は人間が API から
 * 直接操作した記録も入る**（`schema.ts` の `decision.grounds` の doc）ので、
 * この数には混ざりうる——出力でもそう断る。
 */
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

/**
 * 1件の承認について、問い・答え・答えの後の行動を集める。承認が無ければ null。
 *
 * **材料は日誌と承認待ちの器だけ**で、書き込みは1つも無い（読む口である）。
 */
export async function traceApproval(
  stores: Pick<Stores, 'jobs' | 'journal'>,
  approvalId: string,
): Promise<ApprovalTrace | null> {
  const approval = await stores.jobs.getApproval(approvalId);
  if (!approval) return null;

  // --- 問いと答えの行（escalation だけを、問いの時刻から古い順に） ---
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

  // --- 答えの後（古い順） ---
  const turnStarts: JournalEntry[] = [];
  const actions: JournalEntry[] = [];
  let actionsOmitted = 0;
  let unstampedInTurn = 0;
  // 印を持つ入口の後、次の境界までの区間に居るか。
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

/**
 * 行動1件を「何をしたか」の1文にする関数の正本は `trace-action.ts`
 * （`@alteroid/core/trace-action`）へ移した——理由はそちらの doc を見よ。
 * ここから再輸出するだけで、`describeTraceAction` を import している
 * 既存の呼び手（このファイルの `renderApprovalTrace`、`index.ts` 経由で
 * CLI・クローンの道具）は変更不要である（`schema.ts` の
 * `describeAnsweredVia` の再輸出と同じ形。PR #1526）。
 */
export { describeTraceAction } from './trace-action.js';

/** {@link renderApprovalTrace} の出し方。 */
export interface ApprovalTraceRenderOptions {
  /**
   * 行動の一覧の文字数の予算。`null` なら切らない（人間へ返す CLI）。
   * クローンへ返す口は必ず渡す（`.claude/skills/listing-and-detail/SKILL.md`）。
   */
  budget: number | null;
  /** 行動1件の要旨の文字数。`null` なら全文。 */
  summaryLimit: number | null;
  /** 全文の取り方の案内（例: `journal_read id=<id>`）。切ったときに出す。 */
  detailHint: string;
}

/** 状態ごとの「対が無い」の言い方。`paired` 以外で使う。 */
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

/**
 * 対を文字にする。クローンの道具と CLI が同じこの関数を通る（出す中身を口ごとに
 * 違えない。違うのは予算と要旨の長さだけ）。
 */
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
      // **回答経路（Issue #1479）。** 記録が無い（`answeredVia` を渡さずに答えた
      // 古い経路）行では何も足さない——「わからない」を「operator ではない」に
      // 化けさせない（`answeredViaSchema` の doc）。
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
