import { randomUUID } from 'node:crypto';

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

import {
  bySpeaker,
  collectConversations,
  humanExchanges,
  reachedStart,
  readConversationWindow,
  searchExchanges,
  toMessage,
} from './conversation.js';
import { isCronExpression } from './cron.js';
import { assertNeverRunnerLegStatus } from './runner-protocol.js';
// **`manager_list` と digest の「マネージャー」節で同じ字面を出すための唯一の
// 生成元。** 片方だけ変えられると区別が潰れる——実際にクローンがそれで誤り、
// 終わった仕事へ3本目の委譲を出した（`digest.ts` の `describeManagerState` の
// doc に実害の詳細がある）。
import { describeManagerState, describeSessionMissingKind } from './digest.js';
import {
  describeDroppedTraceEmpty,
  describeDroppedTraceOrigin,
  describeDroppedTraceRetention,
  droppedTraceLedgerSince,
  RECENT_TRACE_LIMIT,
  recentDroppedTraces,
} from './dropped-record.js';
import { toAgentTokenView, tokenAvailabilityAt } from './token-pool.js';
import {
  describePage,
  excerpt,
  excerptLine,
  page,
  renderListing,
  renderListingEntry,
  renderListingFromEnd,
} from './excerpt.js';
import { classifyManagerActivity } from './manager-activity.js';
import type { ManagerActivityInput } from './manager-activity.js';
import type {
  ManagerDenial,
  ManagerPool,
  ManagerSummary,
  RunnerBacklogSnapshot,
} from './manager.js';
import {
  applyMemoryFrontmatterPatch,
  assertNeverMemoryProtectionStatus,
  containsMemoryFrontmatterLineBreak,
  cutMemorySection,
  describeMemoryFloor,
  describeMemoryPremiseRanking,
  describeMemoryReinjectionEstimate,
  describeMemorySessionDelta,
  describeMemoryWriteDiff,
  formatMemoryCreatedAt,
  isKnownMemoryDocKind,
  lookupMemorySection,
  measureMemoryFloor,
  parseMemoryFrontmatter,
  renderMemoryDocuments,
  renderMemoryListing,
  renderMemoryOutline,
  resolveMemoryDocKind,
  scanMemorySections,
} from './memory.js';
import type { MemoryPart, MemorySectionLookup } from './memory.js';
import type { ProfileService } from './profile-service.js';
import {
  RESERVED_SCHEDULE_KINDS,
  describeScheduleSpec,
  localDate,
  localDayRange,
  parseTimeOfDay,
} from './schedule.js';
import type { ScheduleStatus } from './schedule.js';
import {
  JOURNAL_ENTRY_TYPES,
  approvalUpdatedAt,
  commitmentOriginSchema,
  commitmentUpdatedAt,
  scheduleKindSchema,
  scheduleSpecSchema,
} from './schema.js';
import type {
  ChatStreamEvent,
  Commitment,
  CommitmentOrigin,
  JournalEntry,
  MemoryDocumentMeta,
  MemoryProtectionStatus,
  PendingApproval,
  ScheduleSpec,
  ScheduledRequest,
} from './schema.js';
import { describeRevisionStatus } from './revision.js';
import { CANON_REVISION, canonDocument, canonNames, describeCloneRuntime } from './self.js';
import type { CloneRuntimeFacts } from './self.js';
import { EXCHANGE_WITH_VALUES, UnreadableCommitmentError } from './store.js';
import type { Stores } from './store.js';
import type { AccountUsageState } from './usage-snapshot.js';
import {
  ACCOUNT_USAGE_TITLE,
  describeAccountUsage,
  describeUnrecordedManagers,
  findUnrecordedManagers,
  formatUsd,
  summarizeUsage,
  usageLayerSchema,
  usageSiteSchema,
  type UsageAggregate,
  type UsageBreakdown,
  type UsageTotals,
} from './usage.js';

/**
 * クローンの道具（インプロセス MCP）。
 *
 * **ここにあるのは「足す分」であって「持てる全部」ではない。** クローンは preset
 * 一式（`tools` を渡さない）と人間の MCP 連携（`settingSources`）も持っていて、
 * ここに並ぶのは alteroid 固有の口 — 記憶・日誌・承認・委譲・実行環境 — だけである
 * （`clone.ts` の `#buildOptions`）。
 *
 * **「クローンは組み込みツールを持たない」と書き足さないこと。** 一度そう書いて
 * 実装もそうなっていたが、それは north_star「適用範囲」が名指しで否定している推論
 * だった（人間は道具を持たない存在ではない ＝ 写像として成り立たない。#32）。
 *
 * モデルから見える名前は `mcp__alteroid__<tool>` になる。
 */
export const MCP_SERVER_NAME = 'alteroid';

export interface ToolContext {
  stores: Stores;
  /** いま人間と繋がっている会話へイベントを流す（繋がっていなければ捨てる）。 */
  emit(event: ChatStreamEvent): void;
  /**
   * 委譲先。省略できるのは蒸留用の短命セッションのためで、そこでは
   * マネージャーを起こさない（記憶へ移すだけの内部ターン）。
   */
  managers?: ManagerPool;
  /**
   * 実行環境プロファイルを置いて配るための器と宛先。
   *
   * **クローンにも人間と同じ手を持たせる。** 人間は自分の `~/.zshenv` を開いて
   * 直せるのだから、その写像であるクローンにできないのは能力の削除である
   * （north_star 禁止2 は層を問わず効く）。鍵が文脈に載ることは**方針**
   * （システムプロンプト）で扱い、道具を取り上げて表現しない。
   */
  profile?: ProfileService;
  /**
   * アカウント全体の利用状況（claude.ai 側が言っている値）を読む口。
   *
   * **人間が `claude.ai/settings/usage` で見られるものである。** クローンが
   * 見られないのは能力の削除（north_star 禁止1）なので、`usage_read` から同じものを
   * 返す。無ければ「まだ分からない」と出す — **0 とは言わない。**
   */
  accountUsage?: () => AccountUsageState;
  /**
   * いま自分がどう走っているか（`self_status` の材料）。
   *
   * **省略できるのはテストのためだけである。** 本番の配線（`clone.ts`）は本セッションと
   * 蒸留のサイドクエリの両方へ渡す。落とすと、渡し忘れた側だけ `self_status` が
   * 「この場面では取れない」を返す（例: 蒸留のサイドクエリだけ自分のことが分からない）。
   */
  runtime?: () => CloneRuntimeFacts;
  /**
   * この道具を通した記憶の書き換えが、日誌の `memory_update.cause` でどう名乗るか。
   *
   * クローンの道具は人間の口ではないので、ここから `'human'` は出ない
   * （`'human'` を書くのは `app.ts` の `PUT` / `DELETE /memory/:slug` の2箇所だけである）。
   *
   * ## ⛔ 必須である。省略できない（既定値を持たない）
   *
   * **かつてこれは optional で、省略時は `'clone'` へ倒れていた。** その形は
   * `guardFullReplace` を fail-open にしていた —— 歯の本体1文目が
   * `cause !== 'distill'` で素通りするので（`guardFullReplace` の doc）、
   * **配線を忘れた新しい書き口は、`guardFullReplace` を呼んでいても素通りし、
   * 人間が一度でも書いた記憶の文書を黙って全文置換できた。** `tsc` も既存の
   * 歯も捕まえない（optional なので型が通る）。
   *
   * **⛔ 既定を `'distill'`（守る側）へ倒す形は採らなかった。** 守りは閉じるが、
   * **日誌の `cause` が嘘になる** —— `memory_update.cause` は
   * `guardFullReplace` 以外にも読み手が居る（`memory.ts` の
   * `deriveHumanTouchedAtFromJournal` / `deriveMemoryCreatedAtFromJournal`）。
   * **既定値は「取れなかった」を「別の値だった」に変える** ——「呼び手が名乗ら
   * なかった」を「蒸留の走行だった」として記録することになる。**日誌は追記
   * 専用で、人間が後から読んで否定するための場所である**（`north_star`）。
   * そこへ機械の推測を書き込ませない。
   *
   * **⟹ 必須にして、型の抜け道から届かなかったときは throw する**
   * （`createCloneTools` の中。倒れ先を作らない）。本番の構築点は2つだけで
   * （`clone.ts` の `#toolContext()` と `#distillFromTranscript` のインライン
   * context）どちらも明示しているので、**TS で検査された経路から throw へは
   * 到達しない。**
   *
   * **ターンごとに変わる値なので、道具の実行時（ハンドラの中）で呼ぶこと。**
   * `createCloneTools` の呼び出し時に1回だけ評価すると、本セッションの MCP
   * サーバはセッションごとに1回しか組まれないため、セッション中ずっと最初の
   * ターンの種類のまま固定されてしまう。
   */
  memoryCause: () => 'distill' | 'clone';
  /**
   * `Scheduler.list()` の写し（可観測性）。`schedule_list` が「次: <nextAt>」を
   * 出すための材料。
   *
   * `nextAt` を計算しているのは `Scheduler`（`schedule.ts`）で、`stores.schedules`
   * はストアの記録（周期・前回動いた時刻）しか持たない。ここが無いと道具の側は
   * 「次にいつ動くか」を持てない。
   *
   * **省略できるのはテストのためだけである。** 本番の配線（`clone.ts`）は
   * 本セッションと蒸留のサイドクエリの両方へ渡す（`runtime` / `memoryCause` と
   * 同じ「渡し忘れた側だけ静かに壊れる」形）。
   *
   * **呼ぶたびに評価すること。** `Scheduler.list()` は呼んだ瞬間の `nextAt` を
   * 返す（`Scheduler` の内部時計は動き続ける）ので、`createCloneTools` の
   * 呼び出し時に1回だけ評価すると、セッション中ずっと最初の値のまま固定される。
   */
  scheduler?: () => ScheduleStatus[];
}

export function qualifiedToolName(name: string): string {
  return `mcp__${MCP_SERVER_NAME}__${name}`;
}

export const CLONE_TOOL_NAMES = [
  'memory_list',
  'memory_read',
  'memory_write',
  'memory_append',
  'memory_delete',
  'memory_frontmatter_set',
  'memory_outline',
  'memory_section_move',
  'journal_write',
  'journal_read',
  'conversation_read',
  'ask_human',
  'approvals_list',
  'daily_report_write',
  'usage_read',
  'schedule_list',
  'schedule_create',
  'schedule_remove',
  'commitment_list',
  'commitment_open',
  'commitment_close',
  'commitment_edit',
  'profile_read',
  'profile_write',
  'token_list',
  'self_read',
  'self_status',
  'self_dropped',
  'manager_start',
  'manager_send',
  'manager_stop',
  'manager_list',
  'manager_report',
  'manager_transcript',
  'runner_list',
] as const;

/**
 * 一覧の既定の大きさ。
 *
 * **件数に比例して伸びる出力を作らない。** MCP の出力上限を超えた応答は
 * クローンに1文字も届かず（SDK はファイルへ落とすので、いまはクローンが `Read` で
 * 追える。**それでもここを緩めない** — 一覧を読むたびにファイルを開き直すのは
 * 人間が Web UI で一覧を見るのと等価ではない）、一覧が丸ごと使えなくなる。
 * 実測では 52,997 文字で溢れた。
 * 人間は Web UI で件数によらず一覧を見られるので、ここが壊れるのは
 * 能力の削除である（north_star 禁止1）。M5 で runner が増えれば件数も増える。
 */
const LIST_REQUEST_EXCERPT = 160;
const LIST_REPORT_EXCERPT = 240;
/**
 * `ManagerSummary.turnEndTail` を一覧の1行へ添えるときの厚み（Issue #567）。
 *
 * **`LIST_REPORT_EXCERPT` を使い回さない。** 値がいま同じ桁でも、片方だけを
 * 直したくなったときに一緒に動いてしまう（用途ごとに別に置く、という
 * このファイルの既存の分け方——`LIST_REQUEST_EXCERPT` / `LIST_WAITING_EXCERPT`
 * と同じ理由）。`turnEndTail` 自体の上限は `TURN_END_TAIL_EXCERPT`
 * （`manager.ts`、400字）で、ここはそれを一覧向けにさらに切る。
 */
const LIST_TURN_END_TAIL_EXCERPT = 160;
/**
 * 返事待ち1件の要約の厚み。
 *
 * **runner 側のキャップをここの根拠にしない。** `brief(input, 200)` が効くのは
 * 1つの経路だけで、`AskUserQuestion`（`describeQuestions`）は複数の質問文を
 * 連ねて返すのでそれを通らない。上流の数え上げに依存せず、出す側で締める。
 */
const LIST_WAITING_EXCERPT = 200;
const LIST_BUDGET = 8_000;
/**
 * 1本のマネージャーが同時に抱える返事待ちを、この件数まで出す（#409）。
 *
 * **1件ごとの厚みは `LIST_WAITING_EXCERPT` が締めるが、件数そのものには
 * 上限が無かった。** `manager.waiting` は `push` のみで増える配列で、外側の
 * `renderListing`（`items` 単位＝マネージャー1本ぶん）は全体の文字数予算しか
 * 見ていない——この配列だけが伸びて1本のマネージャーの1件が予算を占有すると、
 * 他のマネージャーが黙って押し出される。**切ったことは必ず言う。**
 */
const MANAGER_WAITING_LIST_LIMIT = 10;
/**
 * 一覧に添える拒否は、**新しい側から**この件数まで。
 *
 * 上限で切るのは 1 本の異常が一覧を食い潰さないためだが、**切ったことは必ず
 * 言う**（`denialLine`）。黙って落とすと「3種類しか止められていない」に見える。
 */
const LIST_DENIED_TOOLS = 3;
/**
 * 一覧に添える「応答が返っていない道具」は、この件数まで（Issue #572）。
 *
 * **理由は `MANAGER_WAITING_LIST_LIMIT` と同じである。** 1本の assistant 行が
 * 抱える `tool_use` の件数には上限が無く（並列で道具を回せる）、外側の
 * `renderListing` は全体の文字数予算しか見ない——ここが伸びると他の
 * マネージャーが黙って押し出される。**切ったことは必ず言う。**
 */
const LIST_TOOL_USE_STALL_LIMIT = 3;

/** `ManagerSummary.waiting` の1件（`@alteroid/core` の `RunnerWaiting` と同じ形）。 */
type ManagerWaitingItem = ManagerSummary['waiting'][number];

/**
 * 種別（質問／実行許可）を人間向けの語へ。**`kind` は省略されうる。**
 *
 * 新しいデーモンが `drainingSeconds` の猶予中の旧 runner へ問い合わせる窓が
 * あり、そちらの応答には `kind` が乗らない（`railway/README.md`「4. 落ちた
 * 側を待つ / 取り直す」）。`apps/cli/src/chat.ts` の `describeWaitingKind`
 * と同じ倒れ先——**分からないものを分かった顔で書かない。** ここを
 * `item.kind === 'question' ? '質問' : '実行許可'` のままにすると、`kind` が
 * 無いときに問答無用で「実行許可」と嘘をつく（クローンが質問に許可／拒否で
 * 答えてしまう）。
 */
function describeWaitingKind(kind: ManagerWaitingItem['kind']): string {
  if (kind === 'question') return '質問';
  if (kind === 'permission') return '実行許可';
  return '種別不明';
}

/**
 * `askedAt` を人間向けの語へ（無ければ何も足さない）。
 *
 * `chat.ts` の `describeAskedAt` と同じ理由・同じ倒れ先。**無いときは空文字や
 * `-` で埋めない** — 取れない軸に意味の決まった値を作らない（`AGENTS.md`
 * 「取れない軸に0の行を作る」）。
 */
function describeAskedAt(askedAt: ManagerWaitingItem['askedAt']): string {
  return askedAt === undefined ? '' : `${askedAt} から`;
}

/**
 * デーモン→クローンの脚（受信箱）の滞留を、一覧末尾に必ず1行出す（#358
 * 「答えない問い」に挙げた3行目のうち、この PR で拾えるほう。0件を言える
 * ようにした経緯は #562）。
 *
 * ## 0件でも行を出す —— これは「取れない軸に0の行を作る」には当たらない
 *
 * AGENTS.md の地雷「取れない軸に0の行を作る」は**取れない軸**の話である。
 * ここが読む `context.stores.inbox.pending()` は、呼ぶたびにストアを実際に
 * 問い合わせる生の値で（`InboxStore.pending` の doc）、キャッシュではなく
 * `observedAt` のような「いつ取れたか」の付帯情報も持たない —— **常にいまの
 * 値が取れる。** ⟹ ここでの0は、「取れなかったので0にした」のではなく
 * **本物の測定値**である。だから0を出しても地雷には当たらない。
 *
 * ## それでも、かつては0のとき行を消していた（#562 が直したバグ）
 *
 * 以前はここで `pending.count === 0` を `null` にして呼び出し側で filter して
 * いた。**結果、「滞留0」と「この道具はその行を出さない」が出力上で同じ顔に
 * なっていた**——クローンは、行が無いのを見て「詰まっていない」なのか
 * 「そもそも測っていない」なのか区別できなかった。0が本物の測定値である
 * 以上、消す理由が無い。
 *
 * ## `describeRunnerBacklog`（runner→デーモンの脚）とは非対称——意図的である
 *
 * 直下の `describeRunnerBacklog` は `ManagerPool.runnerBacklog()` という
 * **キャッシュ**を読み、その doc は「0件だったか、まだ観測していないかの
 * どちらかである」と逐語で書く。観測していない runner はそもそも配列に
 * 載らないので、**あちらの「行が無い」は0と未観測を区別できない。** あちらで
 * 0の行を作れば、「まだ観測していない」を「滞留0」と偽ることになる ——
 * だからあちらは直さない（このファイルでは触っていない）。**「常に実測できる
 * か、観測できていないことがありうるか」という違いが、この非対称性の理由
 * そのものである。**
 *
 * `⚠` は付けない —— 滞留0は警告ではない。
 */
function describeInboxBacklog(pending: { count: number; oldestAt?: string }): string {
  if (pending.count === 0) return 'クローンの受信箱に未処理の合図は無い。';
  const oldest =
    pending.oldestAt === undefined ? '' : `（最も古いものは ${pending.oldestAt} から）`;
  return `⚠ クローンの受信箱に未処理の合図が ${pending.count} 件ある${oldest}`;
}

/**
 * runner→デーモンの脚（`Outbox` の滞留）が、直近に観測できた分だけ出す、
 * 一覧末尾の行（#358 案b・案b の第2段。`describeInboxBacklog` はデーモン→
 * クローンの脚、こちらは runner→デーモンの脚——2本合わせて #358「答えない
 * 問い」に挙げた3行のうちの2つになる）。
 *
 * **`ManagerPool.runnerBacklog()` はキャッシュであって現在値ではない**
 * （`RunnerBacklogSnapshot` の doc）。だからここで出す行には、件数と最古の
 * 時刻に加えて**「いつ観測できた値か」を必ず添える**——添えないと、この行を
 * 読んだ側がキャッシュを現在値と取り違える（滞留はとうに解消しているのに
 * 古い行だけが居座って見える、あるいはその逆）。
 *
 * **「まだ報告していない」ではなく「報告した（runner の Outbox には積んだ）が
 * まだデーモンへ届いていない」ことを言う。** `pendingEvents` が数えているのは
 * runner が既に `Outbox` へ積んだ出来事の件数であって、マネージャーがまだ
 * 何も報告していない状態とは別である——字面を「未送出」にしているのは
 * そのため（「未報告」ではない）。
 *
 * **観測していない runner はここへ渡らない**（`runnerBacklog()` の doc—
 * 呼んでいなければ配列にそもそも載らない）ので、この関数の中では「0件だった」
 * ものだけを filter で落とす。`describeInboxBacklog` と同じ理由（何も言う
 * ことが無い行を一覧へ足さない）。
 *
 * **各行の末尾に、runner→デーモンの脚（デーモン自身の側の端。
 * `RunnerBacklogSnapshot.legState`）の状態を添える。** `pendingEvents` /
 * `oldestPendingAt` / `observedAt` が「runner 側にどれだけ溜まっているか」を
 * 言うのに対し、こちらは「それが**いつ届くか**」を言う——読んだクローンの
 * 次の一手（待つか、生ログを拾いに行くか）はここで決まる
 * （{@link describeRunnerLegState} に4状態の割り当てを持つ）。
 */
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

/**
 * `describeRunnerBacklog` の各行末尾——脚の状態から、読んだクローンの次の
 * 一手を言い分ける。**優先順位を固定する。**
 *
 * 1. **器が入れ替わった**（`instanceSwapped === true`）——脚がいま何であれ、
 *    観測した滞留を配れる相手はもう居ない。「もう来ない」。
 * 2. **繋がっている**（`legState.status === 'connected'`）——「まだ届いて
 *    いない。届く見込みがある」。待ってよい。
 * 3. **落ちている／一度も繋がっていない**（`'down'` / `'never-connected'`）
 *    ——「再接続するまで1件も届かない」。生ログから拾いに行く判断ができる。
 * 4. **観測していない**（`legState === undefined`）——「判定できない」。
 *    どちらとも言えないことが分かる形で言う（`false` へも `true` へも倒さない）。
 *
 * **`instanceSwapped` を先に見る。** 脚がいま `'connected'`（新しい器に
 * ちゃんと繋がっている）であっても、それは**新しい**器との接続であって、
 * 観測した滞留を持っていた古い器とは別物である——`legState` だけを見ると
 * 「繋がっているから待てばよい」という誤った案内になる。
 */
function describeRunnerLegState(snapshot: RunnerBacklogSnapshot): string {
  if (snapshot.instanceSwapped === true) {
    return (
      'もう来ない（この滞留を観測した後に器が入れ替わった。runner の Outbox は' +
      'プロセスのメモリだけなので、溜まっていた分は配られずに消えている——' +
      '生ログから拾うしかない）'
    );
  }
  const leg = snapshot.legState;
  if (leg === undefined) {
    return '判定できない（この runner は脚の状態を報告しない、またはいま名簿に居ない）';
  }
  // **網羅性は `assertNeverRunnerLegStatus` が守る**（`RunnerLegState` の
  // doc）。状態が増えたら `default` の型がここで `tsc` を落とす。
  switch (leg.status) {
    case 'connected': {
      // **取れたものを出す。閾値で「死んでいる」を判定しに行かない**——
      // 判定を足すと新しい「静かに間違える判定」を作る側になる（依頼者の
      // 指摘）。デーモン自身の無音の見張り（45,000ms で切る契約。
      // `RUNNER_STREAM_SILENCE_TIMEOUT_MS`）が既にあるので、それより古い
      // `lastByteAt` が異常であることは読み手の側で言える。
      const lastByteAt =
        leg.lastByteAt === undefined
          ? '開いてから1バイトも受け取っていない'
          : `最後にバイトを受け取ったのは ${leg.lastByteAt}`;
      return (
        'まだ届いていない。届く見込みがある' +
        `（脚は繋がっている。待ってよい。${leg.since} から、${lastByteAt}）`
      );
    }
    case 'down': {
      const detail = [
        leg.since === undefined ? undefined : `${leg.since} から`,
        leg.lastFailureReason === undefined ? undefined : `直近の理由: ${leg.lastFailureReason}`,
        leg.nextRetryAt === undefined ? undefined : `次の再試行: ${leg.nextRetryAt}`,
      ].filter((part): part is string => part !== undefined);
      const detailSuffix = detail.length === 0 ? '' : `（${detail.join('、')}）`;
      return `⚠ 再接続するまで1件も届かない${detailSuffix}`;
    }
    case 'never-connected':
      return '⚠ 再接続するまで1件も届かない（このデーモンが起きてから一度も繋がっていない）';
    default:
      return assertNeverRunnerLegStatus(leg);
  }
}

/**
 * `manager_transcript` が「生ログが無い」と答える直前に添える、脚の状態の
 * 言い分け（#634。PR #628 が指した範囲外の穴——3段どこにも無いとき、
 * 「まだ引き渡していない」と「引き渡せずに消えた」が同じ文面になっていた）。
 *
 * **新しい往復を1本も足さない。** `ManagerPool.runnerIdOf()` はプロセス内の
 * 像（`#records`）を読むだけ、`runnerBacklog()` は直近の heartbeat / 明示
 * 呼びが拾って保存しておいたキャッシュを読むだけである
 * （`grep -Fn -- 'ネットワークを一切叩かない' packages/core/src/manager.ts`
 * が当たる doc のとおり）。
 *
 * **`describeRunnerLegState` をそのまま再利用する。** あの関数が持つ優先順位
 * （1. 器が入れ替わった 2. 繋がっている 3. 落ちている／一度も繋がっていない
 * 4. 観測していない）は、ここで求められている「引き渡せずに消えた」
 * （1に相当）と「まだ引き渡していない」（2・3に相当）の言い分けそのもの
 * ——同じ判定を2箇所へ別々に書くと、いつか字面が割れる（`manager_list` と
 * `runner_list` の状態表示を揃えている理由と同じ）。
 *
 * **「可能性が高い」と「そうである」を混ぜない。** runner は出来事の種別を
 * 名乗って届けているわけではない（`Outbox` は種別を見ずにまとめて溜める）
 * ので、失われた分に `archive` が含まれていたかはデーモン側からは分から
 * ない——ここで言えるのは「未送出が N 件あった（内訳は不明）」までである。
 *
 * **3状態を維持する。** `runnerId` が取れない・`runnerBacklog()` に該当が
 * 無い・観測できた滞留が0件のいずれも「判定できない」へ倒す（0や偽の時刻を
 * 作らない。AGENTS.md「取れない軸に0の行を作る」）。
 */
function describeTranscriptMissingLeg(pool: ManagerPool, managerId: string): string {
  const runnerId = pool.runnerIdOf(managerId);
  if (runnerId === undefined) {
    return (
      '判定できない（この委譲がいま runner に割り当てられている像を持たない —— ' +
      '一度も割り当てられなかったのか、走行中の像（#records）から外れて' +
      'いるだけなのかは、この応答だけでは区別できない）。'
    );
  }

  const snapshot = pool.runnerBacklog().find((entry) => entry.runnerId === runnerId);
  if (snapshot === undefined || snapshot.pendingEvents === 0) {
    return (
      `判定できない（runner ${runnerId} について、生ログが無い理由と結び付けられる` +
      '未送出の滞留を観測できていない。滞留が実際に0件だったのか、まだ一度も' +
      '観測していないだけなのかは、この応答だけでは区別できない）。'
    );
  }

  // **`instanceSwapped === true` が最優先**（`describeRunnerLegState` と
  // 同じ順位）。滞留を観測した後で器が入れ替わっていれば、脚がいま何であれ
  // その滞留はもう配られない——「引き渡せずに消えた可能性が高い」側である。
  const prefix =
    snapshot.instanceSwapped === true
      ? '引き渡せずに消えた可能性が高い。'
      : 'まだ引き渡していない可能性がある（この生ログもその中に含まれるかは' + '分からない）。';

  return (
    `${prefix} runner ${runnerId} について ${snapshot.observedAt} 時点で観測できた` +
    `未送出の出来事: ${snapshot.pendingEvents} 件（内訳は runner から届いていないので` +
    `不明——archive が含まれていたかもここからは言えない）。${describeRunnerLegState(snapshot)}`
  );
}

/** 全文を取りに来たときの1回分。続きは `offset` で取れる。 */
const REPORT_PAGE = 8_000;

/**
 * `manager_transcript`（生ログ）の1回分。
 *
 * **`REPORT_PAGE` と同じ値だが、同じ定数を使い回さない。** 意味が違う
 * （こちらはセッションの生ログ、あちらは報告の全文）ので、片方だけを
 * 直したくなったときに一緒に動いてしまわないよう定数を分けてある。
 * 値をそろえた理由は同じ根拠 — MCP の出力上限より十分小さい安全域である
 * （実測でこの上限に溢れた記録は上の `LIST_BUDGET` の doc と同じ形。
 * 生ログは報告よりさらに大きくなりうる＝MB 級もあるので、ここを緩める
 * 方向には倒さないこと）。
 */
const TRANSCRIPT_PAGE = 8_000;

/**
 * `manager_report` が「報告はまだ無い」と答える直前に、生ログの末尾を遡って
 * 「生成されたが配られていない」（#323）を探す幅。
 *
 * **末尾からこの文字数だけを見る。生ログ全体を JSON.parse しない。** 生ログは
 * MB 級になりうる（実測で 319,141 文字の例がある。`TRANSCRIPT_PAGE` の doc）。
 * ここまで遡って見つからなかったら「生ログにも本文が無い」ではなく
 * 「上限まで遡ったが見つからなかった」と言う（それより前は見ていない。
 * AGENTS.md 地雷「取れない軸に0の行を作る」）。
 *
 * `REPORT_PAGE` / `TRANSCRIPT_PAGE` より大きいのは、こちらは**返す**幅ではなく
 * **走査する**幅だから — 直近の報告に相当する1件のイベントを見つけるには、
 * 呼び出し側へ返す1ページぶんより広い範囲を読む必要がある（ツール呼び出し・
 * 結果などが間に挟まるため）。
 */
const REPORT_GENERATED_PROBE_CHARS = 200_000;

/** `probeLastAssistantUtterance` が生ログの末尾から見つけた、マネージャー自身の最後の発言。 */
interface LastAssistantUtterance {
  /** 生ログの行が持つ `timestamp`（無ければ `undefined`——古い形式は省略しうる）。 */
  timestamp: string | undefined;
  /** 本文の文字数（概算——このツールは全文を返さない）。 */
  length: number;
  /**
   * その行が持つ `message.stop_reason`（`string` のときだけ採る。**作らない**
   * ——欄が無い・文字列でないときは `undefined`）。
   *
   * **本文（`type: 'text'`）を持つ行だからといって、そのターンが終わっている
   * とは限らない。** 実測（この器で実際に生成された transcript の末尾）:
   * ```
   * {"stop_reason":"tool_use","types":["text"],"isSidechain":false}
   * {"stop_reason":"tool_use","types":["tool_use"],"isSidechain":false}
   * {"stop_reason":"tool_use","types":["thinking"],"isSidechain":false}
   * ```
   * ＝ 道具を挟む前の語り（ターンの途中の発言）も `type: 'text'` の assistant
   * 行として現れ、その行の `stop_reason` は `end_turn` ではなく `tool_use` に
   * なる。ここを見ずに「本文があった＝生成し終えた」と読むと、道具を挟みながら
   * 普通に働いている最中のマネージャーを「配られていない」と誤検出する
   * （偽陽性）。`describeMissingReport` はこの値で `end_turn` / それ以外 /
   * 読めない、の3つを言い分ける。
   */
  stopReason: string | undefined;
}

type AssistantUtteranceProbe =
  | { kind: 'found'; utterance: LastAssistantUtterance }
  /** 走査した範囲（＝生ログ全体）のどこにも本文が無かった。 */
  | { kind: 'empty' }
  /** `REPORT_GENERATED_PROBE_CHARS` まで遡ったが見つからなかった。それより前は見ていない。 */
  | { kind: 'truncated' };

/**
 * 生ログ（Claude Code の JSONL、1行1イベント）の末尾から、マネージャー自身の
 * 発言（`type: 'assistant'` かつ `content` に `type: 'text'` の本文を持つもの）で
 * 最後の1件を探す。
 *
 * **作業者（Task サブエージェント）の発言を混ぜない。** 実測（このリポジトリの
 * 開発環境、`@anthropic-ai/claude-agent-sdk@0.3.247` 同梱 CLI が書いた実際の
 * transcript ファイルを直接読んだ）では、Task が起こしたサブエージェントの
 * 発言はマネージャー自身の transcript ファイルには一切現れず、
 * `<session>/subagents/agent-*.jsonl` という別ファイルへ書かれる
 * （`ManagerPool#transcript` が読むのはマネージャー自身のセッションファイル
 * だけで、このサブエージェント用ファイルは読まない）。それでも防御的に、
 * 行の `isSidechain` が `true` の行は除く。**この判定は `runner.ts` の
 * `parentToolUseId()` と同じ意図だが、同じフィールドは見ていない** —
 * あちらは SDK が流す `SDKMessage`（`parent_tool_use_id` を持つ）を見ており、
 * こちらはディスク上の JSONL の生の行を見ている。実測した transcript
 * ファイルには `parent_tool_use_id` という文字列が1度も現れず
 * （`message.content` の中の引用文字列を除く）、行が持つのは代わりに
 * `isSidechain` である。**それでも混ざる余地が完全に無いとまでは言い切れない
 * ので、`manager_report` の応答はこの判定を経たことを明示する。**
 *
 * **末尾から `REPORT_GENERATED_PROBE_CHARS` 文字だけを見る。全行を
 * JSON.parse しない**（定数の doc）。末尾から切り出した先頭の断片は行の
 * 途中で千切れている可能性があるので、遡り切っていない（`truncated`）ときは
 * 捨てる——壊れた JSON を無理に読まない。
 *
 * **本文があること（`kind: 'found'`）は「そのターンが終わった」を意味しない。**
 * `stopReason`（`LastAssistantUtterance` の doc）に実測を書いた——見つけた
 * ことと、そのターンが終わっていることは別の軸なので、ここでは両方を一緒に
 * 返すだけで**判定はしない**。「配られていない」と言ってよいかの判断は
 * 呼び出し側（`describeMissingReport`）が `stopReason` を見て行う。
 */
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
    if (record.isSidechain === true) continue; // 作業者の発言（上の doc）
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

/** 生ログの1行（parse 済み）から、assistant の本文（`content` の `type: 'text'`）だけを取り出す。 */
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

/**
 * `manager_report` の `part: 'report'` で本文が空だったときに呼ぶ（#323）。
 *
 * **「まだ書いていない」と「書いたのに届いていない」を区別する。** 生ログ
 * （`ManagerPool#transcript`。`/events` とは別の接続なので、`/events` が
 * 詰まっていても読める）を見て、マネージャー自身の最後の発言を探す——
 * 見つかれば「生成されたが配られていない」と言え、見つからなければ
 * 「まだ書いていない」寄りだが、走査した範囲でしか言えないことも併せて言う。
 *
 * **読めなかったこと自体も、「無い」に潰さない**（AGENTS.md 地雷「取れない軸に
 * 0の行を作る」）。
 */
async function describeMissingReport(
  managers: ManagerPool,
  managerId: string,
  status: ManagerSummary['status'],
): Promise<string> {
  const base = `マネージャー ${managerId} からの報告はまだ無い（状態: ${status}）。`;
  let transcript: string | null;
  try {
    transcript = await managers.transcript(managerId);
  } catch (error) {
    return (
      `${base} 生ログは読めなかった（` +
      (error instanceof Error ? error.message : String(error)) +
      '）。「まだ書いていない」か「書いたのに届いていない」かは、これだけでは判定できない。'
    );
  }
  if (transcript === null || transcript.length === 0) {
    return (
      `${base} 生ログにも本文は無い` +
      '（走行中の runner のディスク・退避済みアーカイブ・預かった生ログ、3段のどこにも見当たらなかった）。'
    );
  }

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
  const resumeOffset = Math.max(0, transcript.length - TRANSCRIPT_PAGE);
  // **どの枝でも `状態` を落とさない。** 早い3枝（読めなかった／生ログにも
  // 無い／上限まで遡った）は `base` がこれを持っているのに、下の3枝だけが
  // 落ちていた——同じ道具の同じ問いへの答えなのに、枝によって取れる軸が
  // 減る（AGENTS.md 地雷「取れない軸に0の行を作る」の隣の形。ここは軸が
  // 取れているのに出していない）。
  const state = `（状態: ${status}）`;
  const found = `生ログには ${when} に本文が在る（約 ${length.toLocaleString('ja-JP')} 文字）`;
  const howToDigIn =
    `manager_transcript managerId=${managerId} offset=${resumeOffset} で読める` +
    '（作業者の発言は除いて探したが、混ざる余地が完全に無いとまでは確認していない）。';

  // **本文が在ることと、そのターンが終わっていることは別の軸**（`stopReason`
  // の doc の実測——`type: 'text'` の行でも `stop_reason` が `tool_use` の
  // ことがある＝道具を挟む前の語り）。ここで3つに割る。「終わっていないと
  // 分かった」と「分からなかった」を1つに畳まない
  // （AGENTS.md 地雷「取れない軸に0の行を作る」）。
  if (stopReason === 'end_turn') {
    // これが #323 の形——ターンを終えた（`end_turn`）のに配られていない。
    return (
      `⚠ マネージャー ${managerId} からの報告としては届いていない${state}が、${found}。` +
      `＝ 生成されたが配られていない（#323）。${howToDigIn}`
    );
  }
  if (stopReason !== undefined) {
    // 読めた。かつ `end_turn` ではない——まだターンの途中（道具を挟んでいる
    // 最中など）。「配られていない」とは断定しない（健全な途中経過かもしれない）。
    return (
      `マネージャー ${managerId} からの報告はまだ無い${state}。${found}が、そのターンはまだ終わっていない` +
      `（stop_reason=${stopReason}）。＝ まだ書き終えていない側である。${howToDigIn}`
    );
  }
  // stop_reason が読めなかった——終わっているかどうか、どちらとも名乗らない。
  return (
    `マネージャー ${managerId} からの報告はまだ無い${state}。${found}が、そのターンが終わっているかを判定できなかった` +
    `（行に stop_reason が無い）。${howToDigIn}`
  );
}

/**
 * 未了の台帳の一覧の予算と、1件ぶんの本文の厚み。
 *
 * **件数の上限（かつての `COMMITMENT_LIST_LIMIT = 30`）は潜在的なバグだった。**
 * 他の一覧（`approvals_list` / `schedule_list` / `runner_list` など）はどれも
 * 文字数の予算（`renderListing`）で切っているのに、ここだけ件数で切っていた。
 * `.claude/skills/listing-and-detail/SKILL.md` が警告している「件数の上限
 * だけでは足りない。何件で壊れるかが運任せになる」がそのまま起きる形で、
 * 実際に#215で1件に欄を2つ足したところ、30件×新しい欄の厚みで出力が
 * `OUTPUT_CAP`（12,000）を実測12,065文字で超えた（総当たりの歯「一覧は
 * 例外なく件数で壊れない」が捕まえた）。**このPRは欄を1つも足さない** —
 * 土台だけを他の一覧と同じ文字数の予算へ先に寄せておく。次に誰かが1件に
 * 欄を足しても、もうここでは壊れない。
 *
 * **`COMMITMENT_LIST_LIMIT` は消した。** 文字数の予算がある以上、件数の
 * 上限を並べて持つ理由が無い（`approvals_list` 等も件数の上限は持たない）。
 *
 * **切ったことは必ず言う**（`LIST_DENIED_TOOLS` と同じ理由）。「これで全部だ」と
 * 読まれた台帳は、載っているのに見えない仕事を作る＝この器が塞ごうとしている穴が
 * そのまま戻る。
 */
const COMMITMENT_LIST_BUDGET = 8_000;
const COMMITMENT_BODY_LIMIT = 240;
/**
 * 読めない行の id を出すときの件数の上限（#409）。
 *
 * `digest.ts` の `buildActivityDigest` に在った同じ形の穴（台帳の破損の度合いに
 * 比例して伸びる id の列挙で、上限も合図も無かった）を塞いだのと同じ理由で
 * ここにも要る——あちらは直したが、この一覧モードの断り行は直っていなかった
 * （同じ `unreadable` を別の場所でもう一度 `join` している）。
 */
const UNREADABLE_COMMITMENT_IDS_SHOWN = 20;
/**
 * `profile_write` が返す配布先の一覧（`配った先` / `配れなかった先`）を
 * 抜粋する厚み（#409）。
 *
 * どちらも器の台数ぶん伸びる。`配れなかった先` は runnerId に加えて
 * エラー本文も抱えるので、なおさら長さの見込みが立たない。`.join(', ')` に
 * 上限も合図も無かった——この一覧の穴として最初に見つかった箇所であり、
 * 成功側の `配った先` も同じ形をしていた。
 */
const PROFILE_DISTRIBUTION_EXCERPT = 400;
/**
 * 台帳1件の全文を取りに来たときの1回分。続きは `offset` で取れる。
 *
 * **`body` は要約を禁じられた欄である**（`schema.ts` の逐語: 「要約にしないこと。
 * 一覧で切るのは表示側の仕事で、器が要約を持つと『頼まれた内容そのもの』が二度と
 * 取れなくなる」）。つまりここは構造的に長くなりうるので、切って捨てず
 * `page()` で分けて渡す。
 */
const COMMITMENT_PAGE = 8_000;

/**
 * 一覧の先頭行に置く、出所の札。
 *
 * この型に title は無いので、**出所と種別**を読める形にしたものを「名前」の
 * 代わりにする。一覧を目で走らせるとき最初に知りたいのがそれだからである
 * （人間が頼んだ件なのか、自分で気づいた宿題なのか）。
 *
 * **本文（`body`）の先頭 n 文字を札にしないこと** — それは
 * `COMMITMENT_BODY_LIMIT` の抜粋が既に出しているもので、欄が1つ増えただけで
 * 情報は増えない。
 *
 * **`origin` の生の値（`human` / `self` …）はこの札に畳んである。**
 * 札と `origin` は1対1で、この表がその対応そのものである。かつては
 * `受け取った時刻: <at>（<origin> / <source>）` の行が同じものを併記して
 * いたが、札・作成・更新の3つを足すと同じ出所が1件に3回出るので、その行は
 * `作成: … / 更新: …`（`manager_list` / `schedule_list` と同じ形）へ
 * 置き換えた。**絞り込みの引数は `origin` を取らない**ので、生の値が消えても
 * 到達できなくなるものは無い。
 */
const COMMITMENT_ORIGIN_LABEL: Record<CommitmentOrigin, string> = {
  human: '人間の依頼',
  manager: 'マネージャーの報告',
  external: '外部イベント',
  self: '自分で気づいた宿題',
};

function commitmentOriginBadge(entry: { origin: CommitmentOrigin; source?: string }): string {
  const label = COMMITMENT_ORIGIN_LABEL[entry.origin];
  return entry.source === undefined ? `[${label}]` : `[${label} / ${entry.source}]`;
}

/**
 * 日誌の一覧の予算と、1件ぶんの本文の厚み。
 *
 * **`manager_list` とは用途が違う。** あちらは全体の要約だが、日誌は
 * 「特定の時刻の1行を探す」ために引く。探す側にとって要るのは
 * *いつ・誰が・どの型か*であって本文の厚みではないので、**本文を薄くして
 * 件数を残す**側へ倒す。全文が要ると分かった1件は `id` で取りに行く。
 */
const JOURNAL_TEXT_EXCERPT = 120;
const JOURNAL_BUDGET = 8_000;
/** 日誌1件の全文を取りに来たときの1回分。続きは `offset` で取れる。 */
const JOURNAL_PAGE = 8_000;

/**
 * 承認待ちの一覧の予算と、1件ぶんの質問の厚み。
 *
 * **溜まる速さを決めるのは人間である。** 席を外しているあいだ `ask_human` は
 * 積み続けるので、ここは「件数が増えても壊れない」ことだけが要件になる。
 * 質問の全文は `approvals_list id=<id>` で取れる。
 */
const APPROVAL_LIST_BUDGET = 8_000;
/**
 * 認証トークンのプールの一覧の予算。
 *
 * **`APPROVAL_LIST_BUDGET` を使い回さない**（値が同じでも由来が違う。AGENTS.md
 * 「値が同じでも使い回さない」）。あちらは人間が席を外した長さで増えるが、こちらは
 * **人間が登録した本数**で決まる。**「ふつう数本だから溢れない」を根拠にしない** ——
 * 溢れた応答は1文字も届かないので、件数の見積りを根拠にすると、外れたときに
 * 一覧が丸ごと使えなくなる（禁止1）。
 */
const TOKEN_LIST_BUDGET = 6_000;
/**
 * 止まった理由（原文）の抜粋の厚み。
 *
 * **原文をそのまま出すことと、件数で溢れないことは両立させる。** provider の
 * 英文は長くなりうる（`USAGE_LIMIT_ERROR_PREFIXES` は文の**接頭辞**でしかない）。
 * **全文が要るときは日誌の側に在る**（`journal_read types=token_rotation` の
 * `noticeText`）ので、ここは目で走らせるための厚みでよい。
 */
const TOKEN_REASON_EXCERPT = 200;
const APPROVAL_QUESTION_EXCERPT = 200;
/** 承認待ち1件の全文を取りに来たときの1回分。続きは `offset` で取れる。 */
const APPROVAL_PAGE = 8_000;

/**
 * 一覧の先頭行に置く「名前」＝質問の1行目の長さ。
 *
 * **承認待ちには質問文以外に札の材料が無い。** だから札は概要（下の
 * `APPROVAL_QUESTION_EXCERPT` の抜粋）と重なりうる——質問が1行なら
 * ほぼ同じものが2度出る。**それを承知で採っている**: `id` だけの先頭行より、
 * 一覧を目で走らせるときに効くほうを採った。
 *
 * **改行までで切る。** `excerptLine` は改行を空白へ潰して1行にするので、
 * そのまま通すと2行目以降の文字が札へ混ざる（「本番へ出してよいか」の隣に
 * 「影響範囲: 全ユーザー」が並ぶ）。札だけは改行の手前で切ってから詰める。
 */
const APPROVAL_TITLE_EXCERPT = 60;

function approvalTitle(question: string): string {
  const firstLine = (question.split('\n', 1)[0] ?? '').trim();
  // 1行目が空（質問が改行で始まる）なら札が消えるので、そのときだけ
  // 全体を潰した抜粋へ落とす。**空の札を出さない**——空欄は「名前が無い」のか
  // 「取り忘れ」なのか区別できない（AGENTS.md「取れない軸に0の行を作らない」）。
  return excerpt(
    firstLine === '' ? question.replace(/\s+/g, ' ').trim() : firstLine,
    APPROVAL_TITLE_EXCERPT,
  );
}

/**
 * 継続中の依頼の一覧の予算と、1件ぶんの依頼本文の厚み。
 *
 * **ここは構造的に育つ。** `schedule_create` は「時刻が来たときのあなたが読んで
 * そのまま動ける粒度で書く」よう求めており、つまり**長文を書かせる設計**である。
 * その長文を一覧が全文で出していたので、仕込みが増えるほど一覧が壊れる形だった。
 * 全文は `schedule_list kind=<kind>` で取れる。
 */
const SCHEDULE_LIST_BUDGET = 8_000;
const SCHEDULE_REQUEST_EXCERPT = 200;
/** 継続中の依頼1件の本文を取りに来たときの1回分。続きは `offset` で取れる。 */
const SCHEDULE_PAGE = 8_000;

/**
 * `kind` 1件ぶんの「次に動く時刻」を、`ToolContext.scheduler`（`Scheduler.list()`
 * の写し）から引く。**`stores.schedules` はこの値を持たない** — `nextAt` を
 * 計算しているのは `Scheduler` 自身で、ストアは周期と前回動いた時刻の記録
 * しか持たない（Issue #237）。
 *
 * **取れないときも黙って行を消さない**（AGENTS.md「取れない軸に0の行を作る」）。
 * 2つの取れなさを分けて言う — `scheduler` そのものが渡っていない（テスト・
 * 蒸留サイドクエリへの渡し忘れ）か、`Scheduler` がまだこの kind を仕込みへ
 * 反映していない（`schedule_create` 直後は次の刻みまで反映が遅れる。
 * `TimerScheduler#reconcile` の doc）かで、後者は一時的だが前者は配線の欠落
 * である。読み手が原因を区別できるよう文言を分ける。
 */
function scheduleNextAtOf(context: ToolContext, kind: string): string {
  if (context.scheduler === undefined) return '（取れない — scheduler が渡っていない）';
  const status = context.scheduler().find((entry) => entry.kind === kind);
  return status === undefined ? '（まだ計算されていない。少し待って呼び直すこと）' : status.nextAt;
}

/**
 * 器の一覧の予算と、器1台ぶんに並べるマネージャーの件数。
 *
 * **`LIST_BUDGET` を使い回さない。** あちらはマネージャーの一覧で、こちらは器の
 * 一覧である（値は同じだが、片方だけを直したくなったときに一緒に動かないよう
 * `REPORT_PAGE` / `TRANSCRIPT_PAGE` と同じ理由で分けてある）。
 *
 * マネージャーの内訳をここで切っても能力は落ちない——`manager_list` が
 * 同じものを予算つきで持っている。**切ったことは必ず言う。**
 */
const RUNNER_LIST_BUDGET = 8_000;
const RUNNER_MANAGER_LIST_LIMIT = 20;
/**
 * 鍵の指紋行を抜粋する厚み（#409）。
 *
 * `runner.credentials` は器へ配った鍵の本数ぶん伸びる（`.map().join()` に
 * 上限も合図も無かった）。#4（MCP 連携本数）と同じ形——設定駆動で現実には
 * 小さいと見立てているが、それは実測ではないので上限を置く。
 */
const RUNNER_CREDENTIAL_FINGERPRINT_EXCERPT = 400;

/**
 * ゾンビの年齢（秒）を「H時間M分前」のような字面にする（#315 の可視化、
 * `runner_list resources: true` のいちばん古いゾンビ専用）。
 *
 * `clone.ts` の `formatElapsed` と役目は似るが、こちらは「約19時間」ではなく
 * 「19時間24分前」まで出す——ゾンビが1本も片付かないまま何時間経っているかを
 * 見るための数字で、分の位まで丸めると「気づいてから1時間経ったのか23時間
 * 経ったのか」が見えなくなる。だから共通化せず、この道具専用に書く。
 */
function describeZombieAge(seconds: number): string {
  if (seconds < 60) return `${seconds}秒前`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}分前`;
  const hours = Math.floor(minutes / 60);
  const remainderMinutes = minutes % 60;
  if (hours < 24) return `${hours}時間${remainderMinutes}分前`;
  const days = Math.floor(hours / 24);
  const remainderHours = hours % 24;
  return `${days}日${remainderHours}時間前`;
}

/** 記憶1件の本文を取りに来たときの1回分。続きは `offset` で取れる。 */
const MEMORY_PAGE = 8_000;
/**
 * 正典1本を取りに来たときの1回分。続きは `offset` で取れる。
 *
 * **`docs/architecture.md` は 48,856 バイトある**（着手時点の実測）。ページングが
 * 無いあいだ、この道具は1回で48KBを文脈へ流し込んでいた。
 */
const CANON_PAGE = 8_000;
/** プロファイル本文を取りに来たときの1回分。続きは `offset` で取れる。 */
const PROFILE_PAGE = 8_000;

/**
 * `self_dropped` の一覧予算（文字数）。
 *
 * **他の一覧と値は揃えるが、定数は共有しない**（`excerpt.ts` の作法どおり
 * 用途ごとに別に置く。片方だけ直したくなったときに一緒に動かないため）。
 * `recentDroppedTraces()` の帳面自体に上限（`RECENT_TRACE_LIMIT`、
 * `dropped-record.ts`）があるので、ここは「一度に読み戻すときの続きの
 * 取り方」を守る側の予算である。
 */
const SELF_DROPPED_BUDGET = 8_000;
/** `self_dropped` が `limit` を省略したときに返す件数（直近から）。 */
const SELF_DROPPED_DEFAULT_LIMIT = 50;

/**
 * `conversation_read` 専用の抜粋長・予算・ページ幅。
 *
 * **`JOURNAL_*` を使い回さない。** 値は同じでも意味が違う — こちらは「会話の
 * 1発言」を単位にした抜粋・予算であって、`journal_read` の「日誌の1行」とは
 * 探す対象そのものが違う（`TRANSCRIPT_PAGE` の doc と同じ判断）。片方だけ
 * 直したくなったときに一緒に動かないよう定数を分けてある。
 */
const CONVERSATION_EXCHANGE_EXCERPT = 200;
const CONVERSATION_LIST_BUDGET = 8_000;
/** 発言1件の全文を取りに来たときの1回分。続きは `offset` で取れる。 */
const CONVERSATION_PAGE = 8_000;

/**
 * 自作ツールは確認なしで通す（能力の削除ではなく、道具が道具として使えること）。
 *
 * **これは「使える道具の一覧」ではない。** `allowedTools` は確認を省く側の一覧で
 * あって、ここに無い道具が使えなくなるわけではない（SDK: "To restrict which tools
 * are available, use the `tools` option instead."）。ここへ組み込みツールを
 * 書き足す／ここから消すことで、クローンの能力を調整しようとしないこと。
 */
export const CLONE_ALLOWED_TOOLS = CLONE_TOOL_NAMES.map(qualifiedToolName);

function text(body: string) {
  return { content: [{ type: 'text' as const, text: body }] };
}

/**
 * `ManagerDenial.actor` を一覧の1件に添える短い印にする。
 *
 * **3値が字面の上でも3値のまま出ること。** `undefined`（層が取れていない。
 * `via: 'result'` はSDK側に判定材料が無いので常にここに落ちる）を、
 * 黙って消したりマネージャー側へ混ぜたりしないこと（Issue #373、
 * 2026-08-24 コメント #5393921053 が指摘した実害と同じ形を再現しないため）。
 * `apps/cli/src/chat.ts` の同名の書式と揃えてある——片方だけ直すと、
 * クローンが見る道具と人間が見る CLI で数字の意味がずれる。
 */
function denialActorTag(actor: ManagerDenial['actor']): string {
  return actor === 'manager' ? ' [マネージャー]' : actor === 'worker' ? ' [作業者]' : ' [層不明]';
}

/**
 * 一覧に添える「確認へ上がらず止められた」件数の行。
 *
 * **`status` は「動いている」を意味しない。** 分類器か deny 規則がその場で拒否
 * すると、その仕事は `running` のまま手が止まる。それが日誌と（繰り返したときだけ）
 * 受信箱にしか出ていなかったので、一覧を見ているクローンには止まっていることが
 * 見えなかった。
 *
 * **ここでも観測した分しか言わない。** 数えているのは拒否そのものであって、
 * その結果マネージャーが止まったかどうかは見ていない（動きを見る手がデーモンに
 * 無い）。数は器を作り直せば消えるので、そのことも書く — 「0 件」を
 * 「止められていない」と読まれると、作り直し直後がいちばん静かに見える。
 *
 * **各件に `denialActorTag` で層を添える。** どちらの手が止まったかを畳んで
 * 出すと、クローンが誤った相手（例: マネージャー自身）へ指示を出しうる
 * （Issue #373）。
 */
function denialLine(denials: ManagerDenial[]): string | null {
  if (denials.length === 0) return null;
  // 帳面は古い順に積まれている。**新しい側から**採る。
  const recent = [...denials].reverse();
  const shown = recent.slice(0, LIST_DENIED_TOOLS);
  const rest = recent.length - shown.length;
  const total = denials.reduce((sum, entry) => sum + entry.count, 0);
  return (
    `  ⚠ 確認へ上がらず止められた道具: ${shown.map((e) => `${e.tool} ${e.count}件${denialActorTag(e.actor)}`).join(' / ')}` +
    (rest > 0 ? `（ほか ${rest} 種、全 ${total} 件）` : '') +
    '。この確認はクローンには回ってきていないので、手が止まっている可能性がある' +
    '（全件は journal_read に残っている。件数はデーモンを作り直すと数え直しになる）。'
  );
}

/**
 * `ManagerSummary` から {@link classifyManagerActivity} への入力を作る。
 *
 * **判定のコピーを2つ作らないための唯一の変換点。** `describeTurnEnd` /
 * `describeToolUseStall` の両方がこれを通して同じ判定を呼ぶ——
 * `manager.ts` の `flushWithheldReports()` も同じ純関数を、`ManagerRecord`
 * から作った同型の入力で呼ぶ（`manager-activity.ts` の doc）。
 */
function managerActivityInputOf(manager: ManagerSummary): ManagerActivityInput {
  return {
    turnEndReason: manager.turnEndReason,
    turnEndedAt: manager.turnEndedAt,
    lastReportAt: manager.lastReportAt,
    toolUseStallPending: manager.toolUseStallPending,
    waitingCount: manager.waiting.length,
  };
}

/**
 * 一覧に添える、「ターンが終わっているらしいのに報告が届いていない」への
 * 助言（Issue #567）。**判定はここで行う** — `ManagerSummary.turnEndedAt` の
 * doc が「読む側が `lastReportAt` と突き合わせて判定する」と書いている、
 * その読む側がこの関数である。
 *
 * **切らない・殺さない・止めない。** ここが何を返しても `status` は動かず、
 * どの委譲も abort しない、貸し出し期限も縮まない——伝えるだけである
 * （`ManagerSummary.turnEndedAt` の doc と同じ約束）。
 *
 * 分岐:
 * - `turnEndReason` が無い ⟹ `null`（この観測自体が無い）
 * - `turnEndedAt` が無い ⟹ **⚠**。行に `timestamp` が無かっただけで、
 *   「症状ではない」へは倒さない。**既定は「分からない」**である
 *   （`ManagerSummary.turnEndedAt` の doc に逐語で在る）
 * - `turnEndedAt` が在り、`lastReportAt` も在って `turnEndedAt <= lastReportAt`
 *   ⟹ `null`（ターンが終わった後に報告が届いている＝正常な待機）
 * - それ以外（`turnEndedAt > lastReportAt`、または `lastReportAt` が無い）
 *   ⟹ **⚠**
 *
 * **⚠️ 時刻の比較は文字列ではなく `Date.parse` の数値で行う。** `lastReportAt`
 * は `new Date().toISOString()` なので必ず同じ形（ミリ秒 + `Z`）だが、
 * `turnEndedAt` は生ログの行が持っていた `timestamp` をそのまま写した値で
 * （`probeTurnEnd`）、**デーモンが作った値ではない。** SDK が書く形に依存する
 * ので、オフセット表記（`+09:00`）やミリ秒なしが来ると文字列比較は静かに
 * 間違える。**どちらかが `Date.parse` できない（`NaN`）ときも `null`
 * （症状ではない）へ倒さず、⚠ 側へ落とす** — (A) の分岐（`turnEndedAt` 自体が
 * 無いとき）と同じ原則で、比較できない＝「分からない」であって「症状では
 * ない」ではない。**誤検出の代償は非対称である** — 誤って ⚠ を出す代償は
 * 「読む人が1回よけいに読む」、誤って黙る代償は「止まった委譲が見つからない」。
 *
 * **健全なマネージャーでは1文字も増えない。** ⚠ が出るのは症状の可能性が
 * あるときだけにする——一覧は文字数の予算に張り付いていて、行を1本増やすと
 * 出る件数が減る（`manager.lastReport` の行の doc と同じ理由）。
 */
function describeTurnEnd(manager: ManagerSummary): string | null {
  if (manager.turnEndReason === undefined) return null;

  // **判定そのものは `classifyManagerActivity` へ切り出してある**
  // （`manager-activity.ts`）。ここでの分岐はもう判定をやり直さない——
  // 状態から「どちらの文面を出すか」を選ぶだけである。判定のロジック
  // （`turnEndedAt` が無い/`lastReportAt` と比べる/`NaN` の扱い）はそちらに
  // 移してあり、字面はここでは1バイトも変えていない。
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
      '**先に manager_start で起こし直さないこと** — 同じ仕事が2本になる。' +
      'この委譲は止まっていない・切っていない — この助言はデーモンが計算しただけで、' +
      '委譲は動き続けてよい。'
    );
  }

  const stopSequenceNote =
    manager.turnEndReason === 'stop_sequence'
      ? '**枠の壁（利用上限）の可能性が高い** — Issue #567 の「報告が配られない」とは別の原因である。 '
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
    '生ログの全文が読める。**先に manager_start で起こし直さないこと** — 同じ仕事が2本になる。' +
    'この委譲は止まっていない・切っていない — この助言はデーモンが計算しただけで、' +
    '委譲は動き続けてよい。'
  );
}

/**
 * 一覧に添える、「**道具の応答待ちのまま、誰も待っていない**」という矛盾への
 * 助言（Issue #572）。**判定はここで行う** — `ManagerSummary.toolUseStallPending`
 * の doc が「3条件目との突き合わせは読む側が行う」と書いている、その読む側が
 * この関数である（`describeTurnEnd` と同じ層の分け方）。
 *
 * **切らない・殺さない・止めない。** ここが何を返しても `status` は動かず、
 * どの委譲も abort しない、貸し出し期限も縮まない——伝えるだけである。
 *
 * 3条件（`probeToolUseStall` の doc）:
 * 1. 生ログの末尾の assistant 行が `stop_reason: 'tool_use'`
 * 2. その行の `tool_use` に対応する `tool_result` が生ログに無い
 * 3. **デーモンの `waiting` が空**（＝誰もその応答を待っていない）
 *
 * 1・2 は `probeToolUseStall` が生ログから計算して `toolUseStallPending` へ
 * 載せる。**3 をここで見る。**
 *
 * **⚠️ `waiting` が非空なら1文字も出さない。** それは「確認は届いていて、
 * クローンがまだ答えていないだけ」という**正常な状態**であり、一覧には既に
 * 「返事待ち(requestId: …)」の行が出ている。そこへ ⚠ を重ねると、答えれば
 * 済むものが異常に見える。**#572 の症状は「受信箱に一度も現れない」ことの
 * ほうである。**
 *
 * **⚠️ 時刻の閾値を1つも置かない。** 「何分経ったか」はここでは判定しない。
 * 道具を回しているなら、その応答を待っているのはデーモンのはずである——
 * **デーモンが待っていないのに SDK が待っているのは、時刻に関係なく矛盾で
 * ある。** 閾値を置くと、それより短い窓の症状が出力から消える（#572 の実例は
 * 91 分だったが、それは症状の下限ではない）。**経過は読み手（人間）が
 * `toolUseStallAt` を読んで判断する。**
 *
 * **⚠️ 助言は「確かめること」で終えず、分岐して1つの手に着地させる**（#572 の
 * 条件4）。この旗が立つ形は4つあり、**次の一手はそれぞれ別である**——
 * (1) 旗が凍っているだけ（読み捨てる） (2) 委譲が枠の壁で死んだ残骸
 * （`manager_stop` して引き継ぐ） (3) #572 の症状そのもの（**確認の本文を
 * 生ログから写してから** `manager_stop` して引き継ぐ） (4) 未応答の道具が
 * `Agent` で、作業者が走っている最中（止めずに待つ）。「生ログの末尾を
 * 確かめること」までしか言わないと、確かめた後の分岐が読み手の記憶の中にしか
 * 無い状態になる——**実際に踏んだクローンは4手のうち3手を記憶から補っていた。**
 *
 * **⚠️ (4) を落とさないこと。** 3条件は `Agent` の正常な長時間実行でも揃い
 * うる、と #572 が記録している（`Agent` の `tool_use` は `canUseTool` を
 * 通らないので `waiting` が空になる、という筋。**この repo では実測して
 * いない——#572 側でも演繹として置かれている**）。**分岐を (3) で終わらせる
 * と、この形だけが次の一手を持たないまま読み手の手元に残る**ので、確度が
 * 足りないほうへ倒さず、「止めずに待つ」という無害な手を1つ置いてある。
 *
 * **順番は費用の順である。** (1) は一覧に既に出ている状態表示を見るだけで
 * 済み、往復が要らない。⚠️ **旗は `running` のときにしか書き換わらない**
 * （`ManagerPool#probeTurnEnds` が `record.job.status !== 'running'` で
 * `continue` し、`toolUseStallPending` を書くのはその内側の `#probeTurnEndOf`
 * だけである）ので、`running` を離れた委譲の旗は**そこで凍った過去の記録**で
 * あって「いま止まっている」ではない。
 *
 * **⚠️ `isApiErrorMessage` はこの repo が作っている欄ではない**——CLI が生ログ
 * へ書く欄である（`packages/` に定義は無い）。文言でそう分かるように書いてある。
 *
 * **健全なマネージャーでは1文字も増えない**（`describeTurnEnd` と同じ理由——
 * 一覧は文字数の予算に張り付いていて、行を1本増やすと出る件数が減る）。
 * ⚠️ **この行は長い。** 予算に張り付いた一覧では長さがそのまま出る件数を削る
 * ので、足すなら「読んだクローンの次の一手が1つに決まる」に効く語だけにすること。
 */
function describeToolUseStall(manager: ManagerSummary): string | null {
  const pending = manager.toolUseStallPending;
  if (pending === undefined || pending.length === 0) return null;
  // **判定そのものは `classifyManagerActivity` へ切り出してある**
  // （`manager-activity.ts`）。3条件目（`waiting` が空か）もそちらで見ている
  // ——ここでの分岐はもう判定をやり直さない。字面はここでは1バイトも
  // 変えていない。
  if (classifyManagerActivity(managerActivityInputOf(manager)) !== 'stalled-tool-use') {
    return null;
  }

  const shown = pending.slice(0, LIST_TOOL_USE_STALL_LIMIT);
  const rest = pending.length - shown.length;
  const names = shown.map((item) => `${item.name ?? '（name 不明）'}(${item.id})`).join(' / ');
  // **`toolUseStallAt` が無い形をここで潰さない。** 行に `timestamp` が
  // 無かっただけで、矛盾そのものは成立している（`describeTurnEnd` の (A) と
  // 同じ原則——「分からない」を「症状ではない」へ倒さない）。
  const whenNote =
    manager.toolUseStallAt === undefined
      ? 'その行に timestamp が無かったので、いつからかは分からない'
      : `その行の timestamp は ${manager.toolUseStallAt}`;

  return (
    '  ⚠ 道具の応答待ちのまま、誰もその応答を待っていない（矛盾）。' +
    `生ログの末尾の assistant 行が stop_reason: tool_use で、対応する tool_result が生ログに無く、` +
    `かつデーモン側の返事待ち（waiting）が空である。未応答の道具: ${names}` +
    (rest > 0 ? `（ほか ${rest} 件、全 ${pending.length} 件）` : '') +
    `。${whenNote}。` +
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
    '(4) それが無いなら、未応答の道具の名前で分かれる。' +
    '確認系（AskUserQuestion / 許可確認）なら #572 の症状で、' +
    '確認はクローンの受信箱に一度も現れていない — ' +
    '確認の本文を生ログから写して Issue へ置いてから manager_stop して引き継ぐこと' +
    '（写さずに止めると、質問は誰にも読まれないまま消える）。' +
    'それ以外（Agent など）なら、作業者が走っている最中の正常な形でも同じ3条件が揃うので、' +
    'この行だけでは症状と区別できない — 止めずに、timestamp を見て次の一覧まで待つこと。' +
    '**先に manager_start で起こし直さないこと** — 同じ仕事が2本になる。'
  );
}

const NO_POOL = text(
  'いまは委譲できない場面である（記憶へ移すための内部ターン）。' +
    '実作業が必要なら、この場では記憶に残すだけにして、次の会話で委譲すること。',
);

// ---------------------------------------------------------------------------
// 記憶の human guard（人間が一度でも書いた記憶を、統合の走行が黙って壊せないよう
// にする歯）
// ---------------------------------------------------------------------------

/**
 * この歯を有効にするかの環境変数。**制限は方針で表し、方針は設定で開けられる
 * こと**（正典）。既定は有効（守る側）。
 *
 * **`permission-mode.ts` の `resolvePermissionModeFor` と同じ形にしてある** —
 * 空・空白は「未設定」として既定へ、綴りを間違えた値は黙って既定へ倒さず
 * 落とす（都度守っているつもりの持ち主が、綴りの間違いで気づけないままに
 * ならないため）。
 *
 * **これは能力の制限ではなく実行環境の設定である。** `off` にしても道具は
 * 1つも減らない — `memory_write` / `memory_delete` は変わらず在り、断られなく
 * なるだけである。
 */
export const MEMORY_GUARD_ENV = 'ALTEROID_MEMORY_GUARD';

/** 環境変数が受け付ける値。 */
export const MEMORY_GUARD_VALUES = ['on', 'off'] as const;
export type MemoryGuardValue = (typeof MEMORY_GUARD_VALUES)[number];

/** 既定値。ここを `off` に倒すと、統合の走行が人間の記憶を無条件に壊せる。 */
export const DEFAULT_MEMORY_GUARD: MemoryGuardValue = 'on';

export function resolveMemoryGuard(env: NodeJS.ProcessEnv = process.env): MemoryGuardValue {
  const given = env[MEMORY_GUARD_ENV]?.trim();
  if (given === undefined || given.length === 0) return DEFAULT_MEMORY_GUARD;
  if ((MEMORY_GUARD_VALUES as readonly string[]).includes(given)) {
    return given as MemoryGuardValue;
  }
  throw new Error(
    `${MEMORY_GUARD_ENV} の値が不正: ${given}（使えるのは on / off。既定は ${DEFAULT_MEMORY_GUARD}）`,
  );
}

/**
 * 歯が掛かる操作の名前。**この union に値を足したら `denialMessage` の
 * `switch` が `tsc` で落ちる**（`assertNeverMemoryGuardAction`）。
 *
 * ## ⚠️ 落ちるようになったのは #318 案 (b) からである。それ以前は落ちなかった
 *
 * この型に3つ目（`'frontmatter の更新'`）を足した時点の `denialMessage` は
 * 「代わりに使えるもの」と `ask_human` の文言を**三項演算子**
 * （`action === 'frontmatter の更新' ? A : B`）で分けていた。**三項演算子は
 * union が広がっても落ちない**——新しい値は黙って `B`（`memory_write` /
 * `memory_delete` 向けの文言）へ倒れる。実測（この repo の `main` =
 * `fba5289c`、`packages/core` の `tsc --noEmit`）: この union に
 * `| '節の移動'` を足しただけで `denialMessage` に1行も足さずに typecheck を
 * 通すと **exit 0** だった。**「型の側に既に歯が在る」は、当時は事実では
 * なかった。**
 *
 * **黙って倒れた先は嘘になる。** 節の移動で断られた呼び手に
 * 「`memory_append` を使えば失いたくないものは足せる」とだけ返すのは、
 * 「移す」という要求に対して答えになっていない。**だから `switch` に
 * 書き換えて、型の側に本当に歯を置いた。**
 */
type MemoryGuardAction = '全文置換' | '削除' | 'frontmatter の更新' | '節の移動';

/** `MemoryGuardAction` の網羅性を型で強制する（`assertNever*` の系）。 */
function assertNeverMemoryGuardAction(action: never): never {
  throw new Error(`未知の歯の対象: ${JSON.stringify(action)}`);
}

/**
 * `memory_write`（全文置換）・`memory_delete`・`memory_frontmatter_set`
 * （#318 案 (a)。frontmatter のキーだけの差し替え）・`memory_section_move`
 * （#318 案 (b)。節を別の文書へ移す）の歯そのもの。
 *
 * ## `memory_section_move` がここを通る理由
 *
 * **「移す」であって「消す」ではないが、*出どころの文書からは節が消える*。**
 * 移した先に同じ本文が在ることは、出どころの文書を元に戻す手段にはならない
 * （文書の形も文脈も変わっている）。**だから守りの対象である**——統合の
 * 走行からは、人間が書いた文書の節を動かせない。**移した先（`toSlug`）には
 * 歯を掛けない**（追記なので。`memory_append` がここを通らないのと同じ線）。
 *
 * **判定軸は「保護状態 × 書き手」だけである。量（文字数の減少率）では判定しない**
 * — 蒸留は正当な運用として大きく畳むことがあり、量では意図を分離できない
 * （設計の議論を見よ）。**`memory_frontmatter_set` も同じ判定をそのまま
 * 通す** — 判定を書き直さない（`tools.ts` の実装をここ1本に保つ。判定が
 * 2本になれば片方だけ直して片方が古いまま、という穴ができる）。
 *
 * - 書き手が `'clone'`（会話の中）なら常に通す。人間がその場に居る書き込みである。
 * - 書き手が `'distill'`（統合の走行。人間が居ない場）で、対象が `human` /
 *   `unknown`（守る側）なら断る。`clone-only` なら通す。
 *
 * **`canUseTool` をクローン層に繋いで止めて待つ形にはしない** — クローンは受信箱を
 * 直列に処理する単一セッションなので、待つとそのターンだけでなく全部が止まる
 * （`claude-provider.ts` に理由がある）。だから「断って返す」。`ask_human` は
 * 承認待ちに積むだけで応答を待たないので、断られた後 `ask_human` を通せば
 * 次のターンで実行できる — 能力は消えない。
 *
 * `memory_append` はここを通らない（呼ばない）。追記は記憶を失わないので、
 * どの書き手・どの保護状態でも断らない。
 */
async function guardFullReplace(
  stores: Stores,
  slug: string,
  cause: 'distill' | 'clone',
  action: MemoryGuardAction,
): Promise<string | null> {
  if (cause !== 'distill') return null;
  if (resolveMemoryGuard() === 'off') return null;
  const status = await stores.persona.protectionStatus(slug);
  // **`memoryProtectionAllowsFullReplace` と同じ判定を、ここでは switch で
  // 網羅的に書く。** 理由は2つ——(1) `human` / `unknown` に絞り込めた状態で
  // `denialMessage` へ渡したい（TS の型で「畳んでいない」ことを保証する）、
  // (2) 状態を1つ足したら `default` の `assertNeverMemoryProtectionStatus`
  // で `tsc` が落ちる（`memory.test.ts` の網羅性の話と同じ形）。
  switch (status.kind) {
    case 'clone-only':
      return null;
    case 'human':
    case 'unknown':
      return denialMessage(slug, status, action);
    default:
      return assertNeverMemoryProtectionStatus(status);
  }
}

/**
 * `memory_write` / `memory_append` / `memory_frontmatter_set` /
 * `memory_section_move` の4口が共有する、「毎ターンの床」の一言を組み立てる薄い
 * 糊。`describeMemoryFloor`（`memory.ts`）自体は前後の `MemoryFloor` を渡される
 * だけの純粋関数——ここで `measureMemoryFloor` と `resolveMemoryDocKind` へ
 * 渡す形に揃える。
 *
 * **実費: 呼び手は書き込みの前後で `stores.persona.documents()` を1回ずつ、
 * 合計2回追加で呼ぶ。** 元々この4口は `documents()` を呼んでいなかった——
 * `self_status` だけが呼んでいた。**2回なのは設計である**——1回にして「前の床」を
 * 「後の床」から逆算すると、数え方が実装として2本に割れる（`measureMemoryFloor`
 * の doc の「共有の下ごしらえから両方が呼ぶ」という条件そのものと矛盾する）。
 *
 * ## ⚠️ `documents()` と `list()` の重さは、ドライバによって違う
 *
 * **pg（本番）は同じである。** どちらも `content` 列を選ぶ
 * `SELECT ... ORDER BY slug` 1本である
 * （`grep -Fn -- 'async documents()' packages/storage-pg/src/persona.ts`）。
 *
 * **⚠️ fs（ローカル / 開発）は違う。`documents()` が全ファイルを2回読む**——
 * `list()` を呼んで（その中で全ファイルを読む）、返ってきた slug ごとに
 * `read()` でもう一度読む
 * （`grep -Fn -- 'async documents()' packages/storage-fs/src/persona.ts`）。
 * 実測で `documents()` 166.7ms 対 `list()` 80.7ms（110文書・1.1MB・N=20）。
 *
 * **⟹ 書き込み1回あたり `documents()` を2回呼ぶので、fs では全ファイルの
 * 読み出し4回ぶんになる。** pg では2クエリである。
 *
 * **⚠️ `FsPersonaStore.documents()` の二重読みは、この変更では直していない。
 * 観測として記録するにとどめる**（記憶ストアの実装であり、直すかどうかは
 * 別の判断である）。**書いておかないと、次に読む人が「知らなかったのか、
 * 意図して残したのか」を区別できない。**
 */
function memoryFloorNote(
  memoryBefore: readonly MemoryPart[],
  memoryAfter: readonly MemoryPart[],
  slug: string,
  writtenContent: string,
  created: boolean,
): string {
  return describeMemoryFloor({
    before: measureMemoryFloor(memoryBefore),
    after: measureMemoryFloor(memoryAfter),
    slug,
    kind: resolveMemoryDocKind(parseMemoryFrontmatter(writtenContent)),
    created,
  });
}

/**
 * `memory_write` / `memory_append` / `memory_frontmatter_set` /
 * `memory_section_move` の4口が共有する、「セッション構築時点からの増分」と
 * 「premise の大きさの順位」の2行を組み立てる薄い糊（P3、#318 の続き）。
 *
 * **`memoryFloorNote` とは別の糊にしてある。** あちらが要求するのは書き込み
 * 前後の `MemoryFloor`（before/after）だが、こちらが要るのは after 側の
 * 総文字数と `CloneRuntimeFacts.injectedMemoryChars` だけ——引数の形が
 * 違うので混ぜない（`measureMemoryFloor` の doc「数え方を2本に割ると
 * 黙って嘘をつく」と同じ理由で、既存の糊を条件分岐だらけにしない）。
 *
 * `runtime` は `context.runtime?.()` の戻り値をそのまま渡すこと——蒸留の
 * サイドクエリでも本番の配線は必ず値を渡すが（`describeMemorySessionDelta`
 * の doc）、テストのために省略できる口である以上、ここでは `undefined` を
 * 受けて `null` へ倒す。
 */
function memorySessionGrowthNote(
  memoryAfter: readonly MemoryPart[],
  runtime: CloneRuntimeFacts | undefined,
): string {
  const afterChars = measureMemoryFloor(memoryAfter).totalChars;
  const sessionDelta = describeMemorySessionDelta({
    afterChars,
    injectedMemoryChars: runtime?.injectedMemoryChars ?? null,
  });
  const ranking = describeMemoryPremiseRanking(memoryAfter);
  return [sessionDelta, ranking].join('\n\n');
}

/**
 * 歯の断りの返答。**「保護されています」だけでは、クローンが次の手を推測する
 * ことになる。** 必ず4つを言う——(1) なぜ断ったか、(2) どうすれば通るか
 * （`ask_human` に何を積めばよいかまで）、(3) いま何も失われていないこと、
 * (4) 口ごとに違う「代わりに使えるもの」の案内。
 *
 * **(1) は `human` と `unknown` を畳まない。** 前者は「人間の書き込みの履歴が
 * 実際に在る」という積極的な事実、後者は「履歴が確認できないので守る側へ倒した」
 * という消極的な既定——理由が違うので、読んだ側が畳まずに区別できる文にする。
 *
 * **(4) は `action` ごとに文言を分ける。** `全文置換` / `削除` では
 * 「`memory_append`（追記）はこの歯の対象ではなく断られない」が正しい代替
 * になる——追記は既存を消さないので、失いたくないだけならそちらで足りる。
 * **`frontmatter の更新`（`memory_frontmatter_set`）ではこれが効かない**
 * ——要旨や区分を直したい人に「本文の末尾に追記せよ」と勧めても意味が無い。
 * **`節の移動`（`memory_section_move`）では半分しか効かない**——移し先へ
 * 写すことは追記でできるが、出どころから節を消すことはできない。ここも
 * 別の文言にする。
 *
 * **⚠️ 3つとも `switch` で書く。三項演算子に戻さないこと。** `action` の
 * union に値を足したときに落ちるのはこの `switch` だけで、三項演算子は
 * 黙って `else` 側へ倒れる（`MemoryGuardAction` の doc に実測が在る）。
 */
function denialMessage(
  slug: string,
  status: Extract<MemoryProtectionStatus, { kind: 'human' | 'unknown' }>,
  action: MemoryGuardAction,
): string {
  const reason =
    status.kind === 'human'
      ? `この文書には人間の書き込みの履歴が在る（保護状態: human）`
      : `この文書の書き込みの履歴が確認できない（保護状態: unknown。索引が無い・外から書き換えられた` +
        `可能性がある、などのときにここへ倒す——不明を「人間は書いていない」とは読まず、守る側へ倒す）`;

  const alternative = ((): string => {
    switch (action) {
      case '全文置換':
      case '削除':
        return 'memory_append（追記）はこの歯の対象ではなく、断られない。失いたくないだけならそちらを使うこと。';
      case 'frontmatter の更新':
        return (
          'memory_append（追記）はここでは代わりにならない——追記は本文の末尾に文字列を足すだけで、' +
          'frontmatter のキー（description / type / parent）は直せない。'
        );
      case '節の移動':
        return (
          'memory_append（追記）はこの歯の対象ではないので、移し先の文書へ本文を写すことだけは断られない' +
          '——ただし出どころの文書から節を消すことはできないので、写した後は同じ本文が2箇所に残る。' +
          '失いたくないだけならそれで足りる。'
        );
      default:
        return assertNeverMemoryGuardAction(action);
    }
  })();

  // **助詞が壊れる口だけ文を組み替える。** 「記憶 slug を frontmatter の
  // 更新したい」「記憶 slug を節の移動したい」は日本語として壊れる
  // （「〜を全文置換したい」「〜を削除したい」と違い、対象が記憶そのもの
  // ではないから）。
  const askHumanHint = ((): string => {
    const tail =
      '」のように積むこと。人間の回答が届いた後の次のターンで、同じ操作をやり直せば実行できる' +
      '（この場・このターンではやり直せない）。';
    switch (action) {
      case '全文置換':
      case '削除':
        return `本当に${action}が必要だと判断したら、ask_human に「記憶 ${slug} を${action}したい。理由: 〈ここに理由〉${tail}`;
      case 'frontmatter の更新':
        return `本当に frontmatter の更新が必要だと判断したら、ask_human に「記憶 ${slug} の frontmatter を更新したい。理由: 〈ここに理由〉${tail}`;
      case '節の移動':
        return `本当に節の移動が必要だと判断したら、ask_human に「記憶 ${slug} から節を1つ別の文書へ移したい。理由: 〈ここに理由〉${tail}`;
      default:
        return assertNeverMemoryGuardAction(action);
    }
  })();

  return [
    `記憶 ${slug} への${action}を、統合の走行（distill）から断った。`,
    `理由: ${reason}。`,
    'いま何も変わっていない（記憶は断る前のまま残っている）。',
    alternative,
    askHumanHint,
  ].join(' ');
}

/** `MemorySectionLookup` の網羅性を型で強制する（`assertNever*` の系）。 */
function assertNeverMemorySectionLookup(lookup: never): never {
  throw new Error(`未知の節の照合結果: ${JSON.stringify(lookup)}`);
}

/**
 * 節id が1つに決まらなかったときの断り文。
 *
 * ## ⚠️ 3つを同じ「見つかりません」に畳まないこと。**疑う先が違う**
 *
 * | 断り | 意味 | 呼び手が次にやること |
 * | --- | --- | --- |
 * | **そんな id は無い** | 打ち間違い／別の文書／見出しごと書き換えられた | 文書を確かめる |
 * | **その id は古い** | **誰かが中身を書き換えた** | `memory_outline` を取り直す |
 * | **曖昧である** | 中身まで同一の節が複数在る | 別の指し方をする（節を書き分ける） |
 *
 * 畳むと、**いちばん重い「誰かが書き換えた」が「打ち間違い」に見える。**
 * 呼び手は同じ id をもう一度打ちに行き、また断られる——そのあいだ、本当に
 * 起きたこと（並行編集）は一度も観測されない。判定の材料は
 * `memorySectionId` の doc に在る。
 *
 * **曖昧なときに「どちらか」を選ばない。** 片方を黙って選ぶと、**消える側が
 * 観測できない**（応答は「移した」としか言わない）。稀で、しかも正直な
 * 断りである。
 */
function describeMemorySectionLookupFailure(
  slug: string,
  id: string,
  lookup: Exclude<MemorySectionLookup, { kind: 'found' }>,
): string {
  switch (lookup.kind) {
    case 'absent':
      return (
        `記憶 ${slug} に節id ${id} の節は無い。打ち間違いか、別の文書の節id か、` +
        '見出しごと書き換えられたかのどれかである。memory_outline で目次を取り直すこと' +
        '（何も変わっていない）。'
      );
    case 'stale':
      return (
        `節id ${id} は古い。記憶 ${slug} に同じ見出しの節は在るが、中身のハッシュが違う——` +
        `**この目次を読んだ後で、誰かがこの節を書き換えている。** 節id は指し先であると同時に版の照合` +
        `なので、ここで断って上書きを防いでいる。memory_outline で ${slug} の目次を取り直し、` +
        '中身を確かめてから新しい節id でやり直すこと（何も変わっていない）。'
      );
    case 'ambiguous':
      return (
        `節id ${id} は記憶 ${slug} の中で ${lookup.sections.length} 箇所に当たる` +
        '（見出しも中身も完全に同一の節が複数ある）。**どちらかを選ばずに断る**——' +
        '黙って一方を選ぶと、消えた側を後から観測する手段が無い。' +
        'どちらか一方の中身を先に書き分けてから（memory_write で1行足すなど）やり直すこと' +
        '（何も変わっていない）。'
      );
    default:
      return assertNeverMemorySectionLookup(lookup);
  }
}

/** ツール定義そのもの。MCP の配線を通さずに単体テストできるよう分けてある。 */
export function createCloneTools(context: ToolContext) {
  const { stores } = context;
  // **ここで1回だけ解決しない。** `memoryCause` はターンごとに変わりうる値
  // なので、この関数の実行時（＝ MCP サーバを組む時）に確定させると、
  // セッション中ずっと最初のターンの種類に固定されてしまう
  // （`ToolContext.memoryCause` の doc）。3箇所の道具ハンドラの中で
  // その都度呼ぶ。
  // **倒れ先を作らない。** `memoryCause` は型として必須だが、型の抜け道
  // （`as unknown as ToolContext` / JS からの呼び）では届かないことがありうる。
  // 既定へ倒すと日誌の `cause` が嘘になるので、落とす（`ToolContext.memoryCause`
  // の doc）。**⚠️ 届かなかった値そのものは書かない** —— 記憶の本文が例外の
  // メッセージへ漏れる経路を作らない（`noteDroppedRecord` が `safeParse` の
  // `error.message` を跡へ渡さないのと同じ線）。
  if (typeof context.memoryCause !== 'function') {
    throw new Error(
      'memoryCause が届いていない。ToolContext を組む側で明示すること' +
        '（既定値へ倒すと、呼び手が名乗らなかったことを「蒸留の走行だった」として' +
        '日誌に記録することになる）。',
    );
  }
  const memoryCause = context.memoryCause;

  return [
    // --- 記憶 -----------------------------------------------------------
    tool(
      'memory_list',
      [
        '記憶の文書一覧を返す。中身は返さない。',
        '各行は `[premise|fact] slug: title (作成: createdAt / 更新: updatedAt) — 要旨` の形。',
        '作成は書き込まれた瞬間にその場で分かる。「不明」と出るのは、この配線より前に作られ、',
        '日誌にも根拠（最初の書き込み）が無い古い記憶だけである（ファイルの mtime は使わない）。',
        'premise はプロンプトへ全文が焼き込まれている。fact は目次の1行だけがプロンプトに載るので、',
        '中身が要るなら memory_read で開くこと。要旨の前に付く印（⚠古い要旨 / ？鮮度不明）は',
        'description が最後の本文変更より前に書かれた可能性があることを示す（本文と合っている保証ではない）。',
        '階層は frontmatter の parent から組み立てた木で、インデントで表す。',
      ].join(' '),
      {},
      async () => {
        const documents = await stores.persona.list();
        return text(
          renderMemoryListing(
            documents.map((doc) => ({
              slug: doc.slug,
              title: doc.title,
              kind: doc.kind,
              description: doc.description,
              descriptionFreshness: doc.descriptionFreshness,
              parent: doc.parent,
              updatedAt: doc.updatedAt,
              createdAt: doc.createdAt,
            })),
          ),
        );
      },
    ),

    tool(
      'memory_read',
      ['記憶の文書を1つ読む。', '長ければ切れて出る（続きの取り方が出力に付く）。'].join(' '),
      {
        slug: z.string().describe('文書のスラッグ（拡張子なし）'),
        offset: z.number().int().min(0).optional().describe('何文字目から読むか（既定 0）'),
      },
      async ({ slug, offset = 0 }) => {
        const doc = await stores.persona.read(slug);
        if (!doc) return text(`記憶 ${slug} は存在しない。`);
        const part = page(doc.content, offset, MEMORY_PAGE);
        const tail = part.more
          ? `\n\n…（ここで切れている。続きは memory_read slug=${slug} offset=${part.to}）`
          : '';
        // **切れていないときは注記を出さない。** 毎回付けると、本当に切れている
        // ときの目印が効かなくなる（`excerpt` と同じ理由）。
        if (part.from === 0 && !part.more) return text(part.body);
        return text(`（${describePage(part)}）\n\n${part.body}${tail}`);
      },
    ),

    tool(
      'memory_write',
      [
        '記憶の文書を全文置換する（無ければ作る）。',
        '人間がこのファイルを直接開いて読むことを前提に、Markdown として読みやすく書くこと。',
        '人間が手で書いた記述を、整形の都合で消さないこと。',
        '先頭に frontmatter を置ける（無くてもよい。無ければ premise として全文が焼かれる——安全側の既定）。',
        '形は `---` で始まり `---` で閉じ、各行は `key: value`。使えるキーは description（要旨。目次の1行に載る）・',
        'type（premise または fact。premise は全文が焼かれ、fact は目次の1行だけになる。判断の前提なら premise、',
        '事実の蓄積で毎回全文を読む必要が無いものなら fact）・parent（親文書の slug。階層を作る）の3つだけ。',
        'ネスト・複数行・引用符の解釈は無い（値は文字列としてそのまま読む）。狭い形から外れると malformed として',
        '扱われ、文書は消えずに premise（全文）のまま残る。',
        '**統合の走行（distill）からは、人間が一度でも書いた文書・履歴の無い文書には使えない**',
        '（断られる。ask_human で人間に確認を通せば次のターンで実行できる）。会話の中の書き込みは通る。',
        '成功すると差分の要約が返る——前後の文字数（バイトではない）と、この書き込みで消えた見出しの名指し。',
        '**「消えた見出し: なし」を全幅で信じないこと**——同じ見出しが他所に1つでも残っていれば、その節を丸ごと消しても「なし」になる。',
        '見出しは行頭の `#`〜`######`（ATX）だけ（setext の下線は数えない）で、コードフェンスの中は除外しない（過剰に拾う側へ倒してある）。',
      ].join(' '),
      {
        slug: z.string().describe('文書のスラッグ（英小文字・数字・-・_）'),
        content: z.string().describe('Markdown 全文'),
        summary: z.string().describe('何を更新したかの一行要約（日誌に残る）'),
      },
      async ({ slug, content, summary }) => {
        const cause = memoryCause();
        const denial = await guardFullReplace(stores, slug, cause, '全文置換');
        if (denial !== null) return text(denial);
        const [before, memoryBefore] = await Promise.all([
          stores.persona.read(slug),
          stores.persona.documents(),
        ]);
        const written = await stores.persona.write(slug, content);
        const memoryAfter = await stores.persona.documents();
        await stores.journal.append({
          type: 'memory_update',
          slug,
          cause,
          action: 'write',
          bytesBefore: before === null ? 0 : Buffer.byteLength(before.content, 'utf8'),
          bytesAfter: Buffer.byteLength(written.content, 'utf8'),
          summary,
        });
        const diff = describeMemoryWriteDiff(
          before === null ? null : before.content,
          written.content,
        );
        const floor = memoryFloorNote(
          memoryBefore,
          memoryAfter,
          slug,
          written.content,
          before === null,
        );
        const reinjection = describeMemoryReinjectionEstimate([written], memoryAfter);
        const growth = memorySessionGrowthNote(memoryAfter, context.runtime?.());
        return text(
          `記憶 ${slug} を更新した。\n\n${diff}\n\n${floor}\n\n${reinjection}\n\n${growth}`,
        );
      },
    ),

    tool(
      'memory_append',
      [
        '記憶の文書の末尾に追記する（無ければ作る）。既存の記述を消したくないときはこちら。',
        '成功すると memory_write と同じ差分の要約が返る（前後の文字数と、消えた見出しの名指し。見出しの数え方も同じ）。',
        '追記は既存を消さないので、消えた見出しは常に 0 件のはずである——0 件でなければ異常を疑うこと。',
      ].join(' '),
      {
        slug: z.string().describe('文書のスラッグ'),
        content: z.string().describe('追記する Markdown'),
        summary: z.string().describe('何を追記したかの一行要約（日誌に残る）'),
      },
      async ({ slug, content, summary }) => {
        const [before, memoryBefore] = await Promise.all([
          stores.persona.read(slug),
          stores.persona.documents(),
        ]);
        const written = await stores.persona.append(slug, content);
        const memoryAfter = await stores.persona.documents();
        await stores.journal.append({
          type: 'memory_update',
          slug,
          cause: memoryCause(),
          action: 'append',
          bytesBefore: before === null ? 0 : Buffer.byteLength(before.content, 'utf8'),
          bytesAfter: Buffer.byteLength(written.content, 'utf8'),
          summary,
        });
        const diff = describeMemoryWriteDiff(
          before === null ? null : before.content,
          written.content,
        );
        const floor = memoryFloorNote(
          memoryBefore,
          memoryAfter,
          slug,
          written.content,
          before === null,
        );
        const reinjection = describeMemoryReinjectionEstimate([written], memoryAfter);
        const growth = memorySessionGrowthNote(memoryAfter, context.runtime?.());
        return text(
          `記憶 ${slug} に追記した。\n\n${diff}\n\n${floor}\n\n${reinjection}\n\n${growth}`,
        );
      },
    ),

    /**
     * 記憶の文書ごと消す口。
     *
     * **人間の側には既に在る**（CLI の `alteroid memory remove <slug>`、
     * HTTP の `DELETE /memory/:slug`、`PersonaStore.remove`）。クローンの道具には
     * `memory_list` / `read` / `write` / `append` の4本しか無く、削除だけが
     * 欠けていた——`schedule_remove` は在るのにここだけ非対称（north_star 禁止1）。
     *
     * **部分削除の引数は作らない。** 文書の一部を消したいなら `memory_write` の
     * 全文置換で足りる。ここは「文書そのものを無くす」ためだけの口である。
     *
     * **存在しないスラッグを黙って成功にしない。** `PersonaStore.remove` は
     * ストア層では冪等（無ければ何もしないで返る）だが、それをそのまま道具の
     * 応答にすると「消したつもりで何も消えていない」を作る。`DELETE /memory/:slug`
     * と同じく、まず `read()` で在るかを確かめ、無ければ 404 相当の返事をする。
     *
     * **本文は日誌へ写さない。** 残すのはスラッグと消す直前の文字数だけ
     * （AGENTS.md「秘密の扱い」— 記憶の中身を別の場所へ増やさない）。
     *
     * **書き手（人間 / クローン / 統合の走行）は `ToolContext.memoryCause` から
     * 分かる。** これは書き手そのものの判別ではなく「この道具をどのターンが
     * 呼んだか」の申告で、`'human'` はここからは出ない（`'human'` を書くのは
     * `app.ts` の `PUT` / `DELETE /memory/:slug` の2箇所だけである）。**この
     * 道具（`memory_delete`）自体は誰が呼んでも「消せる」——歯は「文書が過去に
     * 人間の手を経たか（保護状態）」×「呼んだのが統合の走行か」の組み合わせに
     * だけ付く（`guardFullReplace`）。** 会話の中のクローンの判断で消すのは、
     * 保護状態を問わず常に通る。
     */
    tool(
      'memory_delete',
      [
        '記憶の文書を1つ、文書ごと消す（部分削除ではない。一部を変えたいだけなら memory_write を使う）。',
        '無いスラッグを渡しても成功にはならず、そう返る。',
        '消した事実は日誌に残る（スラッグと直前の文字数のみ。本文は残らない）。',
        '**統合の走行（distill）からは、人間が一度でも書いた文書・履歴の無い文書は消せない**',
        '（断られる。ask_human で人間に確認を通せば次のターンで実行できる）。会話の中の削除は通る。',
      ].join(' '),
      {
        slug: z.string().describe('記憶のスラッグ（拡張子なし）'),
        summary: z.string().describe('なぜ消したかの一行要約（日誌に残る。本文は残らない）'),
      },
      async ({ slug, summary }) => {
        const existing = await stores.persona.read(slug);
        if (existing === null) {
          return text(`記憶 ${slug} は存在しない（消せない。何も変わっていない）。`);
        }
        const cause = memoryCause();
        const denial = await guardFullReplace(stores, slug, cause, '削除');
        if (denial !== null) return text(denial);
        await stores.persona.remove(slug);
        await stores.journal.append({
          type: 'memory_update',
          slug,
          cause,
          action: 'remove',
          // バイト数は機械可読な面（下の bytesBefore/bytesAfter）に出す。
          // summary の「（削除直前 N 文字）」は人が読む文字数で、別の軸として残す
          // （両方を消さない——`action` の doc と同じ理由）。
          bytesBefore: Buffer.byteLength(existing.content, 'utf8'),
          bytesAfter: 0,
          summary: `${summary}（削除直前 ${existing.content.length} 文字）`,
        });
        return text(`記憶 ${slug} を消した（削除直前 ${existing.content.length} 文字）。`);
      },
    ),

    /**
     * frontmatter（`description` / `type` / `parent`）だけを差し替える口
     * （#318 案 (a)）。
     *
     * **なぜ要るか。** `memory_write` は全文置換しか無いので、要旨や区分を
     * 直すだけでも本文全体をツール呼び出しの中に再生成する必要があった。
     * 記憶には控えも履歴も無いので、本文が途中で切れても突き合わせる相手が
     * 存在しない——だからクローンは全文置換を安全に選べず、要旨は古いまま
     * 放置され続けていた（`memory_list` の `⚠古い要旨`）。
     *
     * **この口の性質は「本文がツール呼び出しの中に一度も現れないこと」**
     * である（`applyMemoryFrontmatterPatch` の doc）。`content` はストアから
     * 読んだ値をそのまま渡すだけで、モデルの引数には frontmatter の3キー
     * しか登場しない。だから本文が切れて通る経路が構造的に無い——「検出
     * できる」より強い「起こりえない」。
     *
     * **⚠️ 「本文が切れない」と「本文に文字列が混ざらない」は別の性質である。**
     * `serializeMemoryFrontmatter` は各キーを `key: value` の1行として書く
     * ので、値に改行が入っていると、その続きが frontmatter の別のキー・
     * 閉じの `---`・本文の1行目として紛れ込む（本文そのものは失われない
     * ——古い `content` から取るだけなので1バイトも消えない。だが値の
     * 続きが「本文の先頭」として現れる）。**だから改行を含む値は入口で
     * 断る**（`containsMemoryFrontmatterLineBreak`）。上の段落（切断が
     * 起こりえないこと）と、この段落（混入が起こりえないこと）は独立した
     * 2つの保証であり、どちらか片方の歯でもう片方も測ったことにしない。
     *
     * **既に在る文書にしか使えない。** ここは「文書を直す口」であって
     * 「作る口」ではない（`memory_delete` が存在しない slug を成功にしない
     * のと同じ判断）。
     *
     * **`malformed` な frontmatter には断る。** 壊れた frontmatter を機械が
     * 推測して組み直すと、本文を食う経路ができる
     * （`parseMemoryFrontmatter` の「既知の落とし穴」——Markdown の水平線も
     * `---` の1行である）。断って `memory_write` か `ask_human` へ回す。
     *
     * **`guardFullReplace` をそのまま呼ぶ。** 判定を書き直さない
     * （`guardFullReplace` の doc）。
     */
    tool(
      'memory_frontmatter_set',
      [
        '記憶の frontmatter（description・type・parent）のうち、渡したキーだけを差し替える／追加する。',
        '本文には一切触れない——本文はストアから読んだ古い content からそのまま取るので、1バイトも失われない。',
        'この道具の呼び出しの中に本文が現れることは無いので、本文が途中で切れることも構造的に起こりえない。',
        'description・type・parent の値に改行（\\n / \\r）を含む値は渡せない（断る）——値から本文へ文字列が混ざる経路を構造的に無くすため。',
        '既に在る文書にしか使えない（存在しない slug には断る。新規作成は memory_write を使うこと）。',
        'frontmatter が無い文書には、先頭に新しく frontmatter を作って足す（type を渡さなければ premise のまま——載り方は変わらない）。',
        'frontmatter が壊れている（malformed）文書には断る（機械が推測して組み直すと本文を食う経路ができるため）。',
        'memory_write で全文を書き直すか、人間に確認を通すこと。',
        'description・type・parent のうち少なくとも1つを渡すこと（1つも渡さない呼びは断る。何も変わらない）。',
        'type に渡せるのは premise か fact のどちらかだけ（それ以外の値は断る。綴りを間違えたまま黙って書かない）。',
        'premise は全文がプロンプトへ焼かれ、fact は目次の1行だけになる。区分が変わったときは、その変化が応答に出る。',
        '**統合の走行（distill）からは、人間が一度でも書いた文書・履歴の無い文書には使えない**',
        '（断られる。ask_human で人間に確認を通せば次のターンで実行できる）。会話の中の書き込みは通る。',
      ].join(' '),
      {
        slug: z.string().describe('文書のスラッグ（拡張子なし）'),
        description: z
          .string()
          .optional()
          .describe('要旨（目次の1行に載る）。渡さなければ既存の値のまま'),
        type: z
          .string()
          .optional()
          .describe(
            'premise か fact のどちらかのみ（それ以外は断る）。渡さなければ既存の値のまま（既定は premise）',
          ),
        parent: z.string().optional().describe('親文書の slug（階層）。渡さなければ既存の値のまま'),
        summary: z.string().describe('何を直したかの一行要約（日誌に残る）'),
      },
      async ({ slug, description, type, parent, summary }) => {
        if (description === undefined && type === undefined && parent === undefined) {
          return text(
            `記憶 ${slug} の frontmatter を直すには description・type・parent のうち少なくとも1つを渡すこと` +
              '（何も変わっていない）。',
          );
        }

        // **frontmatter の値は1キー1行で書く約束である。** 改行（\n / \r）を
        // 含む値をそのまま書くと、`serializeMemoryFrontmatter` がそれを
        // そのまま行として並べるので、値の続きが別の行——他のキー・閉じの
        // `---`・本文の1行目——として紛れ込む（`containsMemoryFrontmatterLineBreak`
        // の doc）。**本文そのものは失われない**（古い `content` から取るだけ）
        // が、値から本文へ文字列が混ざる経路ができてしまう。ここで断ることで
        // その経路を構造的に塞ぐ——`type` の検査と同じ位置（ストアを読む前）
        // に置き、断りの前に副作用が入る余地を作らない。
        const lineBreakInputs: readonly ['description' | 'type' | 'parent', string | undefined][] =
          [
            ['description', description],
            ['type', type],
            ['parent', parent],
          ];
        const lineBreakEntry = lineBreakInputs.find(
          ([, value]) => value !== undefined && containsMemoryFrontmatterLineBreak(value),
        );
        if (lineBreakEntry !== undefined) {
          const [lineBreakKey] = lineBreakEntry;
          return text(
            `記憶 ${slug} の frontmatter を更新できない——${lineBreakKey} に改行（\\n / \\r）を含む値は渡せない` +
              '（frontmatter は1キー1行で書く約束なので、改行が入ると値の続きが本文や他のキーと混ざる）。' +
              '何も変わっていない。',
          );
        }

        // **`type` は自由文字列では受けない。** `z.string()` のままだと綴りを
        // 間違えた値（`Fact` / `facts` 等）がそのまま frontmatter へ書かれる
        // ——`resolveMemoryDocKind`（読み出し側）は未知の値を `premise` へ
        // 倒すので区分は実際には変わらないのに、`priorKind === nextKind` に
        // なって `kindChangeNote` が空になり、**書き手には「変えた」つもりが
        // 残ったまま、応答は何も言わない。** ここで断ることで、書き込み側の
        // 入口だけを狭める（読み出し側の安全弁 `resolveMemoryDocKind` の既定は
        // 触らない——既存文書・`memory_write` が書いた任意の値を受ける必要が
        // 引き続きあるため）。
        if (type !== undefined && !isKnownMemoryDocKind(type)) {
          return text(
            `記憶 ${slug} の frontmatter を更新できない——type に渡せるのは premise か fact のどちらかだけである` +
              `（渡された値: ${JSON.stringify(type)}）。何も変わっていない。`,
          );
        }

        const existing = await stores.persona.read(slug);
        if (existing === null) {
          return text(
            `記憶 ${slug} は存在しない（frontmatter を直せない。新規作成は memory_write を使うこと。` +
              '何も変わっていない）。',
          );
        }

        const cause = memoryCause();
        const denial = await guardFullReplace(stores, slug, cause, 'frontmatter の更新');
        if (denial !== null) return text(denial);

        const priorFrontmatter = parseMemoryFrontmatter(existing.content);
        if (priorFrontmatter.kind === 'malformed') {
          return text(
            `記憶 ${slug} の frontmatter が壊れている（malformed）。ここでは直さない——` +
              '機械が推測して組み直すと本文を食う経路ができるため。memory_write で全文を書き直すか、' +
              '人間に確認を通すこと（何も変わっていない）。',
          );
        }

        const priorKind = resolveMemoryDocKind(priorFrontmatter);
        const nextContent = applyMemoryFrontmatterPatch(existing.content, {
          description,
          type,
          parent,
        });
        const memoryBefore = await stores.persona.documents();
        const written = await stores.persona.write(slug, nextContent);
        const memoryAfter = await stores.persona.documents();
        const nextKind = resolveMemoryDocKind(parseMemoryFrontmatter(written.content));

        await stores.journal.append({
          type: 'memory_update',
          slug,
          cause,
          action: 'describe',
          bytesBefore: Buffer.byteLength(existing.content, 'utf8'),
          bytesAfter: Buffer.byteLength(written.content, 'utf8'),
          summary,
        });

        const diff = describeMemoryWriteDiff(existing.content, written.content);
        const kindLabel = (kind: 'premise' | 'fact'): string =>
          kind === 'premise' ? 'premise（全文が載る）' : 'fact（目次の1行だけ載る）';
        const kindChangeNote =
          priorKind === nextKind
            ? ''
            : `\n\n区分が変わった: ${kindLabel(priorKind)} → ${kindLabel(nextKind)}。` +
              (nextKind === 'fact'
                ? '次のターンから、この文書の本文はプロンプトの全文には載らない（目次の1行だけになる）。'
                : '次のターンから、この文書の本文はプロンプトへ全文が載る。');
        // `memory_frontmatter_set` は既存文書にしか使えない（上の `existing === null`
        // の断り）ので `created` は常に false。
        const floor = memoryFloorNote(memoryBefore, memoryAfter, slug, written.content, false);
        const reinjection = describeMemoryReinjectionEstimate([written], memoryAfter);
        const growth = memorySessionGrowthNote(memoryAfter, context.runtime?.());

        return text(
          `記憶 ${slug} の frontmatter を更新した。\n\n${diff}${kindChangeNote}\n\n${floor}\n\n${reinjection}\n\n${growth}`,
        );
      },
    ),

    /**
     * 記憶の文書の目次（節id・見出し・各節の文字数）を返す口
     * （#318 案 (b) の片方）。**読むだけである。**
     *
     * **なぜ要るか。** `fact` の文書はプロンプトへ目次の1行しか載らないので、
     * その中の節を指す材料が手元に無い。`memory_read` で読めば材料は手に
     * 入るが、**そのために文書の全文が文脈へ入る**——`MEMORY_PAGE` は
     * 8,000 文字なので、大きな文書ほど何回も呼ぶことになり、
     * `memory_section_move` が避けようとした形そのものになる。
     *
     * **歯も守りも要らない。** 何も書き換えないので `guardFullReplace` を
     * 呼ばない（`memory_list` / `memory_read` と同じ線）。
     *
     * **本文は1文字も返さない。** `memory_delete` が本文を日誌へ写さないのと
     * 同じ判断（AGENTS.md「秘密の扱い」— 記憶の中身を別の場所へ増やさない）。
     * ここで本文を返すと、この道具を呼ぶこと自体が「文脈へ入れずに構造を
     * 見る」という存在理由を潰す。
     *
     * **`malformed` な frontmatter でも目次は返す。** 読むだけなので断る
     * 理由が無い（能力を消さない側）。ただし `memory_section_move` はその
     * 文書を断るので、**そのことを応答に書く**——目次だけ読めて移動だけ
     * 断られると、呼び手には理由が見えない。
     */
    tool(
      'memory_outline',
      [
        '記憶の文書の目次を返す（読むだけ。1文字も書き換えない）。',
        '各行は `[節id] 見出し行 — N 文字` で、インデントが見出しの深さを表す。文字数は入れ子の子を含むので、その節を動かしたときに動く量がそのまま出る。',
        '本文は1文字も返さない（本文が要るなら memory_read）。frontmatter の行も出ない。',
        '節id は memory_section_move の指し先であると同時に、その節の版の照合でもある——中身が変われば id も変わるので、目次を読んでから移すまでの間に誰かがその節を書き換えていたら断られる。移す直前に取り直すこと。',
        '中身まで同一の節が2つあると id が衝突する。その行には印が付き、その id では動かせない。',
      ].join(' '),
      {
        slug: z.string().describe('文書のスラッグ（拡張子なし）'),
      },
      async ({ slug }) => {
        const doc = await stores.persona.read(slug);
        if (doc === null) return text(`記憶 ${slug} は存在しない。`);
        const { sections } = scanMemorySections(doc.content);
        const malformedNote =
          parseMemoryFrontmatter(doc.content).kind === 'malformed'
            ? '\n\n⚠この文書の frontmatter は壊れている（malformed）。目次はこのまま読めるが、' +
              'memory_section_move はこの文書を断る（memory_write で全文を書き直すか、人間に確認を通すこと）。'
            : '';
        return text(
          `記憶 ${slug} の目次（${sections.length} 節）。本文は含まない。\n\n` +
            `${renderMemoryOutline(sections)}${malformedNote}`,
        );
      },
    ),

    /**
     * 節id で指した節を、別の文書の末尾へ移す口（#318 案 (b)）。
     *
     * ## この口の存在理由 — **本文が0文字である**
     *
     * 大きな `premise` の文書を「小さな芯 + 付録の `fact`」へ割るには、
     * 節を別の文書へ動かす必要がある。いまその手段は「新しい文書へ
     * `memory_write` で書き写す → 元を全文置換で縮める」しかなく、**両方の
     * 呼び出しに本文が現れる**（3万文字級）。記憶には控えも履歴も無いので、
     * 途中で切れても突き合わせる相手が無い。
     *
     * **この口は、本文がツール呼び出しにも応答にも一度も現れない（0文字）。**
     * `memory_frontmatter_set` が持っていた「切れることが起こりえない」と
     * 同じ性質である。歯（`tools.test.ts`）が、節に置いた目印の文字列が
     * 応答に1文字も出ないことを測っている。
     *
     * ## ⚠️ 順序は「先に足して、後で消す」
     *
     * **`PersonaStore` に2文書をまたぐトランザクションは無い。** だから
     * 途中で落ちる可能性は消せない——消せるのは**どちらへ倒れるか**だけで
     * ある。先に足して後で消せば、途中で落ちたときに残るのは**重複**で
     * ある（同じ節が両方に在る）。逆順にすると、落ちたときに残るのは
     * **消失**である。**失う側に倒れない。**
     *
     * 落ちたときは、そのことを名乗って返す——「移した」とだけ返すと、
     * 呼び手は重複に気づけない。歯が `tools.test.ts` に在る。
     *
     * ## 守り
     *
     * **`guardFullReplace` をそのまま呼ぶ。判定を書き直さない**
     * （`guardFullReplace` の doc）。**「移す」であって「消す」ではないが、
     * 出どころの文書からは節が消える**ので守りの対象である。移した先には
     * 掛けない（追記なので。`memory_append` と同じ線）。
     *
     * ## frontmatter を触らないことは3層で守る
     *
     * 1. **指す値が存在しない。** 節id は `memoryBodyStart` より後ろの
     *    見出しにしか発行されない（`scanMemorySections`）。frontmatter を
     *    名指しする値がそもそも無い——行番号方式・オフセット方式を採らな
     *    かった理由がここである
     * 2. **組み立ては継ぎ足し。** `cutMemorySection` は `slice` を2つ繋ぐ
     *    だけで、**frontmatter のバイト列は添字で運ばれるだけで一度も
     *    書き直されない**（`serializeMemoryFrontmatter` を通さないので、
     *    キーの順序の正規化すら起きない）
     * 3. **書き込み前に確かめる。** frontmatter のバイト列が同一であることと
     *    `parseMemoryFrontmatter().kind` が変わっていないことを検査し、
     *    外れたら**断って何も書かない**
     *
     * ### ⚠️ 3層目は、いまの実装では死んだ枝である（正直に書く）
     *
     * 設計はこの3層目を「frontmatter を持たない文書の最初の節を
     * `---\ndescription: 乗っ取り\n---\n# 見出し` で**置き換える**と、無かった
     * はずの frontmatter が生える」形への手当てとして求めていた。**それは
     * `memory_section_replace`（作らないと決めた口）の話である**——置換には
     * 呼び手が渡す任意の文字列が在るが、**移動には呼び手の文字列が1つも無い。**
     *
     * **実際、この断りへ到達する入力を1つも構成できなかった。** 切り取りは
     * `slice` を2つ繋ぐだけで、`section.start` は必ず `memoryBodyStart` 以上、
     * かつ切り取り後の1行目は見出し行（`#` で始まる）か空文字にしかならない。
     * ⟹ `parseMemoryFrontmatter().kind` は動きようが無い。
     *
     * **それでも残す。** 1層目・2層目が守っているのは「frontmatter を
     * 書き換えないこと」だけで、**「本文だったものが frontmatter に化ける」は
     * 別の性質**である。次にここを触る人が継ぎ足しをやめて組み直す形へ変えた
     * とき、この検査だけがその性質を持っている。
     *
     * **「鳴らないこと」のほうを歯にしてある**（`memory.test.ts` の
     * 「節の切り取りは frontmatter の解釈を変えない」）——検査が鳴る入力が
     * 無いことを性質として測る形で、分岐のテストではない。**変異試験では
     * この枝は生存する。それは「歯が無い」ではなく「到達しない」である。**
     */
    tool(
      'memory_section_move',
      [
        'memory_outline が出した節id で指した節を、別の文書の末尾へ移す（切り取って足す）。移し先が無ければ作る。',
        '本文はこの呼び出しにも応答にも一度も現れない（0文字）——これがこの道具の存在理由である。大きな文書を割るのに本文を作り直さなくてよい。',
        '節の範囲は見出し行から「同じ深さ以下の次の見出しの直前」までで、入れ子の子は一緒に動く。frontmatter は節ではないので指せない。',
        '先に移し先へ足し、後から出どころを消す——途中で落ちれば同じ節が両方に残る（重複するが、失われない）。そのときはそう返る。',
        '断るのは5つ: from と to が同じ／その id の節が無い／その id は古い（中身が書き換えられた。memory_outline を取り直すこと）／中身まで同じ節が複数あって id が曖昧（どちらかを選ばずに断る）／frontmatter が壊れている。',
        '**統合の走行（distill）からは、人間が一度でも書いた文書・履歴の無い文書からは節を移せない**',
        '（断られる。ask_human で人間に確認を通せば次のターンで実行できる）。会話の中の移動は通る。移し先には歯が掛からない（追記なので）。',
      ].join(' '),
      {
        fromSlug: z.string().describe('節を切り取る側の文書のスラッグ'),
        section: z.string().describe('memory_outline が出した節id（`[...]` の中身）'),
        toSlug: z.string().describe('節を足す側の文書のスラッグ（無ければ作る）'),
        summary: z.string().describe('なぜ移したかの一行要約（日誌に残る。本文は残らない）'),
      },
      async ({ fromSlug, section, toSlug, summary }) => {
        if (fromSlug === toSlug) {
          return text(
            `from と to が同じ文書（${fromSlug}）である。節の移動先は別の文書でなければならない` +
              '（同じ文書の中で節を動かす口はここには無い）。何も変わっていない。',
          );
        }

        const existing = await stores.persona.read(fromSlug);
        if (existing === null) {
          return text(`記憶 ${fromSlug} は存在しない（節を移せない。何も変わっていない）。`);
        }

        const cause = memoryCause();
        const denial = await guardFullReplace(stores, fromSlug, cause, '節の移動');
        if (denial !== null) return text(denial);

        const priorFrontmatter = parseMemoryFrontmatter(existing.content);
        if (priorFrontmatter.kind === 'malformed') {
          return text(
            `記憶 ${fromSlug} の frontmatter が壊れている（malformed）。ここでは節を移さない——` +
              '本文の始まる位置が決まらないので、frontmatter を本文として運ぶ経路ができる。' +
              'memory_write で全文を書き直すか、人間に確認を通すこと（何も変わっていない）。',
          );
        }

        const scan = scanMemorySections(existing.content);
        const lookup = lookupMemorySection(scan.sections, section);
        if (lookup.kind !== 'found') {
          return text(describeMemorySectionLookupFailure(fromSlug, section, lookup));
        }
        const target = lookup.section;
        const { nextContent, cut } = cutMemorySection(existing.content, target);

        // **第3層。** 1層目（指す値が存在しない）と2層目（継ぎ足し）を
        // すり抜ける形が1つある——「本文だったものが frontmatter に化ける」。
        // 上の doc を読むこと。**外れたら何も書かない。**
        const priorHeader = existing.content.slice(0, scan.bodyStart);
        const nextHeader = nextContent.slice(0, scan.bodyStart);
        const nextFrontmatter = parseMemoryFrontmatter(nextContent);
        if (nextHeader !== priorHeader || nextFrontmatter.kind !== priorFrontmatter.kind) {
          return text(
            `記憶 ${fromSlug} からこの節を切り取ると、frontmatter の解釈が変わってしまう` +
              `（${priorFrontmatter.kind} → ${nextFrontmatter.kind}）。断った——この道具は` +
              'frontmatter を1バイトも動かさないと約束しているので、約束が破れる切り取りは行わない。' +
              '何も変わっていない（出どころも移し先も、1文字も動いていない）。',
          );
        }

        // **先に足して、後で消す。** 上の doc「順序」を読むこと。
        // `memoryBefore` はここで取る——両方の書き込みより前の、記憶全体の
        // スナップショットである（「毎ターンの床」の遷移を測る材料）。
        const [toBefore, memoryBefore] = await Promise.all([
          stores.persona.read(toSlug),
          stores.persona.documents(),
        ]);
        const toWritten = await stores.persona.append(toSlug, cut);
        await stores.journal.append({
          type: 'memory_update',
          slug: toSlug,
          cause,
          action: 'move_in',
          bytesBefore: toBefore === null ? 0 : Buffer.byteLength(toBefore.content, 'utf8'),
          bytesAfter: Buffer.byteLength(toWritten.content, 'utf8'),
          summary,
        });

        let fromWritten;
        try {
          fromWritten = await stores.persona.write(fromSlug, nextContent);
        } catch (error) {
          // **ここで嘘をつかない。** 「移した」と返すと、呼び手は重複に
          // 気づけない。落ちたのは2手目なので、1手目（移し先への追記）は
          // 済んでいる＝**同じ節が両方に在る。何も失われていない。**
          return text(
            `⚠ 節「${target.heading}」を ${toSlug} の末尾へ足すところまでは済んだが、` +
              `${fromSlug} からの切り取りに失敗した（${error instanceof Error ? error.message : String(error)}）。` +
              `いま同じ節が ${fromSlug} と ${toSlug} の両方に在る——**重複しているが、失われてはいない。**` +
              `${fromSlug} 側は1文字も変わっていない。memory_outline で ${fromSlug} を読み直し、` +
              '同じ操作をやり直すか、重複したままにするかを決めること。',
          );
        }
        await stores.journal.append({
          type: 'memory_update',
          slug: fromSlug,
          cause,
          action: 'move_out',
          bytesBefore: Buffer.byteLength(existing.content, 'utf8'),
          bytesAfter: Buffer.byteLength(fromWritten.content, 'utf8'),
          summary,
        });

        // 両方の書き込みが終わった後の、記憶全体のスナップショット。
        const memoryAfter = await stores.persona.documents();
        // **床は「移した先」（`toSlug`）の視点で言う。** 移動で新しく生まれる
        // か太るのは移し先であり、`toSlug` が frontmatter を持たない新規文書
        // なら premise として全文が焼かれる——`memory_write` で新規に premise
        // を作ったときと同じ枝を通す（依頼の重心。新規作成は稀なので声を
        // いちばん大きくする）。
        const floor = memoryFloorNote(
          memoryBefore,
          memoryAfter,
          toSlug,
          toWritten.content,
          toBefore === null,
        );
        // **移動元・移動先の両方をまとめて渡す。** `memory_section_move` は
        // 次のターンに `#withFreshMemory` がこの2文書をまとめて載せ直す
        // （`describeMemoryReinjectionEstimate` の doc「合計を選んだ理由」）。
        const reinjection = describeMemoryReinjectionEstimate(
          [toWritten, fromWritten],
          memoryAfter,
        );
        const growth = memorySessionGrowthNote(memoryAfter, context.runtime?.());

        // **古い本文を1文字も出さない。** 出せば文脈に入る（この道具の
        // 存在理由が消える）。名指しするのは見出しと節id だけ——呼び手が
        // 「意図した節か」を確かめるのに要る最小限である。
        return text(
          [
            `記憶 ${fromSlug} の節「${target.heading}」（節id ${target.id}、${target.chars.toLocaleString('en-US')} 文字）を ${toSlug} の末尾へ移した。`,
            '',
            `移した先 ${toSlug}:`,
            describeMemoryWriteDiff(toBefore === null ? null : toBefore.content, toWritten.content),
            '',
            `出どころ ${fromSlug}:`,
            describeMemoryWriteDiff(existing.content, fromWritten.content),
            '',
            floor,
            '',
            reinjection,
            '',
            growth,
          ].join('\n'),
        );
      },
    ),

    // --- 日誌 -----------------------------------------------------------
    tool(
      'journal_write',
      [
        '判断を日誌に残す（追記専用）。',
        '人間に聞かずに実行した判断は必ずここに残すこと。',
        '人間が後から読んで否定できることが、最終承認の実体である。',
      ].join(' '),
      {
        decision: z.string().describe('何を判断し、何をしたか'),
        grounds: z.string().describe('記憶のどこに根拠があったか。無いなら「根拠なし」と書く'),
      },
      async ({ decision, grounds }) => {
        const entry = await stores.journal.append({ type: 'decision', decision, grounds });
        return text(`日誌に記録した（${entry.id}）。`);
      },
    ),

    /**
     * 日誌を掘る道具。
     *
     * **これは「探す」ための口である。** 全文を素で並べていたときは、200 件を
     * 頼むと 178,524 文字になって MCP の出力上限で丸ごと落ち、クローンには
     * 1 文字も届かなかった（SDK はファイルへ落とすが、クローンにファイルを
     * 読む道具は無い）。人間は Web UI と `GET /journal` で日誌を読めるので、
     * これは能力の削除そのものである（north_star 禁止1）。
     *
     * 直し方は `manager_list` ↔ `manager_report` と同じ形にした。
     * 一覧は**予算を先に決めて入るところまで**積み、本文は抜粋にして
     * *いつ・誰が・どの型か*と `id` を必ず残す。全文が要る1件は `id` で取る。
     *
     * **`until` が無いと過去は掘れない。** 返るのは新しい順なので、`since` だけ
     * では手前の最新分が `limit` を食い尽くし、狙った時刻には決して届かない。
     */
    tool(
      'journal_read',
      [
        '日誌を新しい順に読む。過去の一点を掘るには since/until で窓を閉じること',
        '（新しい順に返るので、until を指定しないと最新分しか見えない）。',
        '一覧の本文は抜粋で、全文が要る1件は id を渡して取る。',
        'q で本文を語で探せる（他の絞りと併用できる）。',
        '**q が当たらないことは「日誌にその語が無い」を意味しない** —',
        'tool_use の input・worker_wait・turn_usage は探す対象に入っていない。',
        'with で exchange の相手を絞れる（他の絞りと併用できる）。',
        '**with を指定すると exchange 以外の種別は1件も返らない** —',
        'types で別途除く必要はない。',
      ].join(' '),
      {
        limit: z.number().int().min(1).max(200).optional().describe('件数（既定 20）'),
        since: z
          .string()
          .optional()
          .describe('ISO 8601。この時刻以降だけ返す（例 2026-08-15T09:00:00Z）'),
        until: z
          .string()
          .optional()
          .describe('ISO 8601。この時刻以前だけ返す。過去を掘るときはこれを指定する'),
        types: z
          .array(z.enum(JOURNAL_ENTRY_TYPES))
          .optional()
          .describe('種別で絞る。省略すると全種別'),
        // **説明文は `conversation_read` の `q` と1文字も変えない。**
        // 同じ語で探す口が2つ在るのに言い方が違うと、読む側は違う意味論を
        // 疑うことになる（`journal-search.ts` の doc）。
        q: z
          .string()
          .optional()
          .describe('語で探す（大文字小文字を区別しない部分一致）。他の絞りと併用できる'),
        // **`with` は JS の予約語なので、ハンドラの側では `withFilter` へ
        // 詰め替える（キー名そのものは `JournalQuery.with` に合わせて `with`
        // のまま——新しい呼び方を作らない）。**
        with: z
          .array(z.enum(EXCHANGE_WITH_VALUES))
          .optional()
          .describe('exchange の相手（human/manager/self）で絞る。省略すると絞らない'),
        id: z
          .string()
          .optional()
          .describe('この1件を全文で読む（一覧に出ている id）。他の条件は無視される'),
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('id で全文を読むとき、何文字目から読むか'),
      },
      async ({ limit, since, until, types, q, with: withFilter, id, offset = 0 }) => {
        // --- 全文モード（1件だけ） ---
        if (id !== undefined) {
          const entry = await stores.journal.get(id);
          if (!entry) return text(`日誌 ${id} は無い（id が違うか、まだ書かれていない）。`);
          const { head, body } = renderJournalEntry(entry);
          if (body === '') return text(`${entry.at} ${head}`);
          const part = page(body, offset, JOURNAL_PAGE);
          const tail = part.more
            ? `\n\n…（ここで切れている。続きは journal_read id=${entry.id} offset=${part.to}）`
            : '';
          return text(`${entry.at} ${head}（${describePage(part)}）\n\n${part.body}${tail}`);
        }

        // --- 一覧モード ---
        const requested = limit ?? 20;
        const entries = await stores.journal.list({
          limit: requested,
          ...(since === undefined ? {} : { since }),
          ...(until === undefined ? {} : { until }),
          // **`[]`（空配列）もそのまま転送する。** `types: []` は
          // `store.ts` の `JournalQuery.types` の doc で「0件」に決まっている
          // 契約である（#425）。`length === 0` を `{}` へ落とすと、その契約を
          // **道具の層で覆して「絞らない」に化けさせる。**
          //
          // ⚠️ **そして化けたことは、契約の歯からは見えない。**
          // `verifyJournalStoreQueryEdgeContract` は3実装に「`types: []` = 0件」を
          // 当てているが、ここで `{}` へ落とすと**値がストアへ届かない**ので、
          // その歯は緑のまま素通りする（issue #426）。
          ...(types === undefined ? {} : { types }),
          ...(q === undefined ? {} : { q }),
          // **`[]`（空配列）もそのまま転送する。** 理由はすぐ上の `types` と
          // 同じで、`with: []` も `store.ts` の doc で「0件」に決まっている
          // （#418）。**この2つは同じ渡し方である**——かつて `types` だけが
          // `length === 0` を `{}` へ落としており、同じ道具の隣り合う2行で
          // 同じ表記が違う意味を持っていた（issue #426 で揃えた）。
          ...(withFilter === undefined ? {} : { with: withFilter }),
        });
        if (entries.length === 0) {
          // **`q` で0件だったとき、探す対象に入っていない欄が在ることまで言う。**
          // 黙ると「日誌にその語は無い」と読めるが、実際には tool_use の input に
          // 書かれているかもしれない（`journal-search.ts`「対象にしていない欄」）。
          // **判定できないという第3の状態を「無かった」へ潰さない**
          // （AGENTS.md「静かに失敗する道具」。`conversation_read` が窓を遡り
          // 切れていないときに「この窓には無い（判定できない）」と言うのと同じ形で、
          // こちらの取りこぼしの出所は窓ではなく欄である）。
          if (q !== undefined) {
            return text(
              `"${q}" に当たる日誌は無い（この条件の中では）。` +
                'ただし tool_use の input・worker_wait・turn_usage は探す対象に入っていないので、' +
                'そこにだけ書かれている語はここでは当たらない。',
            );
          }
          return text(
            since === undefined &&
              until === undefined &&
              types === undefined &&
              withFilter === undefined
              ? '（日誌はまだ空）'
              : '（その条件に当たる日誌は無い）',
          );
        }

        // **予算を先に決めて、入るところまで積む。** 件数から出力量を決めると、
        // 何件で壊れるかが運任せになる（それで丸ごと落ちた）。切ったなら必ずそう言う。
        // 積む形そのものは `renderListing` が持つ（一覧ごとに手で書かない）。
        const items = entries.map((entry) => {
          const { head, body } = renderJournalEntry(entry);
          return (
            `${entry.at} ${head} id=${entry.id}` +
            (body === '' ? '' : `\n  ${excerptLine(body, JOURNAL_TEXT_EXCERPT)}`)
          );
        });
        return text(
          [
            renderListing(items, {
              budget: JOURNAL_BUDGET,
              omitted: ({ rest, shown, total }) =>
                `…ほか ${rest} 件は省略（この条件で ${total} 件あり、新しい順に ${shown} 件だけ出した）。` +
                'さらに遡るなら until を、狭めるなら since / types / with / q を指定すること。',
            }),
            '（本文は抜粋。全文は journal_read id=<id> で取れる）',
          ].join('\n'),
        );
      },
    ),

    // --- 人間への確認 ----------------------------------------------------
    tool(
      'ask_human',
      [
        '人間に確認する。記憶に根拠が無いことだけをここへ回す。',
        'これは承認待ちキューに積むだけで、人間の応答を待たない。',
        '止まるのはこの件だけであり、他の仕事は進めてよい。',
        '回答は後から受信箱に届く。',
      ].join(' '),
      {
        question: z.string().describe('人間への質問。何を判断してほしいかを具体的に'),
        context: z.string().optional().describe('判断に必要な背景'),
        managerId: z
          .string()
          .optional()
          .describe('マネージャーからの確認を人間に回す場合、その manager_id'),
        // **生ログの id を渡しても通らない（#572）。** ここが受け取るのは runner が
        // `#onPermission` で SDK から受け取った control_request の `request_id` で、
        // 生ログ（CLI の transcript）に出る `toolu_…`（`tool_use_id`）とも
        // `req_…`（API の request id）とも**名前空間が違う**。実測では、生ログに
        // control_request の `request_id` は1件も現れない ⟹ **受信箱に届かなかった
        // 確認へ、生ログを読んで答える手段は無い。** 別物だと書いていなかったので、
        // 読み手はまず生ログの id を試し、「待っていない」で弾かれていた。
        requestId: z
          .string()
          .optional()
          .describe(
            'マネージャーからの確認を人間に回す場合、受信箱に届いた requestId。' +
              '人間の回答をこの確認へ返すために必要なので、managerId と必ず対で渡すこと。' +
              '⚠️ 生ログの id とは別物である——生ログに出る toolu_…（tool_use_id）も ' +
              'req_…（API の request id）も、ここでは通らない。' +
              '受信箱に届いていない確認に、生ログから答える手段は無い（#572）',
          ),
      },
      async ({ question, context: background, managerId, requestId }) => {
        const approval: PendingApproval = {
          id: randomUUID(),
          createdAt: new Date().toISOString(),
          question,
          ...(background === undefined ? {} : { context: background }),
          ...(managerId === undefined ? {} : { jobId: managerId }),
          ...(requestId === undefined ? {} : { requestId }),
        };
        await stores.jobs.putApproval(approval);
        await stores.journal.append({
          type: 'escalation',
          question,
          approvalId: approval.id,
        });
        context.emit({ type: 'ask_human', approvalId: approval.id, question });
        return text(`承認待ちキューに積んだ（${approval.id}）。回答は後から届く。`);
      },
    ),

    tool(
      'approvals_list',
      [
        'いま人間の回答を待っている件の一覧。',
        '人間が席に居ないあいだに溜まる。溜まっていても他の仕事は進めてよい。',
        '一覧の質問は抜粋で、全文が要る1件は id を渡して取る。',
      ].join(' '),
      {
        id: z
          .string()
          .optional()
          .describe('この1件を全文で読む（一覧に出ている id）。他の条件は無視される'),
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('id で全文を読むとき、何文字目から読むか'),
      },
      async ({ id, offset = 0 }) => {
        // --- 全文モード（1件だけ） ---
        if (id !== undefined) {
          const approval = await stores.jobs.getApproval(id);
          if (!approval) return text(`承認待ち ${id} は無い（id が違う）。`);
          // **答えが付いた件も読める。** 「もう答えが来た」ことと「その質問が
          // 何だったか」は別の問いで、後者は答えが付いた後にこそ要る。
          const head =
            `${approval.id}（${approval.createdAt}）` +
            (approval.answeredAt === undefined ? '回答待ち' : `${approval.answeredAt} に回答済み`) +
            (approval.jobId === undefined
              ? ''
              : ` / 宛先 managerId: "${approval.jobId}"` +
                (approval.requestId === undefined ? '' : `, requestId: "${approval.requestId}"`));
          const body = [
            `質問: ${approval.question}`,
            ...(approval.context === undefined ? [] : [`背景: ${approval.context}`]),
            ...(approval.answer === undefined ? [] : [`回答: ${approval.answer}`]),
          ].join('\n\n');
          const part = page(body, offset, APPROVAL_PAGE);
          const tail = part.more
            ? `\n\n…（ここで切れている。続きは approvals_list id=${approval.id} offset=${part.to}）`
            : '';
          return text(`${head}（${describePage(part)}）\n\n${part.body}${tail}`);
        }

        // --- 一覧モード ---
        const pending = await stores.jobs.listApprovals({ pendingOnly: true });
        if (pending.length === 0) return text('（人間の回答待ちは無い）');
        const items = pending.map((approval) =>
          renderListingEntry({
            id: approval.id,
            title: approvalTitle(approval.question),
            // **この一覧は回答待ちだけを出すので `answeredAt` は常に無く、更新は
            // 作成と一致する。** それは軸が無いのではなく「まだ一度も変わって
            // いない」という観測そのものなので、値を作らずに `createdAt` を出す
            // （下の断り書きの行で、読み手にもそう読める形にしてある）。
            // なぜ `??` の左枝がここから到達しないか、それでも消してはいけない
            // 理由は `approvalUpdatedAt`（`schema.ts`）の doc を見ること。
            createdAt: approval.createdAt,
            updatedAt: approvalUpdatedAt(approval),
            summary: excerptLine(approval.question, APPROVAL_QUESTION_EXCERPT),
            extra: [
              approval.jobId === undefined
                ? null
                : `  宛先: managerId: "${approval.jobId}"` +
                  (approval.requestId === undefined ? '' : `, requestId: "${approval.requestId}"`),
            ],
          }),
        );
        return text(
          [
            renderListing(items, {
              budget: APPROVAL_LIST_BUDGET,
              omitted: ({ rest, shown, total }) =>
                `…ほか ${rest} 件は省略（回答待ちは ${total} 件あり、古い順に ${shown} 件だけ出した）。`,
            }),
            '（質問は抜粋。全文は approvals_list id=<id> で取れる）',
            '（更新＝この1件が最後に変わった時刻。回答待ちだけを出す一覧なので、常に作成と同じになる）',
          ].join('\n'),
        );
      },
    ),

    // --- 日報 --------------------------------------------------------------
    tool(
      'daily_report_write',
      [
        'その日の日報を残す。人間が普段読むのはこれだけである。',
        '今日何をしたか・何が決まったか・何が保留か、が読んだだけで分かるように書くこと。',
      ].join(' '),
      {
        date: z
          .string()
          .optional()
          .describe('対象日 YYYY-MM-DD（省略時は今日。締めの指示に書かれた日付を使うこと）'),
        body: z.string().describe('日報の本文（Markdown）'),
      },
      async ({ date, body }) => {
        // 存在しない日付（2026-02-31 など）で残すと、その日報は二度と読めない。
        // 形の検査だけでは通ってしまうので localDayRange に確かめさせる。
        const target =
          date !== undefined && localDayRange(date) !== null ? date : localDate(new Date());
        await stores.journal.append({ type: 'daily_report', date: target, body });
        return text(`${target} の日報を残した。`);
      },
    ),

    // --- 利用状況（いくら使ったか） --------------------------------------------
    /**
     * **人間が見られるものは、クローンからも見られること。**
     *
     * 人間は `claude.ai/settings/usage` と Web UI で消費を見られる。その写像である
     * クローンが見られないなら、それは能力の削除である（north_star 禁止1）。
     *
     * これは飾りではなく**判断の材料**である。委譲を続けてよいか、重い仕事を
     * いま投げてよいかは、残りが見えなければ勘で決めるしかない。実際に支出上限へ
     * 当たって走行中のマネージャーが2本同時に落ちたとき、クローンには事前に
     * 知る手段が無く、マネージャーの返答から推測するしかなかった。
     */
    tool(
      'usage_read',
      [
        'alteroid が使った分（トークンと費用）を台帳から読む。',
        '軸は6つ — 日・マネージャー（誰の分か）・モデル・layer（誰が: clone / manager）・site（どこで: session / distill）・token（どの認証トークンで）。',
        'token の軸に「（トークンの帰属が無い分）」が出るのは、プールを使っていない構成では正常である（0 でも既定値でもなく、取れていない）。',
        '**推定値であり請求明細ではない。**',
        '記録は台帳を置いた日から始まっているので、それより前は 0 ではなく「記録が無い」と出る。',
        'まとめ表示は軸ごとに打ち切る。続きは axis と offset で辿れる（打ち切りの行にそのまま書いてある）。',
      ].join(' '),
      {
        from: z.string().optional().describe('この日から（YYYY-MM-DD）。省略すると台帳の全期間'),
        to: z.string().optional().describe('この日まで（YYYY-MM-DD）'),
        managerId: z
          .string()
          .optional()
          .describe('この actor の分だけ（マネージャーの id か "clone"）'),
        layer: usageLayerSchema.optional().describe('誰が使った分だけ（clone / manager）'),
        site: usageSiteSchema.optional().describe('どこで使った分だけ（session / distill）'),
        tokenId: z
          .string()
          .min(1)
          .optional()
          .describe('この認証トークンで使った分だけ（token_list の id）'),
        axis: z
          .enum(USAGE_AXES)
          .optional()
          .describe(
            'この軸だけを offset から出す（まとめ表示・他の軸・アカウント全体の残りは出ない）',
          ),
        offset: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe('axis と一緒に使う。その軸の何件目から出すか'),
      },
      async ({ from, to, managerId, layer, site, tokenId, axis, offset }) => {
        const aggregate = await stores.usage.aggregate({
          ...(from === undefined ? {} : { from }),
          ...(to === undefined ? {} : { to }),
          ...(managerId === undefined ? {} : { managerId }),
          ...(layer === undefined ? {} : { layer }),
          ...(site === undefined ? {} : { site }),
          ...(tokenId === undefined ? {} : { tokenId }),
        });
        // **軸モードでは「続きの1軸」だけを返す。** アカウント全体の残りもまとめ表示も
        // 付けない — 続きを辿るほど同じ全体が積み増しで返ってくるのを避けるためである。
        if (axis !== undefined) {
          return text(
            renderUsage(aggregate, { axis, ...(offset === undefined ? {} : { offset }) }),
          );
        }
        const unrecordedManagers = await unrecordedManagersLines(context, stores, aggregate.since);
        return text(
          [
            renderAccountUsage(context.accountUsage?.() ?? { state: 'unknown' }),
            '',
            '## alteroid が使った分（台帳）',
            renderUsage(aggregate, { unrecordedManagers }),
          ].join('\n'),
        );
      },
    ),

    // --- 継続中の依頼（時間起点の仕込み） --------------------------------------
    tool(
      'schedule_list',
      [
        '仕込んである継続中の依頼の一覧。周期と、前回それで動いた時刻・次に動く時刻が分かる。',
        '既定の日報・発意 tick はここには出ない（あれは設定で回っているもの）。',
        '一覧の依頼本文は抜粋で、全文が要る1件は kind を渡して取る。',
      ].join(' '),
      {
        kind: z
          .string()
          .optional()
          .describe('この1件の依頼本文を全文で読む（一覧に出ている kind）'),
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('kind で全文を読むとき、何文字目から読むか'),
      },
      async ({ kind, offset = 0 }) => {
        // --- 全文モード（1件だけ） ---
        if (kind !== undefined) {
          const plan = await stores.schedules.get(kind);
          if (!plan) return text(`継続中の依頼 ${kind} は無い（kind が違うか、もう外してある）。`);
          const head =
            `${plan.kind}（${describeScheduleSpec(plan.spec)}）` +
            ` 前回動いた時刻: ${plan.lastRunAt ?? '（まだ一度も動いていない）'}` +
            ` 次に動く時刻: ${scheduleNextAtOf(context, plan.kind)}`;
          const part = page(plan.request, offset, SCHEDULE_PAGE);
          const tail = part.more
            ? `\n\n…（ここで切れている。続きは schedule_list kind=${plan.kind} offset=${part.to}）`
            : '';
          return text(`${head}（依頼本文: ${describePage(part)}）\n\n${part.body}${tail}`);
        }

        // --- 一覧モード ---
        const plans = await stores.schedules.list();
        if (plans.length === 0) return text('（継続中の依頼は無い）');
        const items = plans.map((plan) =>
          renderListingEntry({
            // **この一覧の id は `kind` である。** 継続中の依頼は kind ごとに
            // 高々1本なので、kind がそのまま鍵になる（`schedule_list kind=<kind>`
            // で全文が取れる）。
            id: plan.kind,
            title: describeScheduleSpec(plan.spec),
            createdAt: plan.createdAt,
            updatedAt: plan.updatedAt,
            summary: `依頼: ${excerptLine(plan.request, SCHEDULE_REQUEST_EXCERPT)}`,
            extra: [
              `  前回動いた時刻: ${plan.lastRunAt ?? '（まだ一度も動いていない）'}`,
              `  次に動く時刻: ${scheduleNextAtOf(context, plan.kind)}`,
            ],
          }),
        );
        return text(
          [
            renderListing(items, {
              budget: SCHEDULE_LIST_BUDGET,
              omitted: ({ rest, shown, total }) =>
                `…ほか ${rest} 件は省略（継続中の依頼は ${total} 件あり、${shown} 件だけ出した）。`,
            }),
            '（依頼本文は抜粋。全文は schedule_list kind=<kind> で取れる）',
          ].join('\n'),
        );
      },
    ),

    tool(
      'schedule_create',
      [
        'その場で終わらない依頼を、時間起点として仕込む。',
        '時刻が来れば必ずあなたの受信箱へ届き、そのとき依頼の本文と前回動いた時刻が一緒に渡る。',
        '記憶に書くのは判断の根拠であって、記憶は時計を持たない。継続する依頼はここにも置くこと。',
        '同じ kind で呼べば置き換わる（周期や本文の直しはこれで行う）。',
      ].join(' '),
      {
        kind: z
          .string()
          .describe('この依頼の名前（英小文字・数字・. _ -）。後から直す・消すときの識別子'),
        request: z
          .string()
          .describe(
            '依頼の本文。時刻が来たときのあなたが読んで、そのまま動ける粒度で書く' +
              '（対象・狙い・どこまでやるか。人間から頼まれた言葉そのものも残すとよい）',
          ),
        dailyAt: z
          .string()
          .optional()
          .describe('毎日この時刻に起こす（ローカル時刻の HH:MM）。周期はどれか1つだけ渡す'),
        everyMinutes: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe('この分数ごとに起こす。周期はどれか1つだけ渡す'),
        cron: z
          .string()
          .optional()
          .describe(
            'cron 式で起こす（ローカル時刻。例: 毎週月曜 10:00 なら `0 10 * * 1`）。' +
              '曜日や月の指定が要るときはこれを使う。周期はどれか1つだけ渡す',
          ),
      },
      async ({ kind, request, dailyAt, everyMinutes, cron }) => {
        const parsedKind = scheduleKindSchema.safeParse(kind);
        if (!parsedKind.success) {
          return text(`kind "${kind}" は使えない（英小文字・数字・. _ - のみ、64文字まで）。`);
        }
        if (RESERVED_SCHEDULE_KINDS.includes(parsedKind.data)) {
          // 名前が使えないことだけ言って黙らない。既定の刻みを変えたいなら手段は
          // 別にあり（デーモンの設定）、それを人間に頼めることまで伝える。
          return text(
            `${parsedKind.data} は既定の定期ジョブの名前なので使えない（別の名前を付けること）。` +
              '日報の締め時刻や発意 tick の間隔そのものを変えたいなら、それはデーモンの設定' +
              '（`ALTEROID_DAILY_REPORT_AT` / `ALTEROID_INITIATIVE_EVERY`）なので人間に頼むこと。',
          );
        }
        const given = [dailyAt, everyMinutes, cron].filter((value) => value !== undefined);
        if (given.length !== 1) {
          return text('dailyAt / everyMinutes / cron のうち、どれか1つだけ渡すこと。');
        }
        if (dailyAt !== undefined && parseTimeOfDay(dailyAt) === null) {
          return text(`dailyAt "${dailyAt}" は HH:MM として読めない。`);
        }
        if (cron !== undefined && !isCronExpression(cron)) {
          return text(
            `cron "${cron}" は cron 式として読めない（例: 毎週月曜 10:00 なら \`0 10 * * 1\`）。`,
          );
        }

        const spec: ScheduleSpec =
          dailyAt !== undefined
            ? { type: 'daily', at: dailyAt }
            : cron !== undefined
              ? { type: 'cron', expression: cron }
              : { type: 'every', minutes: everyMinutes ?? 60 };
        const parsedSpec = scheduleSpecSchema.safeParse(spec);
        if (!parsedSpec.success) return text(`周期を読めなかった: ${parsedSpec.error.message}`);

        const now = new Date().toISOString();
        const existing = await stores.schedules.get(parsedKind.data);
        const plan: ScheduledRequest = {
          kind: parsedKind.data,
          spec: parsedSpec.data,
          request,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
          // **これまでの記録を引き継ぐ。** 落とすと、直した瞬間に定期の基準が消えて
          // 位相が createdAt から引き直され（＝直後に1回余分に起きる）、引き受けたまま
          // 終わっていない発火の印も消える（＝その回が失われる）。
          ...(existing?.lastRunAt === undefined ? {} : { lastRunAt: existing.lastRunAt }),
          ...(existing?.lastScheduledRunAt === undefined
            ? {}
            : { lastScheduledRunAt: existing.lastScheduledRunAt }),
          ...(existing?.pendingRun === undefined ? {} : { pendingRun: existing.pendingRun }),
        };
        await stores.schedules.put(plan);
        await stores.journal.append({
          type: 'decision',
          decision:
            `${existing ? '定期の依頼を直した' : '定期の依頼を仕込んだ'}: ` +
            `${plan.kind}（${describeScheduleSpec(plan.spec)}）: ${request}`,
          grounds: '継続する依頼を時間起点として持つ判断',
        });
        return text(
          `${plan.kind} を ${describeScheduleSpec(plan.spec)} で仕込んだ。時刻が来たら依頼の本文とともに届く。`,
        );
      },
    ),

    tool(
      'schedule_remove',
      '継続中の依頼を片付ける。済んだ依頼・もう要らない依頼はここで外す。',
      { kind: z.string().describe('schedule_list に出ている kind') },
      async ({ kind }) => {
        const existing = await stores.schedules.get(kind);
        if (!existing) return text(`継続中の依頼 ${kind} は無い。`);
        await stores.schedules.remove(kind);
        await stores.journal.append({
          type: 'decision',
          decision: `定期の依頼を外した: ${kind}: ${existing.request}`,
          grounds: 'この依頼はもう要らないという判断',
        });
        return text(`${kind} を外した。`);
      },
    ),

    // --- 引き受けたまま終わっていない仕事（未了の台帳） ------------------------
    //
    // **これは「やることの一覧」ではない。** 器が持つのは「何を頼まれたか」と
    // 「まだ片付いていない」の2値だけで、順序も優先度も締切も持たない（PRD「自律」）。
    // 何を先にやるか、そもそもやるかは毎回クローンが記憶に照らして決める。器がするのは
    // **忘れさせないこと**だけである。
    tool(
      'commitment_list',
      [
        '引き受けたまま終わっていない仕事の一覧。古い順に出る。',
        '人間の依頼・マネージャーからの一件・外部イベントは、届いた時点で自動的にここへ載る。',
        '**載っているものは、あなたが閉じるまで消えない。**',
        'どれを先にやるかの順序はここには無い。記憶にある目的と価値観に照らして毎回決め直すこと。',
        '1件の全文（依頼本文と、片付けたならその理由）が要るなら id を渡す。片付いた件も id で読める。',
        'origin で出所を絞れる（他の絞りと併用できる）。',
      ].join(' '),
      {
        id: z
          .string()
          .optional()
          .describe(
            'この1件を全文で読む（一覧に出ている id）。片付いた件も読める。他の条件は無視される',
          ),
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('id で全文を読むとき、何文字目から読むか'),
        includeClosed: z
          .boolean()
          .optional()
          .describe('片付けたものも見る（既定は未了だけ）。何を片付けたかを振り返るとき用'),
        origin: z
          .array(z.enum(commitmentOriginSchema.options))
          .optional()
          .describe('出所（human/manager/external/self）で絞る。省略すると絞らない'),
      },
      async ({ id, offset = 0, includeClosed, origin }) => {
        // --- 全文モード（1件だけ） ---
        if (id !== undefined) {
          // **片付いた件も読める。`includeClosed` は要求しない。** id で名指し
          // している以上、その1件を見たいことは明らかである。そして読みたいのは
          // **むしろ片付いた側**である——`closedReason` は `schema.ts` が逐語で
          // 「『閉じた』だけを残さない。人間が後から否定できることが最終承認の
          // 実体であり、何をもって終わりとしたのかが無いと否定のしようがない」と
          // 書いている欄で、**一覧では120字の抜粋で止まる。** 全文へ降りる口が
          // 無ければ、その設計は抜粋の分しか生きていない（#218）。
          //
          // **`get(id)` は読めない行で throw する（`CommitmentStore.get` の
          // 契約。issue #296）。** ここで投げっぱなしにすると、クローンから
          // 見て「道具が壊れた」としか映らず、「無い」「読めない」「読める」の
          // 3値が握り潰される——直上の doc がまさに防ごうとしている取り違えが
          // ここで起きる。**`UnreadableCommitmentError` だけを捕まえて3値目
          // として返し、それ以外（DB 接続断・ファイル読み取り不能などの器
          // そのものの障害）は捕まえずに上へ通す** — 後者まで飲み込むと、
          // 器の異常が「台帳が壊れている」に化けて見えなくなる
          // （`UnreadableCommitmentError` の doc、`packages/core/src/store.ts`）。
          let entry: Commitment | null;
          try {
            entry = await stores.commitments.get(id);
          } catch (error) {
            if (error instanceof UnreadableCommitmentError) {
              return text(
                `引き受けた仕事 ${id} は読めない形で入っている（片付いたのではない。` +
                  '無いのとは違う）。本文はここでは取れない。',
              );
            }
            throw error;
          }
          // **黙って空を返さない。** 「無い」と「読めない」を混ぜると、id の
          // 打ち間違いが「その仕事は存在しなかった」として片付く。
          if (!entry) return text(`引き受けた仕事 ${id} は無い（id が違う）。`);
          const head = [
            `${entry.id} ${commitmentOriginBadge(entry)}`,
            `作成: ${entry.at} / 更新: ${commitmentUpdatedAt(entry)}`,
            entry.closedAt === undefined ? '状態: 未了' : `状態: ${entry.closedAt} に片付けた`,
          ].join('\n');
          // **片付けた理由を本文より先に置く。** `body` は長くなりうるので、
          // 後ろに置くと `page()` の2ページ目へ落ちて、**いちばん要る1行が
          // 最初の呼びで出てこない。** 読み順としては逆だが、切れる側に
          // 落ちてよい欄ではない。
          const body = [
            ...(entry.closedAt === undefined
              ? []
              : [`片付けたとした理由: ${entry.closedReason ?? '（理由の記録なし）'}`]),
            `依頼（全文）: ${entry.body}`,
          ].join('\n\n');
          const part = page(body, offset, COMMITMENT_PAGE);
          const tail = part.more
            ? `\n\n…（ここで切れている。続きは commitment_list id=${entry.id} offset=${part.to}）`
            : '';
          return text(`${head}（${describePage(part)}）\n\n${part.body}${tail}`);
        }

        // --- 一覧モード ---
        // **`list()` は `{ entries, unreadable, trimmedClosed }` を返す
        // （issue #296 / #416）。** 読める行（`entries`）が0件でも、読めない行
        // （`unreadable`）だけは在りうるので、「無い」と返してよいのは3つとも
        // 0件のときだけである。**`trimmedClosed` を外すと `unreadable` と同じ
        // 形の穴が空く** — 開いている仕事も読めない行も無く、削除された片付き
        // 行の履歴だけが在る状態で「無い」と返すと、削除された事実がいちばん
        // 静かに握り潰される（issue #416）。
        const {
          entries: allEntries,
          unreadable,
          trimmedClosed,
        } = await stores.commitments.list(
          includeClosed === true ? { includeClosed: true } : undefined,
        );
        if (allEntries.length === 0 && unreadable.length === 0 && trimmedClosed === 0) {
          return text('（引き受けたまま終わっていない仕事は無い）');
        }
        // **`origin` は、`renderListing` が文字数の予算で切る前（ここ）で
        // 効かせる。** #418 の穴の本体は「絞りを予算／`limit` より後で掛けた
        // ため、絞りに当たらない行が窓を食い尽くした」ことである。ここでも
        // 同じ順序で塞ぐ——`items` を組む前、`entries` そのものを絞る。
        // **未指定 = 絞らない。** `[]`（空配列）は「どれにも当たらない」
        // という指定として扱う——`journal_read` の `with` / `types` と同じ
        // 契約（`store.ts` の `JournalQuery.with` の doc）に揃えた。
        const entries =
          origin === undefined
            ? allEntries
            : allEntries.filter((entry) => origin.includes(entry.origin));
        const items = entries.map((entry) =>
          renderListingEntry({
            id: entry.id,
            // 出所と `source` は先頭行の札が持つので、他の行では繰り返さない。
            title: commitmentOriginBadge(entry),
            // 作成＝受け取った時刻、更新＝片付けた時刻（まだなら受け取った時刻）。
            createdAt: entry.at,
            updatedAt: commitmentUpdatedAt(entry),
            summary: excerptLine(entry.body, COMMITMENT_BODY_LIMIT),
            extra: [
              entry.closedAt === undefined
                ? '  状態: 未了'
                : `  状態: ${entry.closedAt} に片付けた（${excerptLine(entry.closedReason ?? '', 120)}）`,
            ],
          }),
        );
        const lines = [
          entries.length === 0
            ? // **原因を分ける。** `allEntries` が既に0件なら（読める行そのものが
              // 無い＝残りは全部読めない行）従来どおり。`allEntries` は在るのに
              // `origin` で絞った結果0件になったのは別の理由なので、別の文にする
              // ——「読める行が無い」と読めると、台帳の破損（`unreadable`）を疑う
              // ことになるが、実際には絞り込みが厳しかっただけである。
              allEntries.length === 0
              ? '（読める行は無い）'
              : '（この origin の絞り込みに当たる行は無い）'
            : renderListing(items, {
                budget: COMMITMENT_LIST_BUDGET,
                // **続きの取り方を案内する（#218 で口ができた）。** かつてここには
                // 「この台帳には詳細へ降りる道具が無いので案内すると嘘になる」と
                // 書いてあった。`commitment_list id=<id>` を足したので、いまは
                // 案内できる。**案内する口が実在することは歯で固定してある**
                // （導線が空振りする形は、無い口を案内するのと同じだけ嘘である）。
                // **`includeClosed` のときは「未了は」と言わないこと。** `total` には
                // 片付いたものも含まれるので、そのまま「未了は N 件」と言うと片付いた
                // 分まで未了として数えた嘘になる（数が大きく出る方向の嘘）。
                // **`origin` を指定したときも同じ理由で断る。** `total` はここでは
                // 既に `entries`（`origin` で絞った後の母数）から来ているので値
                // そのものは正しいが、断りが無いと「絞る前の全体」だと読める——
                // それも数が大きく出る方向の同じ形の嘘になる。
                omitted: ({ rest, shown, total }) =>
                  `…ほか ${rest} 件は省略（${
                    origin === undefined ? '' : `origin: ${origin.join(', ')} に絞った、`
                  }${
                    includeClosed === true
                      ? `片付けた分を含めて ${total} 件あり`
                      : `未了は ${total} 件あり`
                  }、古い順に ${shown} 件だけ出した。落ちた分も含め、1件の全文は commitment_list id=<id> で取れる）。`,
              }),
        ];
        if (entries.length > 0) {
          lines.push(
            '（本文は240字の抜粋。1件の全文は commitment_list id=<id> で取れる。片付いた件も読める）',
            '（更新＝この1件が最後に変わった時刻。まだ片付けていなければ、受け取った時刻と同じ）',
          );
        }
        // **末尾に必ず断りを足す（issue #296）。** クローンがこれを読む場所
        // そのものなので、ここが落ちると Issue が守ろうとしたものが守れない。
        // 0件のときは何も足さない（`entries.length === 0 && unreadable.length
        // === 0` は上で早期リターン済みなので、ここに来る時点で
        // `unreadable.length > 0` の可能性だけを見ればよい）。
        if (unreadable.length > 0) {
          // **id が取れない行は件数だけに数える。** `id` を持たない行を
          // 一覧から書き漏らすのではなく、そもそも id という材料が無いので
          // 出しようがない、という区別である。
          const idsAll = unreadable
            .map((entry) => entry.id)
            .filter((id): id is string => id !== undefined);
          // **id の列挙にも上限を置く（#409）。** 台帳の破損の度合いに比例して
          // 伸びる列挙で、件数そのものには合図が無かった。`digest.ts` の
          // `buildActivityDigest` に在った同じ形の穴を塞いだのと同じ理由。
          const ids = idsAll.slice(0, UNREADABLE_COMMITMENT_IDS_SHOWN);
          const idsRest = idsAll.length - ids.length;
          lines.push(
            `**読めない行が ${unreadable.length} 件ある${
              ids.length > 0
                ? `（id: ${ids.join(', ')}${idsRest > 0 ? ` …ほか ${idsRest} 件は省略` : ''}）`
                : ''
            }。片付いたのではない。**`,
          );
        }
        // **保持上限を超えて物理削除された片付き行の累計も断る（issue #416）。**
        // `unreadable` と同じ理由——ここが落ちると、削除された事実がクローンに
        // 一切見えなくなる。**0件なら出さない**（常に出る断りは情報にならない。
        // `unreadable` の分岐と同じ判定）。
        if (trimmedClosed > 0) {
          lines.push(
            `**保持上限を超えて物理削除された片付き行が累計 ${trimmedClosed} 件ある。** ` +
              'この記憶ストアは片付いた行を新しい順に一定件数までしか残さない。' +
              '削除された分の内容はここでは二度と読めない（日誌側の記録が唯一の手掛かりになる）。',
          );
        }
        return text(lines.join('\n'));
      },
    ),

    tool(
      'commitment_open',
      [
        '自分で気づいたことを、引き受けた仕事として台帳に載せる。',
        '人間が「あ、これ直さないと」と思ったときにメモするのと同じもので、',
        'いま手を付けないなら**必ずここへ置くこと** — 会話の文脈はやがて要約に潰れ、',
        '記憶は時計を持たないので、そこにだけ置いた宿題は思い出せるかどうかの賭けになる。',
        '記憶へ書くのは判断の根拠のほうで、両方やってよい。',
      ].join(' '),
      {
        body: z
          .string()
          .min(1)
          .describe(
            '何を引き受けたか。後日のあなたが読んでそのまま動ける粒度で書く（対象・狙い・どこまでやるか）',
          ),
        source: z
          .string()
          .optional()
          .describe('関係する相手や出所（マネージャー id・会話 id など。分かるときだけ）'),
      },
      async ({ body, source }) => {
        const entry = {
          id: randomUUID(),
          at: new Date().toISOString(),
          origin: 'self' as const,
          ...(source === undefined ? {} : { source }),
          body,
        };
        await stores.commitments.open(entry);
        // **自分で決めて引き受けたことは日誌に残す。** 聞かずに動いた判断が後から
        // 否定できることが最終承認の実体である（north_star）。自動で開いたものは
        // 起点ごとに既に日誌へ載っているので、ここで残すのは `self` のぶんだけ。
        await stores.journal.append({
          type: 'decision',
          decision: `引き受けた仕事として台帳に載せた（${entry.id}）: ${body}`,
          grounds: '手を付ける前に忘れないため（記憶は時計を持たない）',
        });
        return text(`台帳に載せた（${entry.id}）。片付いたら commitment_close で閉じること。`);
      },
    ),

    tool(
      'commitment_close',
      [
        '引き受けた仕事が片付いたことを記録する。**返事をしただけでは閉じない。**',
        '委譲したなら、マネージャーが報告を返して始末がつくまでは開いたままにしておくこと。',
        'やらないと決めたのなら、それも片付いたうちである（理由にそう書いて閉じる）。',
      ].join(' '),
      {
        id: z.string().describe('commitment_list に出ている id'),
        reason: z
          .string()
          .min(1)
          .describe(
            '何をもって片付いたとするか（やったこと、あるいはやらないと決めた理由）。' +
              '人間はこれを読んで後から否定する',
          ),
      },
      async ({ id, reason }) => {
        const existing = await stores.commitments.get(id);
        if (existing === null) return text(`引き受けた仕事 ${id} は台帳に無い。`);
        if (existing.closedAt !== undefined) {
          return text(
            `${id} は既に ${existing.closedAt} に片付けてある（${existing.closedReason ?? ''}）。`,
          );
        }
        // **片付いているかの判定は台帳の戻り値に任せる**（`commitment_edit` の
        // `editBody` と同じ形）。直前の `get` で読んだ後に、他の経路
        // （`POST /commitments/:id/close` や別セッションの `commitment_close`）が
        // 先に閉じていれば `close` は `false` を返す。ここを見ずに進むと、
        // 実際には閉じていないのに下の日誌へ「片付けた」と書くことになる——
        // これから足す記録そのものが嘘をつく。
        if (!(await stores.commitments.close(id, new Date().toISOString(), reason, 'clone'))) {
          const after = await stores.commitments.get(id);
          return text(
            `${id} は既に ${after?.closedAt ?? '不明な時刻'} に片付けてある（${after?.closedReason ?? '理由の記録なし'}）。`,
          );
        }
        // **自分で閉じたことは日誌に残す。** `commitment_open` が「聞かずに
        // 動いた判断が後から否定できることが最終承認の実体である（north_star）」
        // という理由で `decision` を書いているのと、根は同じ判断である——
        // `reason` の説明そのものが「人間はこれを読んで後から否定する」と
        // 言っている以上、否定する材料は台帳だけでなく日誌にも要る。
        // **台帳の片付き行は永続とは限らない**（`storage-fs` は保持上限を
        // 超えた古い片付き行を物理削除する。#416 / #468）。切られたときの
        // 受け皿は `commitment_list` の「削除された分の内容はここでは二度と
        // 読めない（日誌側の記録が唯一の手掛かりになる）」であり、この
        // append を落とすと、その「唯一の手掛かり」に閉じた理由が最初から
        // 書かれていないことになる（issue #585）。
        await stores.journal.append({
          type: 'decision',
          decision: `引き受けた仕事を自分で片付けた（${id}）: ${reason}`,
          grounds: 'クローン自身が commitment_close で閉じた（人間はこれを読んで後から否定する）',
        });
        return text(`${id} を片付けた。`);
      },
    ),

    tool(
      'commitment_edit',
      [
        '台帳に載っている**自分の**行の本文を後から直す（誤字・言葉足らず・状況が変わって書き直したいとき）。',
        '**直せるのは `origin` が `self` の行、つまりあなた自身が `commitment_open` で載せた行だけである。**',
        '人間が積んだ行（`human`）は人間自身が Web UI から直す。マネージャーの報告（`manager`）は誰も直せない。',
        '片付いた行は直せない（積み直すこと）。',
        '**編集の前後の本文は日誌へ逐語で残る**ので、直した後でも元の本文は読み戻せる。',
      ].join(' '),
      {
        id: z.string().describe('commitment_list に出ている id'),
        body: z
          .string()
          .min(1)
          .describe(
            '直した後の本文（全文。差分ではない）。後日のあなたが読んでそのまま動ける粒度で書く',
          ),
      },
      async ({ id, body }) => {
        const existing = await stores.commitments.get(id);
        if (existing === null) return text(`引き受けた仕事 ${id} は台帳に無い。`);
        // **`origin` の判定はここでする**（`CommitmentStore.editBody` の doc —
        // 競合しない方針判断はストアではなく呼び出し側が持つ）。人間側の口
        // （`PATCH /commitments/:id`）が `origin !== 'human'` を断るのと対称に、
        // ここは `origin !== 'self'` を断る。**書き換えられるのは常に自分自身の
        // 言葉だけ**という線を、人間側とクローン側で同じ形にしてある
        // （`commitmentSchema.editedAt` の doc）。
        if (existing.origin !== 'self') {
          return text(
            `${id} は origin:'${existing.origin}' なので直せない。` +
              (existing.origin === 'human'
                ? '人間が積んだ行は人間自身が Web UI / API から直す。'
                : 'マネージャーの報告（manager）や外から届いた出来事（external）の本文は誰も直せない。') +
              '書き換えてよいのは、あなたが commitment_open で載せた行（self）だけである。',
          );
        }
        // **片付いているかの判定は台帳の戻り値に任せる**（`close` と同じ）。
        // ここで読んだ後に閉じられていても、`editBody` が false を返す。
        const before = existing.body;
        if (!(await stores.commitments.editBody(id, body, new Date().toISOString(), 'clone'))) {
          const after = await stores.commitments.get(id);
          return text(
            `${id} は既に ${after?.closedAt ?? '不明な時刻'} に片付けてある` +
              `（${after?.closedReason ?? '理由の記録なし'}）ので直せない。` +
              '片付いた行を書き直したいなら、commitment_open で新しく載せること。',
          );
        }
        // **編集の前後を両方、日誌へ逐語で残す。これは任意の付け足しではない。**
        // 台帳が守っているのは「一字一句が凍ること」ではなく「クローンが過去の
        // 自分を追えること」であり（`commitmentSchema.editedAt` の doc）、原文が
        // 日誌から読み戻せることがその条件そのものである。**ここを落とすと、
        // `PATCH /commitments/:id` の doc が断っている「静かに書き換わる」に
        // なる。**
        await stores.journal.append({
          type: 'decision',
          decision:
            `引き受けた仕事の本文を直した（${id}）: ` + `編集前「${before}」→ 編集後「${body}」`,
          grounds: '自分で載せた行の本文を自分で直した（原文は日誌に残す）',
        });
        return text(`${id} の本文を直した（元の本文は日誌に残してある）。`);
      },
    ),

    // --- 実行環境プロファイル --------------------------------------------
    //
    // **人間の `~/.zshenv` に当たるもの。** 人間が自分で開いて直せる以上、
    // その写像であるクローンにできないのは能力の削除である（north_star 禁止2）。
    // 鍵が文脈に載ることは方針（システムプロンプト）で扱う。
    tool(
      'profile_read',
      [
        '実行環境プロファイル（人間の ~/.zprofile に当たるもの）の本文を読む。',
        'ここに書いた export は、あなた自身にも、あなたが起こすマネージャーと作業者にも効く。',
        '**本文には鍵が入っている。読んだ中身を記憶や日誌へ書き写さないこと**',
        '（記憶はあなたのシステムプロンプトに載るし、人間がいつでも開く場所である）。',
      ].join(' '),
      {
        offset: z.number().int().min(0).optional().describe('何文字目から読むか（既定 0）'),
      },
      async ({ offset = 0 }) => {
        const current = await stores.profile.read();
        if (current === null) {
          return text('実行環境プロファイルは置かれていない。');
        }
        const part = page(current.script, offset, PROFILE_PAGE);
        // **ここで切れたものを profile_write へ渡すと、プロファイルが縮む。**
        // `profile_write` は全文置換であり、切れた本文でも shell として妥当に
        // 見えるので、検証を通ってしまう＝黙って行が消える。だから
        // 「切れている」だけでは足りず、**書き戻す前に何をすべきか**まで言う。
        const tail = part.more
          ? `\n…（ここで切れている。続きは profile_read offset=${part.to}。` +
            '**profile_write は全文置換なので、書き戻すつもりなら先に offset を進めて' +
            '最後まで取ること** — ここまでの分だけを渡すと残りが消える）'
          : '';
        return text(
          `（最終更新 ${current.updatedAt} / ${describePage(part)}）\n${part.body}${tail}`,
        );
      },
    ),

    // --- 認証トークンのプール（読むだけ） --------------------------------
    //
    // **書き込みは渡さない**（人間の決定 2026-08-25）。回すのは実装（回し手）で
    // あって、クローンの判断を待たない —— PRD「provider」が逐語でそう書いている
    // （枠に当たったクローンはターンを回さないので、判断を待つ設計はいちばん要る
    // ときにいちばん動かない）。**だから `token_add` / `token_disable` は無い。**
    //
    // **読み取りだけ渡すのは、人間が3つの口から見られるものである**（`GET /tokens`
    // / `alteroid token list` / ——Web はまだ頁が無い）。クローンが自分の走っている
    // 資格の状態を見られないのは能力の削除である（north_star 禁止1）。
    tool(
      'token_list',
      [
        '認証トークンのプールを読む（枠に当たったとき実装が回す候補の一覧）。',
        '**値は返らない。** 出るのは id・ラベル・指紋・状態だけである。',
        '**この道具に書き込みは無い。** 回すのは実装であってあなたの判断ではないし、',
        '登録・無効化は人間の手（alteroid token / PUT /tokens）に属する。',
        '枠で止まったときここを見れば、候補が残っているのか全部冷却中なのかが分かる。',
        '回った履歴のほうは journal_read types=token_rotation で引ける。',
      ].join(' '),
      {},
      async () => {
        const [tokens, settings, active] = await Promise.all([
          stores.tokens.list(),
          stores.tokens.readSettings(),
          stores.tokens.readActive(),
        ]);
        // **`toAgentTokenView` を通す。** ここで自分で組むと、値を含む
        // `AgentToken` から拾う形になり、いつか `value` が混ざる（禁止の在り処は
        // `token-pool.ts` の `AgentTokenView` の doc 1つだけにしておく）。
        const views = tokens.map((token) => toAgentTokenView(token));
        const now = Date.now();
        const head = [
          `回す契機: ${settings.rotateOn} / 冷却 ${String(settings.cooldownMs)}ms`,
          active === null
            ? // **`null` を「1本目が現役」と書かない。** 器の環境変数だけで走って
              // いる既定の構成と、1本目を撒いた後は別の状態である
              // （`store.ts` の `readActive` の doc）。
              '現役の指名: **まだ一度も無い**（器の環境変数のまま走っている）'
            : `現役の指名: ${active.tokenId}（世代 ${String(active.generation)}、${active.rotatedAt}）`,
        ];
        if (views.length === 0) {
          return text(
            [
              ...head,
              '',
              'プールは空である。**この状態では回らない**——枠に当たっても次の候補が無い。',
              '登録は人間の手で（`alteroid token add --label <名前> --file <path>`）。',
            ].join('\n'),
          );
        }
        const items = views.map((view) => {
          // `tokenAvailabilityAt` は状態の3列だけを受ける形にしてある（値は見ない）。
          // **キャストを挟まないこと** —— 挟むと「値を持つ型として扱ってよい」が
          // 既成事実になる（`token-pool.ts` の該当 doc）。
          const state = tokenAvailabilityAt(view, now);
          // **`title` は「最初に知りたいこと」を置く欄である**（`excerpt.ts` の
          // `ListingEntryFields` の doc）。ここでは**いま使えるか**であって
          // ラベルではない——ラベルは `summary` が持つ。
          const title = `${state}${active?.tokenId === view.id ? ' ← 現役' : ''}`;
          return renderListingEntry({
            id: view.id,
            title,
            summary: `${view.label}（order ${String(view.order)}）`,
            // **作成・更新が無い行が実在する。** PR1 の版が書いた行はこの2列を
            // 持たない（`token-pool.ts` の `AgentToken.createdAt` の doc）。
            // **`now` で埋めないこと** ——「いま作られた」という嘘になる。
            createdAt: view.createdAt ?? '（記録が無い）',
            updatedAt: view.updatedAt ?? '（記録が無い）',
            extra: [
              view.source === 'env' ? '  器の環境変数を指す行（値を持たない）' : null,
              view.sha256 === undefined ? null : `  指紋 ${view.sha256}`,
              view.cooldownUntil === undefined
                ? null
                : `  冷却明け ${new Date(view.cooldownUntil).toISOString()}`,
              view.disabledAt === undefined ? null : `  人間が外した ${view.disabledAt}`,
              view.lastRejectedReason === undefined
                ? null
                : // **文言はそのまま出す**（言い換えない。受け入れ基準8）。回復の
                  // 見込みは**分類であって実測ではない**ので、そう断って添える。
                  `  止まった理由（原文）: ${excerptLine(view.lastRejectedReason, TOKEN_REASON_EXCERPT)}` +
                  (view.recovery === undefined ? '' : ` / 回復の見込み（分類）: ${view.recovery}`),
              view.invalidatedReason === undefined
                ? null
                : `  失効（原文）: ${excerptLine(view.invalidatedReason, TOKEN_REASON_EXCERPT)}`,
            ],
          });
        });
        return text(
          [
            ...head,
            '',
            renderListing(items, {
              budget: TOKEN_LIST_BUDGET,
              omitted: ({ rest, shown, total }) =>
                `…ほか ${rest} 件は省略（プールは ${total} 件あり、order の昇順に ${shown} 件だけ出した）。` +
                '**残りを見る手はこの道具に無い** — 全件は `alteroid token list` か `GET /tokens` で読む。',
            }),
            // **欄の意味を出力に書く**（`excerpt.ts` の `ListingEntryFields.updatedAt`
            // の doc が要求している）。**「作成と更新が同じ」は値を作ったのではなく
            // 一度も変わっていないという観測である。**
            '（作成 = 行を足した時刻 / 更新 = 最後に変わった時刻。同じなら一度も変わっていない。' +
              'どちらも「記録が無い」ことがある——この2列より前に置かれた行である）',
            '（止まった理由は抜粋。全文は journal_read types=token_rotation の noticeText に在る）',
          ].join('\n'),
        );
      },
    ),

    tool(
      'profile_write',
      [
        '実行環境プロファイルを全文置換する（空文字で外す）。',
        '人間から「このトークンを使って」「PATH にこれを足して」のように**実行環境そのもの**を',
        '渡されたら、会話の中に置いたままにせずここへ移すこと — 会話は要約に潰れ、器は作り直される。',
        '記憶（判断の根拠）とは別の器である。鍵や PATH を記憶に書かないこと。',
        '置く前に実際に読めるかを確かめるので、読めなければ保存も配布もされず理由が返る。',
        '**全文置換なので、足すだけのつもりなら先に profile_read で今の本文を取ること。**',
      ].join(' '),
      {
        script: z
          .string()
          .describe(
            'シェルスクリプト全文（`export FOO=bar` / `export PATH="$HOME/bin:$PATH"` / `eval "$(tool env)"` など）。' +
              '空文字はプロファイルを外す意味になる',
          ),
        summary: z
          .string()
          .describe('何を変えたかの一行要約（日誌に残る。**値そのものは書かない**）'),
      },
      async ({ script, summary }) => {
        if (context.profile === undefined) {
          return text(
            'いまは実行環境プロファイルを差し替えられない場面である（記憶へ移すための内部ターン）。' +
              '次の会話で置くこと。',
          );
        }
        // **人間の口（`PUT /profile`）とまったく同じ1本道を通る。** 評価・保存・
        // 配布が1つの区間として直列に行われるので、人間の更新と重なっても層ごとに
        // 違う本文が残らない。
        const result = await context.profile.apply(script);

        // **失敗を判断として記録しない。** 置けなかったのはシステムの結果であって
        // クローンの判断ではない。理由はそのまま返して、直すのはこの場でやらせる。
        if (!result.stored) {
          return text(
            `実行環境プロファイルを置けなかった（保存も配布もしていない）: ${result.clone.error ?? '理由不明'}` +
              `${result.clone.output === undefined || result.clone.output.length === 0 ? '' : `\n${result.clone.output}`}`,
          );
        }

        await stores.journal.append({
          type: 'decision',
          decision: `実行環境プロファイルを更新した: ${summary}`,
          grounds: '人間から実行環境そのものを渡された（値は記録しない）',
        });

        const failed = result.runners.filter((runner) => !runner.ok);
        const delivered = result.runners.filter((runner) => runner.ok).map((r) => r.runnerId);
        return text(
          [
            `実行環境プロファイルを更新した（sha256 ${result.sha256 ?? '外した'}）。`,
            delivered.length === 0
              ? null
              : `配った先: ${excerptLine(delivered.join(', '), PROFILE_DISTRIBUTION_EXCERPT)}`,
            failed.length === 0
              ? null
              : `配れなかった先: ${excerptLine(
                  failed.map((r) => `${r.runnerId}（${r.error ?? '理由不明'}）`).join(', '),
                  PROFILE_DISTRIBUTION_EXCERPT,
                )}`,
            'これから起こす仕事には即座に効く。走行中の仕事は gh / git だけが次の呼び出しから拾う。',
          ]
            .filter((line) => line !== null)
            .join('\n'),
        );
      },
    ),

    // --- 自分自身 -----------------------------------------------------------
    tool(
      'self_read',
      [
        '自分自身（alteroid）の正典を1つ読む。',
        '自分が何で出来ているか・何が要件か・どう設計されているか・何が未着手かはここにある。',
        'ビルド時に焼き込んだ写しなので、実装の最新が要るならマネージャーにリポジトリを読ませること。',
        '長いので切れて出る（続きの取り方が出力に付く）。',
      ].join(' '),
      {
        document: z
          .string()
          .describe(`正典の名前。読めるのは ${canonNames().join(' / ')}（上ほど優先順位が高い）`),
        offset: z.number().int().min(0).optional().describe('何文字目から読むか（既定 0）'),
      },
      async ({ document, offset = 0 }) => {
        const doc = canonDocument(document);
        if (doc === undefined) {
          return text(`正典 ${document} は無い。読めるのは ${canonNames().join(' / ')}。`);
        }
        const part = page(doc.content, offset, CANON_PAGE);
        const tail = part.more
          ? `\n\n…（ここで切れている。続きは self_read document=${doc.name} offset=${part.to}）`
          : '';
        return text(
          `${doc.path}（${CANON_REVISION.length > 0 ? `リビジョン ${CANON_REVISION}` : 'リビジョン不明'} の写し / ${describePage(part)}）\n\n${part.body}${tail}`,
        );
      },
    ),

    /**
     * **人間は Claude Code で自分の設定（モデル・版・許可モード・MCP 接続）を見られる。**
     * クローンから見えないなら、その一点で人間の代替になっていない
     * （north_star 禁止1）。ここは `SelfFacts`（システムプロンプトに焼き込む静的な事実）
     * とは別物で、SDK が走行中に実際に報告してくる値を返す。
     *
     * 整形は `self.ts` の `describeCloneRuntime` に寄せてある（自分自身の事実を1か所に
     * 集めるため）。ここで組み立てるのは、その場でしか読めない2つだけ — いまの記憶の
     * 大きさ（会話の途中で書き換わりうる）と、台帳との突き合わせ（SDK モデル id が
     * 分かって初めて意味を持つ）。
     */
    tool(
      'self_status',
      [
        'いま自分が何で走っているかを返す（宣言されたモデル帯・SDK が実際に報告したモデル id・',
        'effort・Claude Code の版・認証の出所（値ではなく名前）・許可モード・MCP サーバ・',
        'セッション id・記憶の大きさ・台帳との突き合わせ）。',
        '**effort はこのセッションで最初の道具呼び出しでは取れない**（前の道具呼び出しの結果として',
        '観測するため）。モデルが effort に対応していない場合もずっと取れない。',
        '取れない値は「まだ分からない」と出る（既定値では埋めない）。',
      ].join(' '),
      {},
      async () => {
        const runtime = context.runtime?.();
        if (runtime === undefined) {
          return text(
            'いまは自分の実行時の事実を読めない場面である（記憶へ移すための内部ターン）。' +
              '次の会話で呼ぶこと。',
          );
        }

        const [documents, memoryDocuments, aggregate] = await Promise.all([
          stores.persona.list(),
          stores.persona.documents(),
          // モデル id が分かっていなければ、突き合わせる軸そのものが無い。
          runtime.sdkModel === null ? Promise.resolve(null) : stores.usage.aggregate({}),
        ]);

        return text(
          [
            describeCloneRuntime(runtime),
            '',
            // **クローンの文脈へ実際に載る形で数える。** 本文だけを足すと、見出しの
            // ぶんだけ本当より少ない数を「いまの総文字数」として名乗ることになる。
            renderMemorySize(documents, memoryDocuments, renderMemoryDocuments(memoryDocuments)),
            '',
            renderLedgerCrossReference(runtime.sdkModel, aggregate),
          ].join('\n'),
        );
      },
    ),

    /**
     * 自分（クローン）が残した「握り潰しの跡」を、器の中から読み戻す（#242）。
     *
     * **#242 の前半（人間が Railway で stderr を読めるか）は既に決着している
     * ——人間は読めている（#242 コメントの実測）。ここが埋めるのは後半だけ**
     * ——クローン自身が器の中から自分の跡を1行も遡れなかった穴。
     *
     * **`journal_read` と二重に持たない。** 日誌は「起きたこと」を持ち、
     * ここが持つのは「記録できなかった／読み出せなかった」という、日誌
     * そのものへは書けなかった側である（`dropped-record.ts` 冒頭 doc の
     * 「`journal` と二重に持たない線引きが要る」）。日誌の型を1つも増やして
     * いない——増やせば `JOURNAL_ENTRY_TYPES` 経由で `openapi.json`（外向きの
     * HTTP 面）が動く（`noteDroppedInboxEvent` の doc と同じ判断）。
     *
     * **この道具固有の応答（`limit`・予算での省略）は HTTP には出さない。**
     * `self_read` / `self_status` と同じ扱いの MCP 専用の口である。**ただし
     * 材料の帳面（`recentDroppedTraces()`）そのものは、デーモンとクローンが
     * 同一プロセスで動くため（`dropped-record.ts` の `DroppedTraceOrigin` の
     * doc）、`GET /dropped`（`apps/daemon/src/app.ts`）からも読める** ——
     * PRD「入口の等価性」に沿って足された別口で、供給元は1本のまま口だけ
     * 増えている。この道具を「代わりに使ってよい」ではなく、`limit` や
     * 予算での省略といったこの道具固有の振る舞いは HTTP には移植していない、
     * という意味である。
     *
     * **応答の字面は `dropped-record.ts` の3関数
     * （`describeDroppedTraceOrigin` / `describeDroppedTraceEmpty` /
     * `describeDroppedTraceRetention`）を通す。** `GET /dropped` と生成元を
     * 1つに揃えるためで、`describeSessionMissingKind` と同じ判断
     * （生成元を1箇所に閉じる）。
     */
    tool(
      'self_dropped',
      [
        '自分（クローン）が記録・読み出しをしそこねた跡（`noteDroppedRecord` 等が',
        'stderr へ残す行）を、このプロセスの中から読み戻す。',
        '器の外（Railway 等のホスティング先のログ）へ出ている生の stderr の代わりではない',
        '——そちらは既に人間が読める（#242）。ここは、器の中からは1行も遡れなかった',
        '穴を塞ぐためのものである。',
        'このプロセスが生きているあいだの直近の分だけを持つ（帳面の保持件数は',
        `${RECENT_TRACE_LIMIT} 件。それより古い分はこのプロセスの中には無く、器の外の`,
        'stderr を見るしかない）。再起動・デプロイの入れ替えでも消える。',
      ].join(' '),
      {
        limit: z
          .number()
          .int()
          .min(1)
          .max(RECENT_TRACE_LIMIT)
          .optional()
          .describe(
            `直近から何件返すか（既定 ${SELF_DROPPED_DEFAULT_LIMIT}、最大 ${RECENT_TRACE_LIMIT}` +
              '＝帳面が保持している件数そのもの）。',
          ),
      },
      async ({ limit = SELF_DROPPED_DEFAULT_LIMIT }) => {
        const origin = describeDroppedTraceOrigin('daemon');
        const since = `この帳面が数え始めたのは ${droppedTraceLedgerSince()}。`;
        const all = recentDroppedTraces();
        if (all.length === 0) {
          return text([describeDroppedTraceEmpty(), origin, since].join(' '));
        }
        const traces = all.slice(-limit);
        return text(
          [
            renderListingFromEnd(traces, {
              budget: SELF_DROPPED_BUDGET,
              omitted: ({ rest, shown, total }) =>
                `…ほか古い ${rest} 件は省略（この呼び出しで渡した ${total} 件のうち直近 ${shown} 件だけ出した）。`,
            }),
            origin,
            all.length > traces.length
              ? `（帳面には全 ${all.length} 件のうち直近 ${traces.length} 件だけをここへ渡した。` +
                `もっと古い分は limit を上げて呼ぶこと。${describeDroppedTraceRetention(RECENT_TRACE_LIMIT)} ` +
                `${since}）`
              : `（${describeDroppedTraceRetention(RECENT_TRACE_LIMIT)} ${since}）`,
          ].join('\n'),
        );
      },
    ),

    // --- 委譲 --------------------------------------------------------------
    tool(
      'manager_start',
      [
        'マネージャー（あなたが起こす Claude Code）に仕事を任せる。',
        '起動して即返るので、完了を待たずに次の判断へ移ってよい。同時に何本走らせてもよい。',
        '依頼できるのは実装だけではない。調査・設計の相談・外部サービスの確認・レビューも同じように頼める。',
      ].join(' '),
      {
        request: z
          .string()
          .describe('依頼内容。人間が Claude Code に書くのと同じ粒度で、背景と狙いを添えて書く'),
        cwd: z
          .string()
          .optional()
          .describe('作業ディレクトリ（実プロジェクトの場所）。省略時はデーモンの既定'),
        runnerId: z
          .string()
          .optional()
          .describe(
            '置き先の器を名指しで指名する（runner_list / manager_list が出す runnerId）。' +
              'これは配置の指名であって本数の制限ではない——省略すれば資源による自動配置。' +
              '指名した器が名簿に無い・使えない・名前が重複のときは失敗し、他の器へは' +
              '自動で落とさない（返ってきた文言をそのまま読むこと）。',
          ),
      },
      async ({ request, cwd, runnerId }) => {
        if (!context.managers) return NO_POOL;
        const started = await context.managers.start({
          request,
          ...(cwd === undefined ? {} : { cwd }),
          ...(runnerId === undefined ? {} : { runnerId }),
        });
        await stores.journal.append({
          type: 'decision',
          decision:
            `マネージャー ${started.managerId} を起こした（cwd: ${started.cwd}` +
            `${runnerId === undefined ? '' : `, 指名: runnerId=${runnerId}`}）: ${request}`,
          grounds: '委譲の判断',
        });
        return text(
          `マネージャー ${started.managerId} を起こした（cwd: ${started.cwd}、` +
            `runner: ${started.runnerId ?? '未記録'}）。` +
            '報告・質問は後から受信箱に届く。',
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
        // **5つ目の形を名指しする（#563）。** かつてこの場合は `ManagerSendResult` に
        // ならず例外として貫通していたので、クローンが受け取るのは生の例外文言だった
        // ——「何が起きたか」も「次に何をすればよいか」も、この説明文から読めなかった。
        'manager_list が [running] と出していても、runner の側でセッションが畳まれていることがある' +
          '（その合図が届かなかった窓）。そのときは resume から入り直して届けるので、' +
          '返り値にそう書いてある。入り直せなかったときも「そんな id は無い」ではなく' +
          '「セッションが無い」と返る——委譲そのものは台帳に在るので、manager_start で' +
          '起こし直す前に、返ってきた文言をそのまま読むこと。',
        // **「セッションが無い」を「仕事が失われた」と読ませない（#563）。**
        // 完遂した後に畳まれた回も同じ形に見え、デーモンには区別する材料が無い。
        // 決めつけたクローンは完遂済みの仕事を委譲し直す（`gh pr create` が二度
        // 走りうる）。理由の全文は `manager.ts` の `sendFailureDetail` の doc。
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
        decision: z
          .enum(['allow', 'deny'])
          .optional()
          .describe('許可確認への回答のとき必須。それ以外では不要'),
        // **生ログの id を渡しても通らない（#572）。** `ask_human` の `requestId` と
        // 同じ素性で、同じ罠がある——`#choosePending` は `record.waiting` を id で
        // 線形一致させるだけなので、名前空間の違う id は「待っていない」に落ちる。
        // **その文言は「まだ届いていない」と見分けが付かない。**
        requestId: z
          .string()
          .optional()
          .describe(
            'どの確認への回答かを示す id（受信箱に届いた requestId）。' +
              '1本のマネージャーが複数を同時に待つことがあるので、回答では必ず添えること。' +
              '⚠️ 生ログの id とは別物である——生ログに出る toolu_…（tool_use_id）も ' +
              'req_…（API の request id）も、ここでは通らない。' +
              '受信箱に届いていない確認に、生ログから答える手段は無い（#572）',
          ),
      },
      async ({ managerId, message, decision, requestId }) => {
        if (!context.managers) return NO_POOL;
        const result = await context.managers.send(managerId, message, {
          ...(decision === undefined ? {} : { decision }),
          ...(requestId === undefined ? {} : { requestId }),
        });
        // **`outcome` ごとに言い分ける**（`manager_stop` と同じ形。#563）。
        // `detail` は既に理由を持っているが、それだけだと「起こし直せばよいのか」が
        // 読めない——`session_missing` は**そのものは居る**側なので、`manager_start`
        // で起こし直すと同じ仕事が2本になりうる。そこだけは必ず言い足す。
        if (result.outcome === 'session_missing') {
          return text(
            `[${managerId}] ${result.detail}\n` +
              '**この委譲そのものは台帳に在る**（「そんな id は無い」ではない）。' +
              'runner に生きたセッションが無く、resume でも入り直せなかっただけである。' +
              'manager_list で状態を確かめ、時間で解ける理由（引き取り中・貸し出し期限）' +
              'なら少し置いてから送り直すこと。**先に manager_start で起こし直さないこと**' +
              ' — 同じ仕事が2本になる。',
          );
        }
        return text(result.detail);
      },
    ),

    /**
     * **止める手。**
     *
     * 人間は Web UI と CLI から1本ずつ止められる（`DELETE /managers/:id`）。
     * クローンにそれが無いと、暴走したマネージャーも、報告を出したのに終わらない
     * マネージャーも、**無応答のまま放置するしか手が無い**（north_star 禁止1:
     * 能力の削除）。実際にそうなった。
     *
     * 通す口は人間と同じ `ManagerPool.abort` である。**クローン用の停止を別に
     * 作らない** — 挙動が2種類あると、人間とクローンで見えている状態が食い違う。
     *
     * これは**クローンの道具**であって、マネージャーには渡らない（この MCP は
     * クローン側にしか配線が無い）。マネージャーが自分や隣の仕事を止められる
     * ようになると、M4 の制御面分離が意味を失う。
     */
    tool(
      'manager_stop',
      [
        'マネージャーを止める。人間が Web UI から押す停止と同じもので、その1本だけが止まる。',
        '暴走しているとき、報告を出したのに終わらないとき、依頼自体が要らなくなったときに使う。',
        '止めたあと本当に止まったかを確かめて返すので、返ってきた状態まで読むこと。',
      ].join(' '),
      {
        managerId: z.string().describe('manager_list に出ている id'),
        reason: z
          .string()
          .optional()
          .describe('なぜ止めたか。日誌と、その仕事の記録に残る。後から辿れるように書く'),
      },
      async ({ managerId, reason }) => {
        if (!context.managers) return NO_POOL;
        const pool = context.managers;
        const find = async (): Promise<ManagerSummary | undefined> =>
          (await pool.list().catch(() => [])).find((manager) => manager.managerId === managerId);

        // 止める前の状態を控える。**既に終わっていた仕事を止めたときに、それを
        // そうと言えるようにする**ため（黙って何もしないのが一番悪い）。
        const before = await find();
        const result = await pool.abort(managerId, reason, 'clone');

        // **outcome ごとに言い分ける。** 以前は `outcome` が常に `'stopped'` で、
        // 止まっていない・不明なときも「止めた」と機械可読な形で答えていた
        // （R1）。ここで4値をそのまま文言に写す。
        if (result.outcome === 'absent') {
          // **エラーで終わらせず、何が起きているかを言う。**
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

        const after = await find();

        if (result.outcome === 'not_stopped') {
          // **止まっていないと確かめた（明確な失敗）。「止めた」と言わない。**
          return text(
            `[${managerId}] ${result.detail}\n` +
              `**止まっていない。** runner には ${managerId} のセッションがまだ残っている。` +
              `いまの状態: ${after === undefined ? '一覧から消えている' : describeManagerState(after.status, after.live)}。` +
              ' manager_list で確かめ、必要ならもう一度止めること。',
          );
        }

        if (result.outcome === 'unknown') {
          // **確かめられなかった（不明）。「止めた」とも「止まっていない」とも
          // 言い切らない。**
          return text(
            `[${managerId}] ${result.detail}\n` +
              '止まったかは**未確認**である（runner に確認が取れなかった）。' +
              'manager_list で状態を確かめること。',
          );
        }

        // ここに来るのは outcome === 'stopped'（sessionGone === true を確かめた）。
        const lines = [`[${managerId}] ${result.detail}`];

        if (before?.status === 'done') {
          // **`done` は「マネージャー自身のターンが終わって待機中」でしかない。**
          // その下で作業者が走っているかは、デーモンからは見えていない（作業者の
          // 生存も worktree の更新時刻も、ここからは読めない）。前の文言は
          // 「走っている手は無く」と断定していたが、それは観測ではなく推測である。
          lines.push(
            'もともと待機中（done）だった仕事である。マネージャー自身のターンは終わっていたので、' +
              '畳んだのは記録である。ただし **`done` は「その下で誰も動いていない」ことまでは' +
              '意味しない** — 作業者が走っているかどうかはデーモンからは見えていない。',
          );
        }
        lines.push(
          after === undefined
            ? '一覧からも消えている。'
            : `いまの状態: ${describeManagerState(after.status, after.live)}。`,
        );
        return text(lines.join('\n'));
      },
    ),

    /**
     * **#358 のうち、runner→デーモンの脚の滞留は、この一覧では観測できた分だけ出す
     * （案b・案b の第2段）。**
     *
     * `RunnerPlacementResources.pendingEvents` / `oldestPendingAt` は runner
     * ごとに取れる（`apps/daemon/src/runner-client.ts` の `resources()`）。
     * これを読むには `ManagerPool.runners({ resources: true })` を呼ぶ必要が
     * あり、**この一覧（`runner_list` ではなく `manager_list`）から毎回それを
     * 呼ぶ形は採らない**——`runners()` の doc（`ManagerPool.runners` の
     * JSDoc）が守っている「既定では `resources()` を呼ばない＝この一覧のために
     * ネットワーク往復を足さない」を破ることになり、かつ `runner_list` の
     * `resources: true` というクローンの明示的な opt-in を、`manager_list`
     * 側から自動で踏み潰すことにもなる（north_star 禁止2）。**この判断は
     * 案b の第2段でも変えていない**——`manager_list` 自身はいまも
     * `resources()` を一度も呼ばない（`manager.test.ts` の歯）。
     *
     * **代わりに、`ManagerPool.runnerBacklog()`（キャッシュ。往復を足さない）
     * を読む。** ここが読む値には2つの由来があり、**どちらも往復を新しく
     * 足していない。**
     *
     * 1. `runners({ resources: true })` が呼ばれるたび（＝クローンが
     *    `runner_list resources: true` を明示的に選ぶたび）——`resources()`
     *    の応答から拾う。
     * 2. **10秒ごとの生存確認（`RunnerRegistry` の heartbeat）が、
     *    `identity()` の応答から同じ2欄を拾う（案b の第2段）。** 元々10秒
     *    ごとに走っている往復に乗せているだけなので、こちらも新しい往復では
     *    ない。`identity()` を持つ runner については、`runner_list` を
     *    一度も `resources: true` で呼んでいなくても、この経路で自然に
     *    warm する。
     *
     * どちらの由来かは呼び出し側から区別しない（`RunnerBacklogSnapshot` は
     * 同じ形）——`runnerBacklog()` が観測時刻の新しいほうを採って合流させる。
     *
     * **それでも「常に新しい」わけではない。** `identity()` を持たない
     * runner（`LocalRunner`・古い器）は2の経路を一切通らないので、
     * `runner_list resources: true` を一度も呼んでいなければ、その runner は
     * 依然 cold（行が出ない）である。「行が無い＝滞留0」ではなく「0件
     * だったか、まだ観測していないかのどちらか」——`describeRunnerBacklog`
     * の doc、この道具の description の断りを参照。値が出ても**それは
     * 観測した時点の値であって現在値ではない**ので、行には必ず観測時刻を
     * 添える。
     *
     * ## この判断は #579 でも変えていない（読む側が確かめられるように書いておく）
     *
     * #579 で **heartbeat が `GET /managers` を引くようになった**（`⚠ 宛先の
     * runner は … セッションを持っていなかった` の行が、誰かが送るのを待たずに
     * 立つようになった）。**増えた往復は heartbeat の側だけである** — この道具の
     * ハンドラはいまも `runner.list()` も `resources()` も呼ばず、名簿の像を
     * 同期に読むだけである（`manager.test.ts` の歯が両方を数えている）。
     * ⟹ ここが守っているもの（**一覧の側から自動で往復を払わない＝クローンの
     * opt-in を踏み潰さない**。north_star 禁止2）はそのまま生きている。
     */
    tool(
      'manager_list',
      [
        'マネージャーの一覧と状態を見る。何が走っていて、何が返事待ちかが分かる。',
        // **状態の名前を「観測」より強く読ませない。** running は「走らせた」で
        // あって「進んでいる」ではなく、done は「マネージャーのターンが終わった」
        // であって「仕事が終わった」ではない。⚠ の行がその差を埋める。
        '状態の名前はデーモンが観測できた範囲でしかないので、⚠ の行まで読むこと。',
        '依頼文と報告は抜粋なので、全文が要るなら manager_report で取ること。',
        // **#579**: 「runner にセッションが無い」を、誰かが送るまで待たずに
        // 名乗れるようになった。⚠ の行そのものの字面は変えていない——変えたのは
        // **立つ時機**である。ここに書くのは、この一覧を読む側が「送るまで
        // 分からない」という前の性質のまま読み続けないようにするためである
        // （JSDoc に書いてもクローンには届かない。上の resources: true と同じ理由）。
        '「runner にセッションが無い」は、10秒ごとの生存確認が runner に一覧を' +
          '聞いて観測する（走行中・返事待ちのものだけを見る）。誰かが manager_send を' +
          '打つのを待たない。ただし観測できた回にだけ立つので、**行が出ないことを' +
          '「セッションは在る」と読まないこと** — 器に聞けなかっただけの回もある。' +
          '待機中（done）のものはこの観測の対象外である（完遂してセッションを畳んだ' +
          '回と区別が付かず、区別できないものに ⚠ を付けると本当に困っている1本が埋もれる）。',
        // #358 案b の第2段: `manager_list` 自身はいまも `resources()` を
        // 呼ばない（往復を増やさない、という設計判断は変えていない）。
        // **ただしキャッシュは2つの経路で warm する** — (1) runner_list を
        // resources: true で明示的に呼ぶ (2) 10秒ごとの生存確認が
        // identity() を持つ runner から自動で拾う。**(2) を持たない runner
        // （LocalRunner・古い器）は (1) を待つしかなく、依然 cold になりうる**
        // ——「行が無い＝滞留0」ではなく「0件だったか、まだ観測していないか
        // のどちらか」。出ている行も観測した時点の値であって「いま」ではない。
        '器（runner）側の未送出の滞留は、runner_list を resources: true で明示的に呼んだとき、' +
          'または10秒ごとの生存確認が対応する runner から自動で拾ったときに、それぞれ' +
          'キャッシュされる（それ以外の経路では更新されない）。生存確認からの自動更新に' +
          '対応しない古い runner・LocalRunner は、runner_list を resources: true で' +
          '呼ばない限り一度も warm しない——この一覧に行が出ないことを「滞留0」と' +
          '読まないこと。0件だったか、まだ観測していないかのどちらかである。出ている行も' +
          '観測した時点の値であって現在値ではないので、最新の値が要るなら runner_list を' +
          'resources: true で呼び直すこと。',
        // **#572**: 「道具の応答待ちのまま、誰も待っていない」の ⚠ が何を
        // 意味するかを、道具の説明文（クローンが毎回読む値そのもの）にも
        // 書く。JSDoc に書いてもクローンには届かない（`resources: true` の
        // 説明文を足したときと同じ理由。`tools.test.ts` に歯が在る）。
        '生ログの末尾が stop_reason: tool_use のまま対応する tool_result が無く、かつ返事待ちが空の' +
          'ものには ⚠ の行が出る（道具を回しているなら、その応答を待っているのはデーモンのはずなので、' +
          'これは矛盾である）。この行に時刻の閾値は置いていない——何分経ったかは判定していないので、' +
          '行に出ている timestamp を読んで判断すること。返事待ちが在るものにはこの行を出さない' +
          '（確認は届いていて、クローンがまだ答えていないだけの正常な状態である）。',
      ].join(' '),
      {},
      async () => {
        if (!context.managers) return NO_POOL;
        const managers = await context.managers.list();
        // **デーモン→クローンの脚（受信箱）の滞留は、マネージャーの本数と無関係**
        // （#358）。マネージャーが1本も居なくても、受信箱には既に合図が溜まって
        // いることがあるので、早期リターンの前に確かめる。
        const inboxBacklog = describeInboxBacklog(await context.stores.inbox.pending());
        // runner→デーモンの脚も同じ理由で本数と無関係（#358 案b）。
        // `runnerBacklog()` はキャッシュを読むだけ——ここでも往復は増えない。
        //
        // **`?.() ?? []` で読まない。** その形は「この口を持たない実装」と
        // 「持っているが1件も観測していない」を同じ `[]` へ畳む——**まさに
        // この一覧が区別しようとしているもの**（#358 の主題）を、呼び出し口の
        // 型で潰すことになる。だから `ManagerPool.runnerBacklog` は非 optional
        // にしてある（その doc を参照）。
        const runnerBacklog = describeRunnerBacklog(context.managers.runnerBacklog());
        if (managers.length === 0) {
          return text(
            ['（マネージャーは1本も居ない）', inboxBacklog, runnerBacklog]
              .filter((line): line is string => line !== null)
              .join('\n'),
          );
        }

        // **予算を先に決めて、入るところまで積む。** 件数から出力量を決めると、
        // 何件で壊れるかが運任せになる。切ったなら必ずそう言う。
        // 積む形そのものは `renderListing` が持つ（一覧ごとに手で書かない）。
        const items = managers.map((manager) =>
          renderListingEntry({
            id: manager.managerId,
            title: `[${describeManagerState(manager.status, manager.live)}]`,
            createdAt: manager.startedAt,
            updatedAt: manager.updatedAt,
            summary: `依頼: ${excerptLine(manager.request, LIST_REQUEST_EXCERPT)}`,
            extra: [
              // **runnerId は空欄にしない。** 取れていないことを「未記録」という
              // 文字列で読める形にする（AGENTS.md「取れない軸に0の行を作らない」と
              // 同じ理由——空欄だと「取れていない」のか「読み忘れ」なのか区別できない）。
              // **`live: false` の理由を、分かる分だけ名指しする。** 状態名だけだと
              // 「セッションが終わった」のか「宛先の器が消えた」のかが読めず、
              // 打つ手（起こし直すのか、器の側を見るのか）が決まらない。
              // **断定は「器が黙っている」までである** — その中で走っていたか
              // どうかは、この観測からは言えない（`ManagerSummary.runnerLostSince`）。
              //
              // **⚠️ 「いま話しかけられない」と書かないこと。実測して嘘だと
              // 分かっている。**
              //
              // 2026-08-28 まで、ここは「新しい委譲の宛先からも外れている ⟹ いま
              // 話しかけられない」と書いていた。**`packages/core` の足場で実測したら
              // 偽だった** —— 名簿が `state: 'lost'` と判定した器に載っている委譲へ
              // `ManagerPool.send()` を撃つと
              // `{ outcome: 'delivered', detail: '追加指示として届けた。' }` が返り、
              // runner の resume の口が実際に叩かれる。構造の理由: `#markSilent` は
              // `entry.state` を `'lost'` にするだけで **`entry.client` を落とさず**、
              // `Registry#get()` は `entry.state` を見ない（`list()` は `lost` を
              // 除くが `get()` は除かない）。`send()` は `job.runnerId` が在れば
              // `#runnerOf` → `get()` を通り、**`runnerLostSince` が立つのは
              // `runnerId` が在るときだけ**なので必ずこちら側である。
              //
              // **これは一度閉じた欠陥と同じ形である。** `ba4053d`（#67「「いま
              // 送っても届かず」の真下に、届く送信ボタンが並んでいた」）は、届く
              // 相手に「届かない」と書いた**注記のほうを**直した（送信は塞がなかった
              // —— 塞ぐと「人間が自分の言葉で繋ぎ直す唯一の手」が消える。
              // north_star 禁止1）。
              //
              // **⚠️ #67 の commit 本文が持つ実測表（`delivered` / `unknown` の
              // 2値）をそのまま当てないこと。あれは古い。** `0fb068f`（PR #571
              // 「manager_send が [running] の相手へ 404 を貫通させる」#563）で
              // `ManagerSendResult.outcome` は**4値**（`answered` / `delivered` /
              // `session_missing` / `unknown`）になった。**commit 本文は書き換わら
              // ないので、いつ偽になったかが本文からは読めない。**
              //
              // ⟹ **残してよいのは「新しい委譲の宛先からは外れている」まで**
              // （`list()` が `lost` を除くので実測で真）。落とすのは送信可否の
              // 推論だけである。生の値は PR #586 のコメント
              // （`pull/586#issuecomment-5450674492`）に在る。
              //
              // **次の一手の語はこの面のものを使う** —— ここはクローンが読む面
              // なので `manager_send` / `manager_start` / `runner_list` を名指し
              // する（CLI は `/msg`、Web UI は画面の語）。
              `  runner: ${manager.runnerId ?? '未記録'}${
                manager.runnerLostSince === undefined
                  ? ''
                  : `（この器は ${manager.runnerLostSince} 以降 名乗っていない。新しい委譲の宛先からは外れている（置き先として数えない）。**この委譲が失われたという意味ではない** — 黙っているのが器なのか経路なのかは、ここからは言えない（器の中でまだ走っていることもある）。話しかけることは塞いでいない — 戻る先（session_id）が在れば manager_send が resume を試みる（届くとは限らない）。**先に manager_start で起こし直さないこと** — 同じ仕事が2本になる。器そのものは runner_list で見る）`
              }`,
              // **`runnerLostSince` と同じ作法で、別の行として出す（#563）。**
              // `describeManagerState` は動かさない——`manager_list` と要約
              // （`digest.ts`）で字面が割れると、そこで潰れることを防ぐために
              // 作られた関数の意味が無くなる（あの doc を参照）。
              //
              // **`[running]` のままなのは正しい。** `status` は動かさないし、
              // `live` も落ちない（`sessionId` が在れば resume から入り直せる）。
              // ⟹ **`live: true` とこの行の組が5つ目の形を名指しする。**
              // 件数のほうは `describeManagerCounts` が先頭で（予算に切られない
              // 場所で）名乗る。
              manager.sessionMissingSince === undefined
                ? null
                : `  ⚠ 宛先の runner は ${manager.sessionMissingSince} の時点で、この委譲のセッションを持っていなかった` +
                  '（runner がそう答えた。聞けなかったのではない）。' +
                  // **由来を畳まない（#579）。** 「resume でも入り直せなかった」と
                  // 「名簿に載っていなかっただけ」では、読み手の次の一手が違う
                  // （前者は始末をつける側、後者は manager_send で入り直せる）。
                  // 字面の生成元は `describeSessionMissingKind` 1箇所である。
                  describeSessionMissingKind(manager.sessionMissingKind) +
                  '**この委譲が失われたという意味ではない** — ' +
                  '完遂した後にセッションが畳まれ、終端イベントだけが届かなかった回も同じ形に見える' +
                  '（デーモンにこの2つを区別する材料は無い）。まず manager_report を見ること' +
                  '（報告が空でも、生ログから「生成されたが配られていない」報告を拾える）。' +
                  'session_id が残っていれば manager_send が resume から入り直す。' +
                  '**先に manager_start で起こし直さないこと** — 同じ仕事が2本になる。',
              `  cwd: ${manager.cwd}`,
              // **`lost` を状態名だけで済ませない。** 「終わった」と読まれると、
              // 完了していない仕事がそのまま片付く。何が起きたかと、次に何をすれば
              // よいかを、この一覧の中で言い切る。
              //
              // **ただし、言い切れるのは観測した分までである。** `lost` が表して
              // いるのは「前のセッションへ戻れなかった」という**一つの**観測で
              // あって、成果の有無ではない。デーモンは PR もブランチも見ていない
              // （リポジトリの事情はマネージャーの領域である）。実際に、落ちる
              // 直前に PR を出して CI を通しマージまで済ませていた仕事が、その
              // 1分半後の器の作り直しで `lost` になり、この行が「途中で失われて
              // いる（完了ではない）」と嘘をついた。
              //
              // 断定を外しても `done` とは混ざらない。「戻れなかった」は
              // 「終えて待っている」ではないからである（PR #42 の分け方は保つ）。
              manager.status === 'lost'
                ? '  ⚠ 前のセッションへ戻れなかった。**戻れたかどうかしか見ていない** — ' +
                  'この仕事が終わっていたかは分からない（成果がリモートの PR・ブランチ・' +
                  'コミットまで届いていることがある）。まずそこを確かめ、続きが要ると' +
                  '判断したときだけ manager_start で起こし直すこと。'
                : null,
              // **拒否は `status` に映らない。** 分類器か deny 規則がその場で止めた
              // 仕事は `running` のまま手が動かない。日誌と（繰り返したときだけ）
              // 受信箱にしか出ないので、一覧を見ているクローンには「走っている」と
              // しか読めなかった。状態の値は増やさず、状態に添える。
              denialLine(context.managers?.denials(manager.managerId) ?? []),
              // **待ちの要約も抜粋を通す。** runner 側の `brief(input, 200)` が実質の
              // キャップになっていたが、`AskUserQuestion` の経路（`describeQuestions`）は
              // 質問文を `join(' / ')` で連ねてそのキャップを通らない。ここを通して
              // おけば、上流のどの経路から来ても一覧は伸びない。
              // **種別（質問 / 実行許可）と、待ち始めた時刻も出す（#334 / #323）。**
              // クローンは `requestId` と要約だけでは、答えるべきなのが自由な
              // 言葉での回答なのか許可の可否なのかを読めなかった——画面側と
              // 同じ穴がここにもあった。時刻は runner が確認を受け取った瞬間
              // （`askedAt`）で、答えが来た時刻ではない。5分前と4時間前とで
              // 次にすべきことが変わる（#323: 報告が何時間も遅れる欠陥）。
              // **どちらも省略されうる**（版のずれの窓。`describeWaitingKind` /
              // `describeAskedAt` の doc）——欠けていても「実行許可」「undefined
              // から」と嘘をつかず、`種別不明` にして時刻の断片を落とす。
              // **件数そのものにも上限を置く（#409）。** 1件ごとの厚みは
              // `LIST_WAITING_EXCERPT` が締めていたが、`manager.waiting` は
              // `push` のみで増える配列で件数には上限が無かった——外側の
              // `renderListing` は「マネージャー1本ぶん」を1件として文字数の
              // 予算を見るので、この配列だけが伸びると1本のマネージャーだけで
              // 予算を占有し、他のマネージャーが黙って押し出される。
              ...manager.waiting.slice(0, MANAGER_WAITING_LIST_LIMIT).map((item) => {
                const askedAtNote = describeAskedAt(item.askedAt);
                return (
                  `  返事待ち(requestId: ${item.requestId}, ${describeWaitingKind(item.kind)}` +
                  `${askedAtNote === '' ? '' : `, ${askedAtNote}`}): ` +
                  excerptLine(item.summary, LIST_WAITING_EXCERPT)
                );
              }),
              manager.waiting.length > MANAGER_WAITING_LIST_LIMIT
                ? `  …ほか ${manager.waiting.length - MANAGER_WAITING_LIST_LIMIT} 件の返事待ちは省略` +
                  `（全 ${manager.waiting.length} 件。manager_send に requestId を渡せば個別に答えられる）。`
                : null,
              manager.lastReport === undefined
                ? null
                : // **時刻は既存の行に添えるだけ**（#358）。行を1本増やすと、
                  // 予算に張り付いている一覧では出る件数が減る（この道具の doc
                  // の実測を参照）。`lastReportAt` が無い行（古いデータ・版の
                  // ずれ）には何も足さない——「未受信」のような行は作らない。
                  `  直近の報告${manager.lastReportAt === undefined ? '' : `（${manager.lastReportAt} 受信）`}: ${excerptLine(manager.lastReport, LIST_REPORT_EXCERPT)}`,
              // **Issue #567**: ターンが終わっているらしいのに報告が届いて
              // いない可能性を、条件つきで添える（`describeTurnEnd` の doc）。
              // **健全なマネージャーでは `null` を返し、1文字も増えない**——
              // 予算に張り付いている一覧で行を1本増やすと出る件数が減るため
              // （すぐ上の `lastReport` 行の doc と同じ理由）。
              describeTurnEnd(manager),
              // **Issue #572**: 「道具の応答待ちのまま、誰も待っていない」という
              // 矛盾を、条件つきで添える（`describeToolUseStall` の doc）。
              // **`describeTurnEnd` とは同時に出ない**——あちらは末尾の
              // `stop_reason` が `tool_use` **以外**のとき、こちらは `tool_use`
              // のときにだけ材料が立つ（`ManagerPool#probeTurnEndOf` の doc）。
              // **健全なマネージャーでは `null` を返し、1文字も増えない。**
              // **返事待ち（`waiting`）が在るものにも出さない**——それは届いて
              // いて、クローンがまだ答えていないだけの正常な状態である。
              describeToolUseStall(manager),
            ],
          }),
        );
        return text(
          [
            // **本数は一覧の外に出す。** 一覧は予算で打ち切られる（すぐ下の
            // `omitted`）ので、**出ている行を数えても全体の本数にはならない。**
            // クローンは実際にこれで誤り、「いま走っている」を数え上げて
            // 終わった仕事へ委譲を重ねかけた。切られない場所に置くこと。
            describeManagerCounts(managers),
            renderListing(items, {
              budget: LIST_BUDGET,
              omitted: ({ rest, total }) =>
                `…ほか ${rest} 件は省略（全 ${total} 件）。走っているものから順に出している。`,
            }),
            '（依頼と報告は抜粋。全文は manager_report <managerId> で取れる）',
            inboxBacklog,
            runnerBacklog,
          ]
            .filter((line): line is string => line !== null)
            .join('\n'),
        );
      },
    ),

    /**
     * 一覧を抜粋にした以上、**全文への行き先が要る。**
     *
     * 人間は Web UI と `GET /managers/:id/transcript` で全文を読める。クローンに
     * 同じ手が無いまま抜粋だけにすると、削っただけになる（north_star 禁止1）。
     * 長ければ切って捨てるのではなく、`offset` で続きを取れる形にする。
     */
    tool(
      'manager_report',
      [
        'マネージャーの依頼文・直近の報告を全文で読む。',
        'manager_list は抜粋なので、欠落に気づいたらここで全部読むこと。',
        '長い場合は続きの取り方が末尾に出るので、最後まで読み切ること。',
        'それでも足りない（報告に書かれていない中身を確かめたい）ときは manager_transcript で生ログまで降りられる。',
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
          .int()
          .min(0)
          .optional()
          .describe('何文字目から読むか。前回の応答が示した続きの位置を渡す'),
      },
      async ({ managerId, part = 'report', offset = 0 }) => {
        if (!context.managers) return NO_POOL;
        const managers = await context.managers.list();
        const found = managers.find((manager) => manager.managerId === managerId);
        if (!found) {
          return text(
            `マネージャー ${managerId} は居ない（もう畳まれたか、id が違う）。` +
              'manager_list で今あるものが見える。',
          );
        }

        const body = part === 'request' ? found.request : found.lastReport;
        if (body === undefined || body.length === 0) {
          if (part === 'request') {
            return text(`マネージャー ${managerId} の依頼文が記録に無い。`);
          }
          // #323: 依頼文（part === 'request'）では見に行かない——往復を無条件に
          // 増やさない。「報告はまだ無い」を返す直前、report のときだけ生ログを
          // 見て「まだ書いていない」と「書いたのに届いていない」を分ける。
          return text(await describeMissingReport(context.managers, managerId, found.status));
        }

        const label = part === 'request' ? '依頼文' : '直近の報告';
        const part1 = page(body, offset, REPORT_PAGE);
        const head = `マネージャー ${managerId} の${label}（${describePage(part1)}）`;
        const tail = part1.more
          ? `\n\n…（ここで切れている。続きは manager_report managerId=${managerId}` +
            `${part === 'request' ? ' part=request' : ''} offset=${part1.to}）`
          : '';
        // **一本道であることを、道具の出力自身が案内する**（docs/PRD.md「セッション
        // ログの層」— 日報だけで暮らせるが、掘れば生ログまで一本道で降りられること）。
        // ここに載る `lastReport` は報告の全文であって、セッションの生ログではない。
        // それでも足りないときの次の一手を、切れていない場合にも常に添える。
        const footer =
          '\n\n（さらに掘るなら manager_transcript managerId=' + managerId + ' で生ログへ）';
        return text(`${head}\n\n${part1.body}${tail}${footer}`);
      },
    ),

    /**
     * 人間との会話を、日誌から読み返す道具。
     *
     * **逐語はもう日誌に残っている。読む口が無かっただけである**（`conversation.ts`
     * の冒頭）。`journal_read` は `types` でしか絞れないので `exchange` に絞っても
     * manager / self との往復に埋もれ、人間の発言は窓の外へ押し出されて見えなく
     * なる。ここでは `with: 'human'` の exchange だけを会話へ畳み直し、
     * `speaker: 'human'` で人間自身の発言だけに絞れるようにする——要約に潰された
     * 後でも、逐語はここから読み返せる。
     *
     * **形は `journal_read` をそのまま踏襲する。新しい契約を作らない。** `id` で
     * 1件の全文、それ以外は予算を先に決めて入るところまで積む一覧。切ったら
     * 必ず言い、遡った件数と先頭に届いたかを必ず出す（`app.ts` の `/conversations`
     * と同じ判断——遡り切れていない窓で「無い」と言い切らない）。
     */
    tool(
      'conversation_read',
      [
        '人間との会話を日誌から読み返す。要約に潰された後でも逐語はここに残っている。',
        'conversationId を指定するとその会話の中身を古い順に読める。',
        'q だけを指定すると窓の中を語で探す（新しい順）。',
        '何も指定しなければ会話の一覧（新しい順）。',
        '人間自身の発言だけを見るなら speaker: "human" を指定する',
        '（既定 both は人間とクローンの両方の発言を含む）。',
        '一覧の本文は抜粋で、全文が要る1件は id を渡して取る。',
        '**ここに出ないもの**（知らずに引くと「無かった」と読むので、先に言う）:',
        '① **ask_human への人間の回答は、この道具では出ない。**',
        '回答の本文は日誌の escalation にしか無いので journal_read types=["escalation"] で読むこと',
        '（approvals_list では出ない。あれは**まだ答えが来ていない件**だけを出す口で、答えの本文を持たない）。',
        '② 人間がマネージャーへ直接話しかけた発言も出ない',
        '（日誌には with:"manager" として載り、あなた自身の指示と見分けが付かない）。',
      ].join(' '),
      {
        conversationId: z
          .string()
          .optional()
          .describe('この会話の中身を古い順に読む（一覧に出ている conversationId）'),
        q: z
          .string()
          .optional()
          .describe('語で探す（大文字小文字を区別しない部分一致）。conversationId と併用できる'),
        speaker: z
          .enum(['human', 'clone', 'both'])
          .optional()
          .describe('既定 both。human で人間自身の発言だけ（clone はクローンの返答だけ）'),
        since: z
          .string()
          .optional()
          .describe('ISO 8601。この時刻以降だけ返す（例 2026-08-15T09:00:00Z）'),
        until: z
          .string()
          .optional()
          .describe('ISO 8601。この時刻以前だけ返す。過去を掘るときはこれを指定する'),
        scan: z
          .number()
          .int()
          .min(1)
          .max(10_000)
          .optional()
          .describe(
            '人間との往復を何件遡るか（既定 2000。マネージャーとの往復・内部ターンは' +
              '数えない。issue #418）。遡り切れたかは応答の注記で分かる',
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe('一覧モードで返す会話の本数（既定 20）。conversationId / q のときは効かない'),
        id: z
          .string()
          .optional()
          .describe('この発言1件を全文で読む（一覧に出ている id）。他の条件は無視される'),
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('id で全文を読むとき、何文字目から読むか'),
      },
      async ({
        conversationId,
        q,
        speaker = 'both',
        since,
        until,
        scan,
        limit,
        id,
        offset = 0,
      }) => {
        // --- 全文モード（発言1件） ---
        if (id !== undefined) {
          const entry = await stores.journal.get(id);
          if (!entry) return text(`発言 ${id} は無い（id が違うか、まだ書かれていない）。`);
          if (entry.type !== 'exchange' || entry.with !== 'human') {
            return text(
              `${id} は会話の発言ではない。日誌の中身を見るなら journal_read id=${id} を使うこと。`,
            );
          }
          const part = page(entry.text, offset, CONVERSATION_PAGE);
          const tail = part.more
            ? `\n\n…（ここで切れている。続きは conversation_read id=${entry.id} offset=${part.to}）`
            : '';
          return text(
            `${entry.at} [${roleLabel(entry.role)}] id=${entry.id}（${describePage(part)}）` +
              `\n\n${part.body}${tail}`,
          );
        }

        // --- ここから一覧系。まず窓を取り、遡った件数と先頭到達を毎回言う ---
        const scanLimit = scan ?? 2000;
        /**
         * 窓の組み立ては `readConversationWindow` 1か所に閉じる（issue #418）。
         * `types: ['exchange']` と `with: ['human']` をここで手組みし直さない
         * — 手組みし直した場所ができるたびに `with` を絞り忘れる余地が生まれる
         * （`GET /conversations` / `GET /conversations/:id` と同じ理由）。
         */
        const entries = await readConversationWindow(stores.journal, {
          scan: scanLimit,
          ...(since === undefined ? {} : { since }),
          ...(until === undefined ? {} : { until }),
        });
        // **`since` を渡されたら「先頭に届いた」とは言えない。**
        //
        // `reachedStart` が答えるのは「ストアが行を出し切ったか」だけである。
        // ところが `since`（と #418 で足した `with`）は LIMIT より先に効く
        // （fs / pg / memory とも WHERE → LIMIT の順。`storage-pg/src/journal.ts`
        // は `where()` の後に `.limit()` を呼ぶ）ので、件数が `scan` に届かないのは
        // 「日誌の先頭まで見た」ではなく「`since` より新しい範囲を出し切った」
        // でしかない。**ここを混ぜると「無い」と言い切ってしまう** —
        // 実際には `since` より古い側に在りうるのに、下の分岐が
        // 「当たる発言は無い」を選ぶ。これはこの道具が塞いでいる欠陥
        // （観測の欠落を「無い」と報告する形）そのものである。
        const exhausted = reachedStart(entries.length, scanLimit);
        const reached = exhausted && since === undefined;
        // **「日誌を」ではなく「人間との往復を」。** #418 より前は `entries` に
        // マネージャー / 内部ターンとの往復も混ざっていたので「日誌を N 件」が
        // そのまま `scan` の意味と一致していた。いまは `readConversationWindow`
        // が `with: ['human']` を先に効かせるので、`entries.length` は人間との
        // 往復の件数である——文言もそれに合わせる。
        const scanNote =
          `（人間との往復を ${entries.length} 件遡った。` +
          (reached
            ? '先頭に届いている）'
            : exhausted
              ? `since=${since} より新しい範囲は出し切ったが、それより古い側は見ていない。` +
                'since を外すか古い方へずらすこと）'
              : 'この窓より古いものは見ていない。scan を増やすか until で窓をずらすこと）');

        // --- 会話の中身（conversationId 指定、古い順） ---
        if (conversationId !== undefined) {
          const exchanges = bySpeaker(
            humanExchanges(entries).filter((entry) => entry.conversationId === conversationId),
            speaker,
          );
          const matched = (
            q === undefined ? exchanges.map(toMessage) : searchExchanges(exchanges, q)
          )
            .slice()
            .reverse(); // 新しい順で来た窓を、会話としては古い順に直す
          if (matched.length === 0) {
            return text(
              (reached
                ? `会話 ${conversationId} に当たる発言は無い。`
                : `会話 ${conversationId} は、この窓には無い（判定できない）。`) + `\n${scanNote}`,
            );
          }
          const lines = matched.map(
            (message) =>
              `${message.at} [${roleLabel(message.role)}] id=${message.id}\n` +
              `  ${excerptLine(message.text, CONVERSATION_EXCHANGE_EXCERPT)}`,
          );
          // **会話は新しい側から積む。** 表示は古い順のままだが、予算で切れるときに
          // 落とすのは古い側である（会話を開く動機はたいてい直近の続きを思い出すこと
          // で、人が chat の履歴を開くと末尾が見えているのと同じ形にしてある）。
          // 積む形そのものは `renderListingFromEnd` が持つ（一覧ごとに手で書かない）。
          return text(
            [
              renderListingFromEnd(lines, {
                budget: CONVERSATION_LIST_BUDGET,
                // **どちら側を落としたかを言う。** 「N 件省略」だけだと、続きの取り方を
                // 間違える（ここで `scan` を増やしても、落ちているのは古い側なので出てこない）。
                omitted: ({ rest, shown, total }) =>
                  `…この会話の**古い側** ${rest} 件は省略（この窓に ${total} 件あり、` +
                  `新しい側から ${shown} 件だけ出した）。古い側を見るには until で窓を古い方へずらすこと。`,
              }),
              '（本文は抜粋。全文は conversation_read id=<id> で取れる）',
              scanNote,
            ].join('\n'),
          );
        }

        // --- 語で探す（q だけ、新しい順） ---
        if (q !== undefined) {
          const exchanges = bySpeaker(humanExchanges(entries), speaker);
          const matched = searchExchanges(exchanges, q);
          if (matched.length === 0) {
            return text(
              (reached
                ? `"${q}" に当たる発言は無い。`
                : `"${q}" は、この窓には無い（判定できない）。`) + `\n${scanNote}`,
            );
          }
          const lines = matched.map(
            (message) =>
              `${message.at} [${roleLabel(message.role)}] id=${message.id}` +
              ` conversation=${message.conversationId ?? '(無し)'}\n` +
              `  ${excerptLine(message.text, CONVERSATION_EXCHANGE_EXCERPT)}`,
          );
          // 積む形そのものは `renderListing` が持つ（一覧ごとに手で書かない）。
          return text(
            [
              renderListing(lines, {
                budget: CONVERSATION_LIST_BUDGET,
                omitted: ({ rest, shown, total }) =>
                  `…ほか ${rest} 件は省略（"${q}" に ${total} 件当たり、新しい順に ${shown} 件だけ出した）。` +
                  '省いたのは**古い側**である。scan を増やしても出てこない（当たりが増えるだけで、' +
                  '切られる側は変わらない）ので、until で窓を古い方へずらすこと。',
              }),
              '（本文は抜粋。全文は conversation_read id=<id> で取れる）',
              scanNote,
            ].join('\n'),
          );
        }

        // --- 会話の一覧（新しい順） ---
        //
        // **`speaker` はここでは効かない。効かないことを黙らない。** 会話が在るか
        // どうかは誰が喋ったかで変わらない（片方だけで数えると、あるはずの会話が
        // 一覧から消える）ので無視するのが正しいが、**渡した側から見ると絞れた一覧に
        // 見える。** 渡されたのに使わなかったなら、そう言う。
        // **`limit` で落ちた分も数に入れる。** 削るのは2段（`limit` と予算）で、
        // 効く手が違う — `limit` は増やせば出るが、予算で切れているなら増やした分は
        // そのまま省略へ回る。**`slice` の後の件数だけを見ると、`limit` で消えた分が
        // 出力のどこにも現れない**（`omitted` は予算の切り口しか数えない）ので、
        // 「20 件出して、日誌の先頭に届いている」と読める応答のまま 80 件が消える。
        const allConversations = collectConversations(entries);
        const listLimit = limit ?? 20;
        const conversations = allConversations.slice(0, listLimit);
        const hiddenByLimit = allConversations.length - conversations.length;
        if (conversations.length === 0) {
          return text(
            (reached ? '会話はまだ無い。' : 'この窓には無い（判定できない）。') + `\n${scanNote}`,
          );
        }
        const lines = conversations.map(
          (conversation) =>
            `${conversation.conversationId} ${conversation.startedAt}〜${conversation.updatedAt}` +
            `（${conversation.messages} 件）\n  ${conversation.preview}`,
        );
        // **どちらの段で切れたかで、勧める手を変える。** 混ぜると効かない手を
        // 案内することになる（予算で切れているのに「limit を増やせ」と言う、など）。
        // 予算の側で切れたかどうかは `renderListing` しか知らないので、
        // 断り書きが出たことをここで受け取る。
        let cutByBudget = false;
        // 積む形そのものは `renderListing` が持つ（一覧ごとに手で書かない）。
        const body = renderListing(lines, {
          budget: CONVERSATION_LIST_BUDGET,
          // 予算が縛っている。ここまで来ると `limit` を増やしても省略へ回るだけなので、
          // `limit` で落ちた分も合わせて「古い側」として1つの数で言う。
          omitted: ({ rest, shown }) => {
            cutByBudget = true;
            return (
              `…ほか ${rest + hiddenByLimit} 件は省略（この窓に ${allConversations.length} 件あり、` +
              `新しい順に ${shown} 件だけ出した）。` +
              '省いたのは**古い側**である。limit を増やしても出てこない（予算のほうで切れているので、' +
              '増やした分がそのまま省略へ回る）ので、until で窓を古い方へずらすこと。'
            );
          },
        });
        const notes: string[] = [];
        if (!cutByBudget && hiddenByLimit > 0) {
          // 予算にはまだ余りがあり、縛っているのは `limit` である。こちらは増やせば出る。
          // **言い方は既存の一覧に寄せる（`…ほか N 件は省略`）。** 総当たりの歯が
          // 「切った」と読む語彙はそこに揃えてあり、ここへ新しい言い方を足すのは
          // 「その言い方も契約に入れる」という判断であって、通し方の調整ではない。
          // 予算の側と区別が要るのは**語ではなく勧める手**なので、そちらで分ける。
          notes.push(
            `…ほか ${hiddenByLimit} 件は省略（この窓に ${allConversations.length} 件あり、` +
              `新しい順に ${conversations.length} 件だけ出した）。` +
              '省いたのは**古い側**で、切ったのは limit=' +
              `${listLimit} である。予算にはまだ余りがあるので、limit を増やせば出る。`,
          );
        }
        notes.push('（各会話の中身は conversation_read conversationId=<id> で古い順に読める）');
        if (speaker !== 'both') {
          notes.push(
            `（speaker=${speaker} はこの一覧には効いていない。会話が在るかどうかは誰が喋ったかで` +
              '変わらないので、一覧は絞らずに出している。話者で絞るのは conversationId か q の' +
              'ときである）',
          );
        }
        notes.push(scanNote);
        return text([body, ...notes].join('\n'));
      },
    ),

    /**
     * 可観測性の最下段 — マネージャーのセッションそのものの生ログ。
     *
     * **`manager_report` に `part: 'transcript'` を足す形にはしていない。**
     * 理由は3つ:
     * (a) `null` の意味が違う — `manager_report` の「無い」は「報告がまだ無い」
     *     だが、生ログの「無い」は `ManagerPool.transcript()` の3段
     *     （走行中の runner のディスク／退避済みアーカイブ／預かった生セッション）
     *     すべてに無かったことである。
     * (b) 大きさの桁が違う — 報告は KB オーダーだが、生ログは MB になりうる
     *     （`TRANSCRIPT_PAGE` の doc）。
     * (c) 1つの道具の説明文に2つの契約を載せることになり、読む側が
     *     どちらの「無い」を見ているか分からなくなる。
     *
     * 人間の口（`GET /managers/:id/transcript`）はここでは変えない。**そちらは
     * 無加工の全文を返す**（切り詰め・ページングなし）——人間はブラウザ・
     * curl・エディタでいくらでも大きい応答を扱えるので、そこは人間側の等価性の
     * 基準のまま保つ。クローンの文脈には MCP の出力上限があるので、こちらだけ
     * ページングする（`manager_report` と同じ形）。
     */
    tool(
      'manager_transcript',
      [
        'マネージャーのセッションそのものの生ログを読む（JSONL、1行1イベント）。',
        'manager_report の報告は要約された最終報告でしかない——それでも足りないとき、',
        '実際に何が起きたか（どの道具をどう呼んだか等）を確かめるにはここまで降りる。',
        '走行中なら runner のディスクから、畳まれていれば退避済みアーカイブから、',
        'それも無ければ預かったセッションの生ログから返る（3段のどこかにあれば返る）。',
        '長ければ続きの取り方が末尾に出るので、最後まで読み切ること。',
      ].join(' '),
      {
        managerId: z.string().describe('manager_list に出ている id'),
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('何文字目から読むか。前回の応答が示した続きの位置を渡す'),
      },
      async ({ managerId, offset = 0 }) => {
        if (!context.managers) return NO_POOL;
        const body = await context.managers.transcript(managerId);
        if (body === null) {
          // **`transcript()` の `null` は2つの意味を畳んでいる** — 「そのマネージャー
          // 自体が台帳に居ない」か、「居るが3段のどこにも生ログが無い」か。
          // `ManagerPool.transcript()` の実装（`manager.ts`）はこの2つを区別する
          // 値を返してこないので、ここでも区別できない。**畳んでいることを隠さず、
          // そう書く。**
          //
          // **その先で、「まだ引き渡していない」と「引き渡せずに消えた」は
          // 言い分ける（#634）。** 上の断り（id 自体が無い場合との区別が
          // 付かない）は消さない——3つ目の「判定できない」はここでも生きて
          // いる（`describeTranscriptMissingLeg` が言えないときはそう返す）。
          return text(
            `マネージャー ${managerId} の生ログは無い。走行中の runner のディスク・` +
              '退避済みアーカイブ・預かったセッションの生ログ、3段のどこにも見当たらなかった。' +
              `（${managerId} という id 自体が台帳に無い場合と、id はあるが生ログが` +
              '一度も残らなかった場合のどちらも、この応答だけでは区別できない。' +
              'manager_list に出ているかで id の実在は別途確かめられる。）\n\n' +
              describeTranscriptMissingLeg(context.managers, managerId),
          );
        }

        const part1 = page(body, offset, TRANSCRIPT_PAGE);
        const head = `マネージャー ${managerId} の生ログ（${describePage(part1)}）`;
        const tail = part1.more
          ? `\n\n…（ここで切れている。続きは manager_transcript managerId=${managerId} offset=${part1.to}）`
          : '';
        return text(`${head}\n\n${part1.body}${tail}`);
      },
    ),

    /**
     * 器（runner）の一覧。**「増えた器をクローンが使えるようになるための前提」
     * の「見る」側。**
     *
     * 人間は増えていく runner のコンテナがいくつあり、それぞれで何本走っているかを
     * 意識できる立場にいる（設定・デプロイの画面から）。クローンにその同じ材料が
     * 無いと、`manager_start` に `runnerId` を渡す判断そのものができない
     * （north_star 禁止1）。
     */
    tool(
      'runner_list',
      [
        '委譲先の器（runner のコンテナ）がいくつあり、それぞれで何本のマネージャーが' +
          '走っているかを見る。manager_start の runnerId に渡す名前もここで分かる。',
        'ここで数えている本数はデーモンの台帳から見た数である。新しいマネージャーを' +
          'どこへ置くか（資源による自動配置）の判断が使う本数は runner 自身が /health で' +
          '名乗る別の値で、この一覧とはずれうる——混ぜて配置の判断を予測しないこと。',
        'state は5値（connecting/connected/unreachable/unusable/lost）のまま出る。' +
          'unreachable（まだ開けていない）と lost（開けていたのに黙った）は別物である。',
        // **マネージャーの状態の字面は manager_list と揃える。** 片方だけが
        // 「セッション切断」を出すと、同じ相手を2つの道具で見たクローンが
        // どちらが本当かを判定できない（#540 と同じ潰れ方）。
        '器ごとの内訳に出るマネージャーの状態は manager_list と同じ字面である' +
          '（running / running/セッション切断 / running/セッション不明）。' +
          '「セッション切断」は、その委譲にこのデーモンからもう話しかけられないという意味で、' +
          '仕事が終わったという意味ではない。',
        'デーモン自身の版と、各 runner が名乗った版（コミット sha）も出る。' +
          'デーモンと runner は別々にデプロイされるので、同じ main から起こしていても' +
          '別のコミットで走る窓がある——調べ物で「コードはこうなっている」と言う前に、' +
          'いま走っている版がその主張と同じかを見ること。',
        '版が「不明」（器が自分の版を知らない）と「未確認」（名乗りをまだ聞けていない）は' +
          '別物で、疑う先が違う（前者は器の設定、後者は登録とネットワーク）。' +
          'state が lost の器の版は黙る前に聞いた古い値である。',
        'resources: true を渡すと器ごとの pids（プロセス数）の現在値/上限も出る' +
          '（#315 案1）。**pids の現在値/上限そのものは今も器の合計である**——何が' +
          'その数を持っているかはこの2つの数字からは分からない。空き（上限 − ' +
          '現在値）も、次に何本置けるかを意味しない——実測では vitest が1本立ち' +
          '上がるだけで pids が +131 跳ねている。**対応している runner なら、' +
          'その合計の内訳（ゾンビ/生存の内訳・ゾンビの comm 別集計・いちばん古い' +
          'ゾンビの年齢）が別行で出る**（#315 の可視化）——対応していない runner' +
          '（古い版）ではこの内訳の行自体が出ない。「runner に訊けなかった」' +
          '（器が開いていない・応答が無い）と「訊けたが pids が読めない」' +
          '（cgroup を持たない器）は別の文言で出る——どちらも数字が出ない点は' +
          '同じだが、疑う先が違う。',
      ].join(' '),
      {
        fingerprints: z
          .boolean()
          .optional()
          .describe(
            '鍵とプロファイルの指紋（sha256）まで出すか。既定は出さない——' +
              '要らないものを文脈へ載せない側に倒してある。人間は Web UI の設定画面で' +
              '常に見られるので、必要になったらここを true にして開くこと。',
          ),
        resources: z
          .boolean()
          .optional()
          .describe(
            '器ごとの pids（プロセス数）と、対応している runner ならその内訳' +
              '（ゾンビ/生存の内訳・ゾンビの comm 別集計・いちばん古いゾンビの年齢）を' +
              '出すか。既定は出さない——このためにネットワーク往復を足さない側に' +
              '倒してある。頼んだときだけ各 runner の /health を叩く（#315 の可視化）。',
          ),
      },
      async ({ fingerprints, resources }) => {
        if (!context.managers) return NO_POOL;
        const overview = await context.managers.runners({
          ...(fingerprints === undefined ? {} : { fingerprints }),
          ...(resources === undefined ? {} : { resources }),
        });

        // **デーモン自身の版は、runner が0台でも出す。** 「自分は何で走っているか」は
        // 名簿の中身に依存しない事実であり、0台のときに落とすと、配線がまだ無い状態
        // （まさに版を確かめたい状態）でだけ答えが消える。
        const daemonLine = `デーモン（あなた自身が居るプロセス）の版: ${describeRevisionStatus(
          overview.daemonRevision,
        )}`;

        if (overview.runners.length === 0) {
          return text(
            '登録されている runner は0台である（設定に ALTEROID_RUNNER_URLS 等が無いか、' +
              `まだ配線されていない）。\n${daemonLine}`,
          );
        }

        const head: string[] = [
          // **1台のときにそう言う。** 言わないと「分散していない」ことが読み取れず、
          // 複数台に散っていると誤読されうる（依頼者からの明示要求）。
          overview.runners.length === 1
            ? 'runner は1台のみ登録されている（分散していない）。'
            : `runner は${overview.runners.length}台登録されている。`,
          // **デーモンと runner の版を同じ出力に並べる。** 別々の口に出すと、突き合わせ
          // 忘れがそのまま見逃しになる（`RunnerFleetOverview.daemonRevision` の doc）。
          // 2つの Service は別々にデプロイされるので、ずれている窓が実際に在る。
          daemonLine,
        ];

        // **器1台ぶんを1つのブロックにしてから予算で積む。** 行ごとに積むと、
        // 予算に当たった器が途中の1行で切れて「版が無い器」に見える。
        const blocks: string[] = [];
        for (const runner of overview.runners) {
          const lines: string[] = [];
          lines.push(
            `- ${runner.label} [${runner.state}]` +
              (runner.runnerId === undefined
                ? '（runnerId は未確定。まだ名乗っていない）'
                : ` runnerId=${runner.runnerId}`),
          );
          if (runner.workspacePath !== undefined)
            lines.push(`  workspace: ${runner.workspacePath}`);
          /*
           * **いまその名前に応えているプロセスと、それを見始めた時刻。**
           *
           * `runnerId` は器を作り直しても同じなので、名前だけでは「自分が委譲を
           * 置いた器がまだ同じプロセスか」が言えない。入れ替わっていれば、そこで
           * 走っていた委譲は失われている可能性がある — その判断材料である。
           *
           * **名乗らないことを黙らせない。** 出さないと、クローンからは
           * 「入れ替わっていない」と「判定できない」が同じに見える。
           */
          lines.push(
            runner.instanceId === undefined
              ? '  応えているプロセス: 名乗っていない（この器では入れ替わりを判定できない）'
              : `  応えているプロセス: ${runner.instanceId}` +
                  (runner.instanceSince === undefined ? '' : `（${runner.instanceSince} から）`),
          );
          /*
           * **版は「どのプロセスか」の隣に置く。** この2つは別の問いに答える —
           * 上は「自分が委譲を置いた器がまだ同じプロセスか」、こちらは「そのプロセスが
           * どのコミットのコードで走っているか」である。器を作り直さずにデプロイし
           * 直せば両方変わり、器だけ再起動すれば `instanceId` だけが変わる。
           * **並べて置かないと、どちらか片方でもう片方を推測することになる。**
           *
           * そして `known` は「最後に聞けた名乗り」であって「いま走っている版」では
           * ないので（`RunnerRevisionStatus` の doc）、state から遠い場所に出すと
           * `lost` の器の古い値が現役の版として読まれる。
           */
          lines.push(`  版: ${describeRevisionStatus(runner.revision)}`);
          if (runner.error !== undefined) lines.push(`  直近の失敗: ${runner.error}`);
          // **内訳は件数で切る。** 切っても能力は落ちない——同じものを
          // `manager_list` が予算つきで持っている。切ったことは必ず言う。
          if (runner.managers.length === 0) {
            lines.push('  マネージャー: 無し');
          } else {
            const shown = runner.managers.slice(0, RUNNER_MANAGER_LIST_LIMIT);
            const rest = runner.managers.length - shown.length;
            lines.push(
              `  マネージャー(${runner.managers.length}): ` +
                // **字面は `describeManagerState` から取る（唯一の生成元）。**
                // `m.status` をそのまま書くと、`manager_list` が区別している
                // 「走行中」と「走行中だがセッション切断」がここでだけ潰れ、
                // 同じ状態が2つの道具で違う字面になる（#540 が digest で直した
                // のと同じ潰れ方が、この一覧に残っていた）。
                shown
                  .map((m) => `${m.managerId}[${describeManagerState(m.status, m.live)}]`)
                  .join(', ') +
                (rest === 0 ? '' : `, …ほか ${rest} 本は省略（manager_list で全部見える）`),
            );
          }
          // **表示そのものを引数で二重に締める。** 値を取ってくるかどうかは
          // `ManagerPool.runners()` 側（`options.fingerprints`）が決めるが、ここでも
          // `fingerprints === true` のときしか出さない——どちらか片方が緩んでも
          // 既定で漏れない（多重防御。値そのものは sha256 のままで、素の鍵は運ばない）。
          if (fingerprints === true && runner.credentials !== undefined) {
            lines.push(
              runner.credentials.length === 0
                ? '  鍵: 無し'
                : `  鍵の指紋: ${excerptLine(
                    runner.credentials.map((c) => `${c.name}=${c.sha256}`).join(', '),
                    RUNNER_CREDENTIAL_FINGERPRINT_EXCERPT,
                  )}`,
            );
          }
          if (fingerprints === true && runner.profile !== undefined) {
            lines.push(`  プロファイルの指紋: ${runner.profile.sha256}`);
          }
          /*
           * **pids（#315 案1）。3つの状態を混ぜない。**
           *
           * 1. 読めた — `runner.resources.pids` が在る
           * 2. runner に訊けなかった — `runner.resources` 自体が `undefined`
           *    （器が開いていない・`resources()` が失敗した）
           * 3. 訊けたが pids が読めない — `resources` は在るが `pids` が無い
           *    （cgroup を持たない器。フォールバック先が無い——
           *    `runner-resources.ts` の doc）
           *
           * 2 と 3 は同じ「数字が出ない」結果だが、疑う先が違うので同じ文言に
           * 倒さない。
           *
           * **「言えないこと」は器ごとに繰り返さず、一覧の末尾に1度だけ出す**
           * （下の `tail`）。器の台数ぶん同じ3行を並べると、断りの長さが本体を
           * 上回り、**読み飛ばされる側に倒れる**——`.claude/skills/
           * listing-and-detail` が一覧に予算を持たせているのと同じ理由である。
           * 数字と断りが離れることになるが、**断りが出なくなるわけではない**
           * （`resources: true` のときは必ず末尾に出る）。
           */
          if (resources === true) {
            if (runner.resources === undefined) {
              lines.push('  pids: runner に訊けなかった（器が開いていない、または応答が無い）');
            } else if (runner.resources.pids === undefined) {
              lines.push('  pids: 訊けたが読めない器だった（cgroup を持たない。ローカル開発など）');
            } else {
              const { current, max } = runner.resources.pids;
              lines.push(`  pids: ${current} / ${max}`);
              /*
               * **内訳（#315 の可視化）。** `tasks` は runner が `/proc` を
               * state 別に集計したもので、`pids.current` と厳密には一致しない
               * （`runnerExecutionResourcesSchema` の `tasks` の doc——測る主体
               * が走査中に増減するので1〜数本ずれる）。
               *
               * **`tasks` が無い runner（古い版）ではこの行を出さない。**
               * 「0」でも「unknown」でもなく、行そのものを省く——この一覧が
               * 守っている「読めた/訊けなかった/読めない器」の3状態を、ここで
               * 新しく混ぜない。
               */
              const { tasks } = runner.resources;
              if (tasks !== undefined) {
                const aliveThreads = tasks.threads - tasks.zombies;
                const aliveProcesses = tasks.processes - tasks.zombies;
                lines.push(
                  `    内訳: ゾンビ ${tasks.zombies} / 生存 ${aliveThreads}` +
                    `（${aliveProcesses}プロセス）`,
                );
                if (tasks.zombieCommands !== undefined && tasks.zombieCommands.length > 0) {
                  lines.push(
                    `    ゾンビの comm: ${tasks.zombieCommands
                      .map((entry) => `${entry.command} ${entry.count}`)
                      .join(', ')}`,
                  );
                }
                if (tasks.oldestZombieSeconds !== undefined) {
                  lines.push(
                    `    いちばん古いゾンビ: ${describeZombieAge(tasks.oldestZombieSeconds)}`,
                  );
                }
              }
            }
          }
          blocks.push(lines.join('\n'));
        }

        const tail: string[] = [];
        // **pids を出したなら、その数字が言えないことを必ず添える（#315）。**
        // 計器に「この数字が言えないこと」を貼るのは、この repo が繰り返している
        // 作法である（`.github/workflows/ci.yml` の OpenAPI 検査の doc）。
        // **言えないことを書いていない計器は、読む側が言えると思い込む。**
        if (resources === true) {
          tail.push(
            'pids について: **pids の現在値/上限そのものは今も器の合計であって内訳ではない。** ' +
              'この2つの数字だけからは、何がその数を持っているかは分からない。' +
              '**対応している runner なら、その内訳（ゾンビ/生存・ゾンビの comm 別・' +
              'いちばん古いゾンビの年齢）が器ごとのブロックに出る**（#315 の可視化。' +
              '対応していない runner——古い版——では内訳の行自体が出ない）。' +
              '**空き（上限 − 現在値）は「次に何本置けるか」を意味しない**——実測では ' +
              'vitest が1本立ち上がるだけで pids が +131 跳ねている。',
          );
        }
        if (overview.unassigned.length > 0) {
          const shown = overview.unassigned.slice(0, RUNNER_MANAGER_LIST_LIMIT);
          const rest = overview.unassigned.length - shown.length;
          tail.push(
            `どの器か分からない: ${overview.unassigned.length}件（` +
              // 器ごとの内訳と同じ生成元を通す（上の doc と同じ理由）。
              shown
                .map((m) => `${m.managerId}[${describeManagerState(m.status, m.live)}]`)
                .join(', ') +
              (rest === 0 ? '' : `, …ほか ${rest} 本は省略（manager_list で全部見える）`) +
              '）。runnerId が記録されていない古いマネージャーで、どの器の内訳にも混ぜていない。',
          );
        }

        return text(
          [
            ...head,
            renderListing(blocks, {
              budget: RUNNER_LIST_BUDGET,
              omitted: ({ rest, shown, total }) =>
                `…ほか ${rest} 台は省略（登録は ${total} 台あり、${shown} 台だけ出した）。`,
            }),
            ...tail,
          ].join('\n'),
        );
      },
    ),
  ];
}

/**
 * `manager_list` の先頭に出す本数の内訳。
 *
 * **「いま何本走っているか」を、一覧を数えて答えさせない。** 一覧は文字数の
 * 予算で打ち切られるので（`LIST_BUDGET`）、出ている行を数えた数は全体の
 * 本数ではない。そして `status` だけを数えると必ず上振れする——**`running`
 * は終端へ勝手には行かない。** ターンを報告で終えた委譲は `done` になるが、
 * 宛先の器が黙って消えた委譲を `running` から動かす経路はデーモンに無い
 * （周期的な棚卸しは存在せず、`onLost` は台帳を書き換えない）。**それは
 * 欠陥ではなく、`live` が在る理由そのものである** — 「戻れなかった」と
 * 確かめていないものを `lost` と名乗らせない代わりに、話しかけられるかを
 * 別の軸で持つ（`manager.ts` の `isLive()` / `ManagerSummary.live`）。
 *
 * **⚠️ ただし、その補いは長らく効いていなかった。** `isLive()` が見ていたのは
 * `status` / `attached` / `sessionId` の3つだけで、**どれもイベント駆動でしか
 * 更新されない** — 器が合図を送らずに消えると `attached` は `true` のまま
 * 残り、`live` もろとも上振れした。いまは名簿が10秒ごとの生存確認で立てた
 * 判定（`state: 'lost'`）も材料にしているので、**黙った器に載っている委譲は
 * `live: false` へ倒れる**（`manager.ts` の `#silentRunners()`）。
 *
 * **それでも `live` は「進んでいるか」ではない。** 器が生きていて合図も届いて
 * いるのに手が止まっている委譲（拒否で詰まった分など）は `live: true` のまま
 * である。この一覧が答えられるのは「話しかけられるか」までである。
 *
 * **だから数えるときも2軸で数える。** 「走行中」の本数だけを出すと、
 * この一覧は上振れした数を自分の口で名乗ることになる。
 *
 * **0 の行は作らない**（AGENTS.md の地雷表）。無い区分は書かない——
 * 「切断 0本」と書くと、切断を観測して 0 だったのか、そもそも数えていない
 * のかが読めなくなる。
 */
function describeManagerCounts(managers: readonly ManagerSummary[]): string {
  const live = managers.filter((m) => m.live).length;
  const parts = [`全 ${managers.length} 本`];
  const running = managers.filter((m) => m.status === 'running');
  if (running.length > 0) {
    const reachable = running.filter((m) => m.live).length;
    parts.push(`走行中 ${running.length} 本（うち話しかけられる ${reachable} 本）`);
  }
  // **0 の行は作らない**（上の doc と同じ理由）。黙った器が1台も無いのか、
  // そもそも数えていないのかを読めなくしないため、在るときだけ書く。
  const orphaned = managers.filter((m) => m.runnerLostSince !== undefined).length;
  if (orphaned > 0) parts.push(`宛先の器が名乗らなくなった ${orphaned} 本`);
  // **同上（#563）。「器が黙った」とは別の区分である** — こちらは器が答えたうえで
  // この委譲を一覧に載せなかった回で、`live` は落ちない（`sessionId` が在れば
  // resume から入り直せる）。畳むと打つ手が変わる（器の側を見るのか、送り直すのか）。
  const sessionMissing = managers.filter((m) => m.sessionMissingSince !== undefined).length;
  if (sessionMissing > 0) parts.push(`runner にセッションが無い ${sessionMissing} 本`);
  const waiting = managers.filter((m) => m.status === 'waiting_human').length;
  if (waiting > 0) parts.push(`返事待ち ${waiting} 本`);
  return (
    `件数: ${parts.join(' / ')}。話しかけられる委譲は全体で ${live} 本である。` +
    '**「走行中」は「進んでいる」ではない** — 宛先の器が黙って消えても ' +
    'status は running のままで、それを終端へ動かす経路はデーモンに無い。' +
    'いま何本動いているかを数えるなら、走行中の本数ではなく' +
    '「話しかけられる」ほうを見ること。'
  );
}

/** 会話の発言の `role` を人が読める形にする（`conversation_read` 専用）。 */
function roleLabel(role: 'inbound' | 'outbound'): string {
  return role === 'inbound' ? '人間' : 'クローン';
}

/**
 * 日誌1件を「見出し」と「本文」に分ける。
 *
 * **見出しには、探すのに要るものだけを置く。** 日誌を引くのは特定の1行を
 * 探すためなので、*いつ・誰が・どの型か*が残っていれば当たりは付けられる。
 * 本文（長くなりうる側）だけを抜粋の対象にし、見出しは削らない。
 */
function renderJournalEntry(entry: JournalEntry): { head: string; body: string } {
  switch (entry.type) {
    case 'exchange': {
      const conversation =
        entry.conversationId === undefined ? '' : ` conversation=${entry.conversationId}`;
      return { head: `[exchange ${entry.with}/${entry.role}]${conversation}`, body: entry.text };
    }
    case 'decision':
      return { head: '[decision]', body: `${entry.decision}（根拠: ${entry.grounds}）` };
    case 'escalation': {
      const to = entry.managerId === undefined ? '' : ` manager=${entry.managerId}`;
      const answered = entry.answeredAt === undefined ? '未回答' : `回答済み ${entry.answeredAt}`;
      return {
        head: `[escalation approval=${entry.approvalId}${to} ${answered}]`,
        body: entry.answer === undefined ? entry.question : `${entry.question} → ${entry.answer}`,
      };
    }
    case 'tool_use':
      return {
        head: `[tool_use ${entry.actor} ${entry.tool}]`,
        body: safeJson(entry.input),
      };
    case 'memory_update': {
      // **単位はバイトである**（`schema.ts` の `bytesBefore`/`bytesAfter` の
      // doc — `Buffer.byteLength` 相当）。`entry.summary` 側に文字数が
      // 埋め込まれていること（`memory_delete` の「削除直前 N 文字」）があるので、
      // バイトの表示はここでは `head` に置き、文字を含みうる自由文（`summary`）は
      // `body` のまま分ける——1行・1文にバイトと文字を混ぜない（#318 のコメントで
      // 実際に読み違いが起きている）。
      //
      // **`action` と `bytesBefore`/`bytesAfter` は `optional`。** この区別が
      // 導入される前の古いエントリでは両方とも無い。無いことを `0` として
      // 出すと「変化が無かった」と読める（AGENTS.md の地雷表「取れない軸に
      // 0 の行を作る」）ので、値が無いときは「不明」と明示する——省いて
      // 黙らせると、バイトが出ている行と出ていない行が混ざったとき
      // 「変化なし」に読めてしまう。
      const action = entry.action === undefined ? '' : ` ${entry.action}`;
      const bytes =
        entry.bytesBefore === undefined || entry.bytesAfter === undefined
          ? ' bytes=不明(旧形式)'
          : ` bytes=${entry.bytesBefore}→${entry.bytesAfter}`;
      return {
        head: `[memory_update ${entry.slug} (${entry.cause})${action}${bytes}]`,
        body: entry.summary,
      };
    }
    case 'daily_report':
      return { head: `[daily_report ${entry.date}]`, body: entry.body };
    case 'external_event':
      return { head: `[external_event ${entry.source}]`, body: entry.summary };
    case 'worker_wait': {
      const cause = entry.byCause;
      return {
        head: `[worker_wait tasks=${entry.tasks} turns=${entry.turns} settled=${entry.settled}]`,
        body:
          `作業者 ${entry.tasks} 体を待つあいだに ${entry.turns} ターン` +
          `（通知 ${cause.notification} / 自己継続 ${cause.continuation} / 話しかけ ${cause.input}）。` +
          `うち ${entry.toolless} ターンは道具を1つも動かしていない。` +
          `UserPromptSubmit の発火は ${entry.submits} 回` +
          (entry.sources === undefined
            ? '（source は取れていない）'
            : `（内訳: ${Object.entries(entry.sources)
                .map(([source, count]) => `${source}=${count}`)
                .join(', ')}）`) +
          '。',
      };
    }
    case 'turn_usage': {
      // **キャッシュの書き直しを目で分かる形にする**（潰すと測る意味が消える。
      // PR「なぜ台帳ではなく日誌なのか」）。数え直しの印は一覧の head にも
      // 出す — 印の行を一覧から隠さない（`worker_wait` の `settled: false` の
      // 扱いと同じ考え方）。
      const modelLines = Object.entries(entry.models)
        .map(([model, totals]) => {
          const cache =
            totals.cacheReadInputTokens === 0 && totals.cacheCreationInputTokens === 0
              ? ''
              : ` cache(read=${totals.cacheReadInputTokens} write=${totals.cacheCreationInputTokens})`;
          return (
            `${model}: ${formatUsd(totals.costUsd)}${cache} ` +
            `in=${totals.inputTokens} out=${totals.outputTokens}`
          );
        })
        .join('\n');
      const resetLine =
        entry.reset === undefined
          ? ''
          : `\n⚠ 数え直しを挟んだ回（${formatUsd(entry.reset.fromCostUsd)} → ` +
            `${formatUsd(entry.reset.toCostUsd)}）。models は差分ではなく新しい累積の先頭 — ` +
            '他の行と足し合わせると二重に数える。';
      return {
        head:
          `[turn_usage ${entry.layer}/${entry.site} ${entry.managerId}]` +
          (entry.reset === undefined ? '' : ' ⚠reset'),
        body: `${modelLines}${resetLine}`,
      };
    }
    case 'token_rotation': {
      // **見出しに `event` を出す。** クローンがこの種別で絞ったとき、いちばん
      // 見たいのは「回ったのか」であって本文の言い回しではない。**とくに
      // `exhausted`（回そうとしたが候補が無かった ＝ 全層が止まる）を、
      // `not_rotated`（契機ではなかった ＝ 正常）と同じ顔にしない。**
      const where =
        entry.tokenId === undefined
          ? ''
          : ` → ${entry.tokenId}${entry.label === undefined ? '' : `「${entry.label}」`}`;
      const gen = entry.generation === undefined ? '' : ` 世代${String(entry.generation)}`;
      // **`earliestAt` が無いことを「すぐ戻る」と読ませない。** 無いのは
      // 「戻る見込みの立っている候補が1本も無い」ときである。
      const earliest =
        entry.event !== 'exhausted'
          ? ''
          : entry.earliestAt === undefined
            ? '\n⚠ 戻る見込みの立っている候補が1本も無い（プールが空か、全部外されている）'
            : `\nいちばん早く戻るのは ${entry.earliestAt}`;
      return {
        head:
          `[token_rotation ${entry.event}` +
          (entry.signal === undefined ? '' : ` ${entry.signal}`) +
          (entry.freshness === undefined ? '' : `/${entry.freshness}`) +
          `${gen}]${where}`,
        // **本文は整形済みの行をそのまま出す。** ここで組み直すと、人間が読む面
        // （stderr / Web）と言い方が分かれる（`text` の持ち主は `token-rotator.ts`
        // の `describeTokenRotation` 1つである）。
        body: `${entry.text}${earliest}`,
      };
    }
  }
}

/** 日誌に入った任意の値を文字列にする（循環参照でも読み手を落とさない）。 */
function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * 台帳の集計をクローンが読める形へ。
 *
 * **落としたら落としたと言う。** 日数やマネージャーの本数に比例して伸ばすと MCP の
 * 出力上限を超え、そのときクローンには1文字も届かない（実測 52,997 文字で溢れた）。
 * だから軸ごとに上限を置くが、**打ち切ったことを必ず書く** — 「全部でこれだけ」と
 * 読める出力を黙って作ると、それは嘘になる。
 */
const USAGE_AXIS_LIMIT = 14;

/**
 * 軸の名前。**打ち切りから続きへ辿るための識別子でもある**（`axis` 引数）。
 *
 * 「全部出す」は採らない — 出力が伸びるとクローンの入力を毎ターン食う。代わりに
 * **打ち切りの行がそのまま次に打つ手を書く。**
 */
const USAGE_AXES = ['date', 'manager', 'model', 'layer', 'site', 'token'] as const;
type UsageAxis = (typeof USAGE_AXES)[number];

/** `axis` を指定したときに1回で出す件数。 */
const USAGE_AXIS_PAGE = 100;

const USAGE_AXIS_TITLES: Record<UsageAxis, string> = {
  date: '日別',
  manager: 'マネージャー別',
  model: 'モデル別',
  layer: '層別（誰が）',
  site: '場所別（どこで）',
  token: '認証トークン別',
};

interface UsageAxisEntry {
  label: string;
  totals: UsageTotals;
}

/**
 * 軸ごとの並びを1か所へ寄せる。**まとめ表示と `axis` モードが同じここを通ること。**
 *
 * まとめ表示の先頭 N 件と `axis` モードの `offset=0..N` が同じ並びでなければ、
 * ページングは取りこぼすか重複する。
 *
 * **全順序にする。** 費用の降順だけだと同額のときの順序が `groupBy` の `Map` の
 * 挿入順に依存する（いまは安定ソートの結果としてラベル昇順に落ちているが、それは
 * 実装の偶然である）。「費用降順 → ラベル昇順」を約束にすると結果は変わらないまま
 * ページングの前提が成り立つ。
 */
function usageAxisEntries(summary: UsageBreakdown, axis: UsageAxis): UsageAxisEntry[] {
  const byCost = (entries: UsageAxisEntry[]) =>
    entries.sort((a, b) => b.totals.costUsd - a.totals.costUsd || a.label.localeCompare(b.label));
  switch (axis) {
    case 'date':
      // 日別は新しい順（古い日で上限を使い切らせない）。日付そのものが全順序である。
      return summary.byDate
        .map((entry) => ({ label: entry.date, totals: entry.totals }))
        .sort((a, b) => b.label.localeCompare(a.label));
    case 'manager':
      return byCost(summary.byManager.map((e) => ({ label: e.managerId, totals: e.totals })));
    case 'model':
      return byCost(summary.byModel.map((e) => ({ label: e.model, totals: e.totals })));
    case 'layer':
      return byCost(summary.byLayer.map((e) => ({ label: e.layer, totals: e.totals })));
    case 'site':
      return byCost(summary.bySite.map((e) => ({ label: e.site, totals: e.totals })));
    case 'token':
      // **`null` を「記録が無い」と書く。id を捏造しない。** ここが空文字や
      // `'unknown'` になると、クローンからは1本のトークンとして見え、費用を
      // そこへ帰属させた話が始まる（`usage.ts` の `usageBreakdownSchema`）。
      return byCost(
        summary.byToken.map((e) => ({
          label: e.tokenId ?? '（トークンの帰属が無い分）',
          totals: e.totals,
        })),
      );
  }
}

/**
 * アカウント全体の残り（クローンが読む形）。
 *
 * **文言は `usage-format.ts` の `describeAccountUsage` が持つ。** ここに書き写すと、
 * 同じ値を見る4つの口（クローンの道具・CLI 2つ・Web）で言い方が分かれ、いつか
 * 片方だけが「取れなかった」を 0 と描く。ここがやるのは見出しを付けることだけで、
 * クローンの文脈は Markdown なので強調はそのまま残す。
 */
function renderAccountUsage(state: AccountUsageState): string {
  return [`## ${ACCOUNT_USAGE_TITLE}`, ...describeAccountUsage(state)].join('\n');
}

/**
 * 台帳に1行も無い委譲（Issue #98）を、`usage_read` が読む行へ。
 *
 * **`context.managers` が `undefined` のとき、0 と出さない。** これは蒸留の
 * サイドクエリ（`clone.ts` の `#distillFromTranscript`）でだけ起こる —
 * `ToolContext.managers` はそこでは委譲そのものを起こさせないために省略されて
 * いる（`ToolContext.managers` の doc）。**「確かめられなかった」と明示する**
 * ——空配列（取りこぼしが無い）と同じ形にすると、蒸留の場では常に「取りこぼしは
 * 無い」と嘘をつくことになる。
 *
 * **⚠️ `apps/daemon/src/app.ts` の `GET /usage` とは前提が違う。** そちらの
 * `clone.managers` は non-optional（`CloneHost.managers: ManagerPool`）なので、
 * この分岐に対応する枝を持たない——**app.ts 側では「確かめられなかった」は
 * 起こらない。この doc の断りは `usage_read` だけの事情である。**
 */
async function unrecordedManagersLines(
  context: ToolContext,
  stores: Stores,
  since: string | null,
): Promise<string[]> {
  if (context.managers === undefined) {
    return [
      '⚠ 台帳に1行も記録が無い委譲: 確かめられなかった' +
        '（この場ではマネージャーの一覧が読めない。0 件ではない）。',
    ];
  }
  const [managers, recordedManagerIds] = await Promise.all([
    context.managers.list(),
    stores.usage.recordedManagerIds(),
  ]);
  return describeUnrecordedManagers(findUnrecordedManagers(managers, recordedManagerIds, since));
}

function renderUsage(
  aggregate: UsageAggregate,
  view: {
    axis?: UsageAxis;
    offset?: number;
    /**
     * 台帳に1行も無い委譲（Issue #98）を、すでに整形した行として渡す。
     *
     * **`undefined` は「軸モードなので出さない」であって「取りこぼしが無い」
     * ではない。** 軸モードは「打ち切りの続き」だけを返す設計（下のコメント）
     * なので、まとめ表示・アカウント全体の残りと同じくここも出さない。
     * まとめ表示のときは、呼び出し側（`usage_read` ハンドラ）が必ず
     * {@link describeUnrecordedManagers} の結果（0件でも1行以上ある配列）を渡す。
     */
    unrecordedManagers?: readonly string[];
  } = {},
): string {
  const {
    rows,
    since,
    layersSince,
    tokensSince,
    beforeLedger,
    beforeLayers,
    beforeTokens,
    notice,
  } = aggregate;

  if (since === null) {
    return [
      '台帳にはまだ1件も記録が無い。',
      '（消費の記録はこの機能を入れた時点から始まる。それより前の分は残っていない）',
      ...(view.unrecordedManagers === undefined ? [] : ['', ...view.unrecordedManagers]),
    ].join('\n');
  }

  const summary = summarizeUsage(rows);
  const lines: string[] = [];

  if (view.axis !== undefined) {
    // **軸モードは「打ち切りの続き」を取りに来た呼び出しである。** まとめ表示も
    // 他の軸も出さない — 続きを取るたびに同じ全体が返ってくると、続きを辿るほど
    // 入力を食うことになる。
    const axis = view.axis;
    const offset = view.offset ?? 0;
    const entries = usageAxisEntries(summary, axis);
    lines.push(`${USAGE_AXIS_TITLES[axis]}（全 ${entries.length} 件 / offset=${offset}）`);
    const page = entries.slice(offset, offset + USAGE_AXIS_PAGE);
    if (page.length === 0) {
      // **黙って空を返さない。** 空の一覧だけでは「この軸には記録が無い」と
      // 「offset が範囲外」を区別できない。
      lines.push(`  （その軸は全 ${entries.length} 件で、offset=${offset} 以降は無い）`);
    } else {
      for (const entry of page) {
        lines.push(`  ${entry.label}: ${formatUsd(entry.totals.costUsd)}`);
      }
      const rest = entries.length - (offset + page.length);
      if (rest > 0) {
        lines.push(
          `  …（残り ${rest} 件は出していない。` +
            `axis="${axis}", offset=${offset + page.length} で続きが出る）`,
        );
      }
    }
  } else if (rows.length === 0) {
    lines.push('その範囲には記録が無い。');
    // **取りこぼしは照会範囲と無関係に全期間で判定する**（`findUnrecordedManagers`
    // の doc）ので、この範囲に台帳の行が無くても出す。
    if (view.unrecordedManagers !== undefined) lines.push('', ...view.unrecordedManagers);
  } else {
    lines.push(`合計 ${formatUsd(summary.total.costUsd)}`);
    lines.push(
      `  入力 ${summary.total.inputTokens.toLocaleString('en-US')} / ` +
        `出力 ${summary.total.outputTokens.toLocaleString('en-US')} / ` +
        `キャッシュ読み ${summary.total.cacheReadInputTokens.toLocaleString('en-US')} / ` +
        `キャッシュ書き ${summary.total.cacheCreationInputTokens.toLocaleString('en-US')}`,
    );
    // **合計値の隣に必ず出す（Issue #98）。**
    if (view.unrecordedManagers !== undefined) lines.push(...view.unrecordedManagers);

    for (const axis of USAGE_AXES) {
      const entries = usageAxisEntries(summary, axis);
      lines.push('', `${USAGE_AXIS_TITLES[axis]}:`);
      for (const entry of entries.slice(0, USAGE_AXIS_LIMIT)) {
        lines.push(`  ${entry.label}: ${formatUsd(entry.totals.costUsd)}`);
      }
      if (entries.length > USAGE_AXIS_LIMIT) {
        // **打ち切りの行がそのまま次に打つ手を書く。** 「残り N 件」だけでは、
        // 続きを見る方法が無いのと同じである。
        lines.push(
          `  …（残り ${entries.length - USAGE_AXIS_LIMIT} 件は出していない。` +
            `axis="${axis}", offset=${USAGE_AXIS_LIMIT} で続きが出る）`,
        );
      }
    }
  }

  lines.push('', `台帳の始点: ${since}`);
  if (beforeLedger) {
    // **0 と言わない。** 台帳が無かった期間を「使っていない期間」と読ませない。
    lines.push(
      '照会した範囲は台帳の始点より前にかかっている。その分は **0 ではなく「記録が無い」**。',
    );
  }
  // **層の始点を台帳の始点と混ぜない。** 層の軸は台帳より後から入ったので、それより
  // 前の行の層と場所は既定値であって観測ではない。
  lines.push(
    layersSince === null
      ? '層と場所の軸はまだ1件も記録していない。'
      : `層と場所の軸の始点: ${layersSince}`,
  );
  if (beforeLayers) {
    lines.push(
      '照会した範囲は層と場所の軸の始点より前にかかっている。' +
        'その分の層と場所は **既定値であって観測ではない**（クローンが使っていなかった、' +
        '蒸留が起きていなかった、とは読まないこと）。',
    );
  }
  // **トークンの軸の始点を、上の2つと混ぜない。** ここが null なのは「まだ1件も
  // 記録していない」だけではなく、**プールを使っていないので取れない**ことがある
  // （`usage.ts` の `usageAggregateSchema` の `tokensSince`）。**「トークンを回して
  // いない」と読ませないこと** — 回していないのではなく、記録が無いのである。
  lines.push(
    tokensSince === null
      ? '認証トークンの軸はまだ1件も記録していない' +
          '（プールを使っていない構成なら、これが正常である）。'
      : `認証トークンの軸の始点: ${tokensSince}`,
  );
  if (beforeTokens) {
    lines.push(
      '照会した範囲は認証トークンの軸の始点より前にかかっている。' +
        'その分に **トークンの帰属は無い**（0 でも既定値でもなく、取れていない）。',
    );
  }
  lines.push(notice);
  return lines.join('\n');
}

/**
 * self_status の記憶内訳に出す要旨（description）の抜粋上限（文字数、1行分）。
 *
 * **`memory.ts` の `MEMORY_TOC_LINE_LIMIT` を使い回さない。** 値が同じでも
 * 用途ごとに別の定数として置く（AGENTS.md「値が同じでも使い回さない。片方
 * だけ直したくなったときに一緒に動いてしまう」）。あちらはプロンプトへ焼く
 * 目次の1行、こちらは self_status という実行時ステータスの1行で、由来（誰が
 * 読むか・どの出力上限に収めるか）が違う。
 */
const SELF_STATUS_MEMORY_DESCRIPTION_LIMIT = 120;

/**
 * 記憶の文書ごとの内訳の予算（文字数）。
 *
 * **旧版は件数（`SELF_STATUS_MEMORY_DOC_LIMIT = 30`）で切っていた。** 当時の
 * 1行は `slug + bytes + 更新時刻` だけで、文書によらずほぼ一定の長さだった
 * ので件数の上限で事実上足りていた。人間の依頼（一覧系ツールは最低でも
 * id + 名前 + 概要 + updated_at + created_at）に応じて `title` と要旨
 * （description）を足すと、1行の長さが文書ごとに変わる——件数のまま
 * 30 × (可変長) にすると、何件で壊れるかが運任せになる。これは
 * `.claude/skills/listing-and-detail/SKILL.md`「予算は件数ではなく文字数で
 * 持つ」が指す形そのもの（この repo が3回踏んだバグと同じ）なので、件数の
 * 上限をやめて `renderListing` の文字数予算へ替えた。
 *
 * `MEMORY_LISTING_BUDGET`（`memory.ts`、8,000）より小さく取ってある——
 * `self_status` はこの節の前後に「実行時の事実」（`describeCloneRuntime`）と
 * 「台帳との突き合わせ」（`renderLedgerCrossReference`）の節が同居し、3節
 * 合計を `tools.test.ts` の一覧総当たり試験が定める `OUTPUT_CAP`（12,000）に
 * 収める必要があるため。値は `tools.test.ts` の `flooded(60)`（一覧が実際に
 * 溢れる量まで積んだ器）で実測して決めた——3,500 なら60文書中の一部だけが
 * 収まり、必ず省略の合図が出て、なお3節合計が `OUTPUT_CAP` に収まる。
 */
const SELF_STATUS_MEMORY_LISTING_BUDGET = 3_500;

/**
 * 記憶の大きさ。
 *
 * **「いまの総文字数」と「システムプロンプトへ焼き込んだ時点の文字数」は
 * ここでは出さない**（後者は `describeCloneRuntime` 側 — `CloneRuntimeFacts` の
 * 材料であって、記憶ストアを読み直しても変わらない値だからである）。ここが
 * 出すのは、いま `stores.persona` を読み直した時点の値だけで、会話の途中で
 * 記憶が書き換わっていれば、その場で変わる。
 *
 * **内訳の1行は人間の依頼（id + 名前 + 概要 + updated_at + created_at）の
 * 5項目を満たす。** `memory_list`（`renderMemoryListing`）と同じ語彙・同じ
 * 並び（`作成: … / 更新: …` の1文、`— 要旨` の区切り）に寄せてある——同じ
 * 依頼に対する別の一覧なので、ここだけ違う言い方を発明しない。`bytes` は
 * この節の主題（「記憶の大きさ」）なので残す。`createdAt` の整形は
 * `memory.ts` の `formatMemoryCreatedAt` をそのまま import して使う——同じ
 * 結果を返す関数を2つ書かない。
 *
 * **既存の `- 総文字数: N 文字（M 文書）` の行の文言は変えない**（歯が固定）。
 * 下で足すのは、その下に続く新しい行だけである。
 *
 * ## ⭐ 区分ごとの小計（記憶の肥大への恒久対策）
 *
 * premise 合計 / fact 目次合計は `measureMemoryFloor`（`memory.ts`）をそのまま
 * 使う——同じ計算を2本書かない。文書ごとの行にも `[premise]` / `[fact]` と
 * 文字数を足す。**`bytes` は消さない**——この節の主題は「記憶の大きさ」で、
 * bytes は実際のディスク上のサイズを言う値として引き続き意味がある。
 * **単位のラベル（文字 / bytes）を両方に必ず付ける**——旧版は総＝文字・
 * 文書ごと＝bytes で単位が混ざっており、依頼者は実際に bytes から文字数を
 * 割り戻して読んでいた。ここで bytes を隠すと、次の人がまた割り戻す。
 *
 * 文書ごとの「文字数」は `measureMemoryFloor([その1文書])` で測る——premise
 * ならその文書が単独でも実際に焼かれる全文の長さ、fact ならその1行が乗る
 * 目次（見出し込み）の長さになる。**⚠️ fact 側は目次の見出し2行ぶん
 * （`<!-- memory: index -->` と `## 記憶の目次…`）が数値に乗る**——実際の
 * 焼き込みではこの2行は全 fact で共有されるので、複数の fact を合計すると
 * `measureMemoryFloor(memoryDocuments).tocChars` より大きくなる（二重に
 * 数えているわけではなく、「この1文書だけを載せるとしたら」という単独測定
 * だからである）。**premise 同士・fact 同士の相対順序は壊れない**（全件に
 * 同じ定数が乗るだけ）ので、この節の目的（寄与の大きい順に並べ、予算で
 * 切られても最大の寄与を残す）には支障が無い。
 *
 * ## ⭐ 並びは「毎ターンの寄与が大きい順」（欠陥の修正。案の一部ではない）
 *
 * **旧版は `stores.persona.list()` が返す順（両ドライバとも slug 昇順——
 * `packages/storage-fs/src/persona.ts` の `names.sort()` /
 * `packages/storage-pg/src/persona.ts` の `orderBy(asc(memory.slug))`）の
 * まま `renderListing` へ渡していた。** 予算（`SELF_STATUS_MEMORY_LISTING_BUDGET`
 * = 3,500）に達すると、slug が後ろの文書が黙って省略される——**それがどれだけ
 * 大きい premise であっても関係なく落ちる。** 呼び手は落ちた分に気づけない
 * ＝「測れた0」ではなく「測れていない0」を、測ったつもりで読むことになる。
 *
 * **ここで寄与の大きい順に並べ替えることで直す。** `renderListing` は先頭から
 * 予算に収まるだけ積む口なので、並べ替えるだけで「省略されるのは常に寄与の
 * 小さい方から」になる。**`stores.persona.list()` 自体の並びは変えない**——
 * 他の面（`memory_list` 等）がその順に依存しているため、並べ替えは
 * ここ（`renderMemorySize` の中）だけで行う。
 */
function renderMemorySize(
  documents: MemoryDocumentMeta[],
  memoryDocuments: readonly MemoryPart[],
  totalMemory: string,
): string {
  const lines = [
    '## 記憶の大きさ（いま stores.persona を読み直した値）',
    '',
    `- 総文字数: ${totalMemory.length.toLocaleString('en-US')} 文字（${documents.length} 文書）`,
  ];
  if (documents.length === 0) return lines.join('\n');

  const floor = measureMemoryFloor(memoryDocuments);

  const contentBySlug = new Map(memoryDocuments.map((doc) => [doc.slug, doc]));
  const contribution = new Map(
    documents.map((doc) => {
      const part = contentBySlug.get(doc.slug);
      const chars = part === undefined ? 0 : measureMemoryFloor([part]).totalChars;
      return [doc.slug, chars] as const;
    }),
  );
  // ⭐ 寄与の大きい順（`Array#sort` は ES2019 以降、規格上安定ソート——
  // 同点は `stores.persona.list()` が返した元の順のまま残る）。
  const sorted = [...documents].sort(
    (a, b) => (contribution.get(b.slug) ?? 0) - (contribution.get(a.slug) ?? 0),
  );

  const items = sorted.map((doc) => {
    const descriptor =
      doc.description === undefined
        ? ''
        : ` — ${excerptLine(doc.description, SELF_STATUS_MEMORY_DESCRIPTION_LIMIT)}`;
    const chars = contribution.get(doc.slug) ?? 0;
    return (
      `  - [${doc.kind}] ${doc.slug}: ${doc.title} ` +
      `(作成: ${formatMemoryCreatedAt(doc.createdAt)} / 更新: ${doc.updatedAt}) ` +
      `${doc.bytes.toLocaleString('en-US')} bytes / ${chars.toLocaleString('en-US')} 文字${descriptor}`
    );
  });

  lines.push(
    renderListing(items, {
      budget: SELF_STATUS_MEMORY_LISTING_BUDGET,
      omitted: ({ rest, shown, total }) =>
        `  …ほか ${rest} 文書は省略（全 ${total} 文書のうち ${shown} 文書だけ出した）。` +
        '全件は memory_list、本文は memory_read slug=<slug> で取れる。',
    }),
  );
  // **区分ごとの小計は、文書一覧の後ろへ0字下げで置く。** `- 総文字数`
  // の兄弟（0字下げの箇条書き）にすることで、`tools.test.ts` の
  // `extractMemorySizeEntries`（文書一覧を2字下げの連続行として拾う総当たり
  // 試験の足場）がこの2行を「文書の1件」と誤認しない——2字下げのままだと、
  // id + 名前 / 作成 + 更新 / 概要 を持たないこの2行が総当たり試験に
  // 「5項目を満たさない文書」として撃たれる（実測済み）。
  lines.push(
    `- premise 合計: ${floor.premiseChars.toLocaleString('en-US')} 文字（${floor.premiseDocs} 文書。毎ターン全文が焼かれる）`,
    `- fact 目次合計: ${floor.tocChars.toLocaleString('en-US')} 文字（${floor.factDocs} 文書。目次の1行だけが焼かれる）`,
  );
  return lines.join('\n');
}

/**
 * SDK が実際に使っているモデル id と、台帳（`usage_read` と同じ器）を突き合わせる。
 *
 * **「あなたの消費が台帳に載っている／載っていない」と書かないこと。** 台帳の軸が
 * 変わった瞬間にその文は嘘になる。代わりに軸そのもの — 該当するモデル id の行が
 * どの `managerId` × `layer` × `site` にあるか — を構造として出す。
 *
 * **畳む鍵に層と場所を入れる。** `ALTEROID_CLONE_MODEL` を置けばクローンと
 * マネージャーは同じモデル id に並ぶので、`managerId` だけで畳むと #80 で残った
 * 「モデル名だけでは自分を見分けられない」がそのまま残る。層を鍵に入れて初めて
 * 「このモデル id の行のうち、層はこう分かれている」が見える。
 */
function renderLedgerCrossReference(
  sdkModel: string | null,
  aggregate: UsageAggregate | null,
): string {
  const lines = ['## 台帳との突き合わせ（軸: 日 × actor × モデル × 層 × 場所）', ''];

  if (sdkModel === null) {
    lines.push('まだ init を観測していないので、SDK のモデル id が分からず突き合わせられない。');
    return lines.join('\n');
  }
  if (aggregate === null || aggregate.since === null) {
    lines.push(`台帳にはまだ1件も記録が無い（いまのモデル id: ${sdkModel}）。`);
    return lines.join('\n');
  }

  const matches = aggregate.rows.filter((row) => row.model === sdkModel);
  if (matches.length === 0) {
    lines.push(`モデル id ${sdkModel} と同じ行は無い（台帳の始点: ${aggregate.since}）。`);
    return lines.join('\n');
  }

  // actor × 層 × 場所 ごとに畳む。**件数（行数）に比例して伸ばさない** — 日別の
  // 行数が増えても、出す単位はこの組み合わせの数までにとどめる。
  const buckets = new Map<
    string,
    { managerId: string; layer: string; site: string; costUsd: number }
  >();
  for (const row of matches) {
    const key = `${row.managerId} ${row.layer} ${row.site}`;
    const found = buckets.get(key);
    if (found === undefined) {
      buckets.set(key, {
        managerId: row.managerId,
        layer: row.layer,
        site: row.site,
        costUsd: row.totals.costUsd,
      });
    } else {
      found.costUsd += row.totals.costUsd;
    }
  }
  // 費用降順 → 鍵の昇順。同額のときに `Map` の挿入順へ落ちないようにする。
  const entries = [...buckets.values()].sort(
    (a, b) =>
      b.costUsd - a.costUsd ||
      a.managerId.localeCompare(b.managerId) ||
      a.layer.localeCompare(b.layer) ||
      a.site.localeCompare(b.site),
  );

  lines.push(
    `モデル id ${sdkModel} の行の内訳（台帳の軸そのもの。行には必ず actor と層と場所が付く）:`,
  );
  for (const entry of entries.slice(0, USAGE_AXIS_LIMIT)) {
    lines.push(
      `  - managerId: "${entry.managerId}" / layer: ${entry.layer} / site: ${entry.site}` +
        ` / 合計 ${formatUsd(entry.costUsd)}`,
    );
  }
  if (entries.length > USAGE_AXIS_LIMIT) {
    lines.push(`  …（残り ${entries.length - USAGE_AXIS_LIMIT} 件は出していない）`);
  }
  return lines.join('\n');
}

export function createCloneMcpServer(context: ToolContext) {
  return createSdkMcpServer({
    name: MCP_SERVER_NAME,
    version: '0.1.0',
    instructions:
      'alteroid のクローン自身の道具。記憶（人間がいつでも読み書きする Markdown）、' +
      '日誌（追記専用）、人間への確認、継続中の依頼（時間起点の仕込み）、' +
      '実行環境プロファイル（`.zprofile` 相当）、自分自身（alteroid）の正典と実行時の状態、' +
      'マネージャーへの委譲。',
    tools: createCloneTools(context),
  });
}
