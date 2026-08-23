import { randomUUID } from 'node:crypto';

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

import {
  bySpeaker,
  collectConversations,
  humanExchanges,
  reachedStart,
  searchExchanges,
  toMessage,
} from './conversation.js';
import { isCronExpression } from './cron.js';
import {
  describePage,
  excerpt,
  excerptLine,
  page,
  renderListing,
  renderListingEntry,
  renderListingFromEnd,
} from './excerpt.js';
import type { ManagerDenial, ManagerPool, ManagerSummary } from './manager.js';
import {
  applyMemoryFrontmatterPatch,
  assertNeverMemoryProtectionStatus,
  describeMemoryWriteDiff,
  formatMemoryCreatedAt,
  parseMemoryFrontmatter,
  renderMemoryDocuments,
  renderMemoryListing,
  resolveMemoryDocKind,
} from './memory.js';
import type { ProfileService } from './profile-service.js';
import {
  RESERVED_SCHEDULE_KINDS,
  describeScheduleSpec,
  localDate,
  localDayRange,
  parseTimeOfDay,
} from './schedule.js';
import {
  JOURNAL_ENTRY_TYPES,
  approvalUpdatedAt,
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
import { UnreadableCommitmentError } from './store.js';
import type { Stores } from './store.js';
import type { AccountUsageState } from './usage-snapshot.js';
import {
  ACCOUNT_USAGE_TITLE,
  describeAccountUsage,
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
   * **省略時は `'clone'`。** クローンの道具は人間の口ではないので、ここから
   * `'human'` は出ない（`'human'` を書くのは `app.ts` の `PUT` / `DELETE /memory/:slug`
   * の2箇所だけである）。
   *
   * **省略できるのはテストのためだけである。** 本番の配線（`clone.ts`）は
   * 本セッション（`#toolContext`）と蒸留のサイドクエリ（`#distillFromTranscript`
   * のインライン context）の両方へ渡す。片方へ渡し忘れると、渡し忘れた側は
   * 黙って既定の `'clone'` に落ちる ＝ 蒸留が書いた記憶なのに `cause: 'clone'`
   * と名乗ることになる（`runtime` と同じ「渡し忘れた側だけ静かに壊れる」形）。
   *
   * **ターンごとに変わる値なので、道具の実行時（ハンドラの中）で呼ぶこと。**
   * `createCloneTools` の呼び出し時に1回だけ評価すると、本セッションの MCP
   * サーバはセッションごとに1回しか組まれないため、セッション中ずっと最初の
   * ターンの種類のまま固定されてしまう。
   */
  memoryCause?: () => 'distill' | 'clone';
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
  'profile_read',
  'profile_write',
  'self_read',
  'self_status',
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
 * 返事待ち1件の要約の厚み。
 *
 * **runner 側のキャップをここの根拠にしない。** `brief(input, 200)` が効くのは
 * 1つの経路だけで、`AskUserQuestion`（`describeQuestions`）は複数の質問文を
 * 連ねて返すのでそれを通らない。上流の数え上げに依存せず、出す側で締める。
 */
const LIST_WAITING_EXCERPT = 200;
const LIST_BUDGET = 8_000;
/**
 * 一覧に添える拒否は、**新しい側から**この件数まで。
 *
 * 上限で切るのは 1 本の異常が一覧を食い潰さないためだが、**切ったことは必ず
 * 言う**（`denialLine`）。黙って落とすと「3種類しか止められていない」に見える。
 */
const LIST_DENIED_TOOLS = 3;
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
 */
function denialLine(denials: ManagerDenial[]): string | null {
  if (denials.length === 0) return null;
  // 帳面は古い順に積まれている。**新しい側から**採る。
  const recent = [...denials].reverse();
  const shown = recent.slice(0, LIST_DENIED_TOOLS);
  const rest = recent.length - shown.length;
  const total = denials.reduce((sum, entry) => sum + entry.count, 0);
  return (
    `  ⚠ 確認へ上がらず止められた道具: ${shown.map((e) => `${e.tool} ${e.count}件`).join(' / ')}` +
    (rest > 0 ? `（ほか ${rest} 種、全 ${total} 件）` : '') +
    '。この確認はクローンには回ってきていないので、手が止まっている可能性がある' +
    '（全件は journal_read に残っている。件数はデーモンを作り直すと数え直しになる）。'
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
 * `memory_write`（全文置換）・`memory_delete`・`memory_frontmatter_set`
 * （#318 案 (a)。frontmatter のキーだけの差し替え）の歯そのもの。
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
  action: '全文置換' | '削除' | 'frontmatter の更新',
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
 * ここだけ別の文言にする。
 */
function denialMessage(
  slug: string,
  status: Extract<MemoryProtectionStatus, { kind: 'human' | 'unknown' }>,
  action: '全文置換' | '削除' | 'frontmatter の更新',
): string {
  const reason =
    status.kind === 'human'
      ? `この文書には人間の書き込みの履歴が在る（保護状態: human）`
      : `この文書の書き込みの履歴が確認できない（保護状態: unknown。索引が無い・外から書き換えられた` +
        `可能性がある、などのときにここへ倒す——不明を「人間は書いていない」とは読まず、守る側へ倒す）`;

  const alternative =
    action === 'frontmatter の更新'
      ? 'memory_append（追記）はここでは代わりにならない——追記は本文の末尾に文字列を足すだけで、' +
        'frontmatter のキー（description / type / parent）は直せない。'
      : 'memory_append（追記）はこの歯の対象ではなく、断られない。失いたくないだけならそちらを使うこと。';

  // **`frontmatter の更新` だけ文を組み替える。** 「記憶 slug を frontmatter の
  // 更新したい」は助詞が壊れる（「〜を全文置換したい」「〜を削除したい」と違い、
  // 「更新」の対象は記憶そのものではなく frontmatter のほうだから）。
  const askHumanHint =
    action === 'frontmatter の更新'
      ? `本当に frontmatter の更新が必要だと判断したら、ask_human に「記憶 ${slug} の frontmatter を更新したい。` +
        '理由: 〈ここに理由〉」のように積むこと。人間の回答が届いた後の次のターンで、同じ操作をやり直せば実行できる' +
        '（この場・このターンではやり直せない）。'
      : `本当に${action}が必要だと判断したら、ask_human に「記憶 ${slug} を${action}したい。理由: ` +
        '〈ここに理由〉」のように積むこと。人間の回答が届いた後の次のターンで、同じ操作をやり直せば実行できる' +
        '（この場・このターンではやり直せない）。';

  return [
    `記憶 ${slug} への${action}を、統合の走行（distill）から断った。`,
    `理由: ${reason}。`,
    'いま何も変わっていない（記憶は断る前のまま残っている）。',
    alternative,
    askHumanHint,
  ].join(' ');
}

/** ツール定義そのもの。MCP の配線を通さずに単体テストできるよう分けてある。 */
export function createCloneTools(context: ToolContext) {
  const { stores } = context;
  // **ここで1回だけ解決しない。** `memoryCause` はターンごとに変わりうる値
  // なので、この関数の実行時（＝ MCP サーバを組む時）に確定させると、
  // セッション中ずっと最初のターンの種類に固定されてしまう
  // （`ToolContext.memoryCause` の doc）。3箇所の道具ハンドラの中で
  // その都度呼ぶ。
  const memoryCause = context.memoryCause ?? ((): 'distill' | 'clone' => 'clone');

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
        const before = await stores.persona.read(slug);
        const written = await stores.persona.write(slug, content);
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
        return text(`記憶 ${slug} を更新した。\n\n${diff}`);
      },
    ),

    tool(
      'memory_append',
      '記憶の文書の末尾に追記する（無ければ作る）。既存の記述を消したくないときはこちら。',
      {
        slug: z.string().describe('文書のスラッグ'),
        content: z.string().describe('追記する Markdown'),
        summary: z.string().describe('何を追記したかの一行要約（日誌に残る）'),
      },
      async ({ slug, content, summary }) => {
        const before = await stores.persona.read(slug);
        const written = await stores.persona.append(slug, content);
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
        return text(`記憶 ${slug} に追記した。\n\n${diff}`);
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
        '本文には一切触れない——この道具の呼び出しの中に本文が現れることは無いので、本文が途中で切れることが構造的に起こりえない。',
        '既に在る文書にしか使えない（存在しない slug には断る。新規作成は memory_write を使うこと）。',
        'frontmatter が無い文書には、先頭に新しく frontmatter を作って足す（type を渡さなければ premise のまま——載り方は変わらない）。',
        'frontmatter が壊れている（malformed）文書には断る（機械が推測して組み直すと本文を食う経路ができるため）。',
        'memory_write で全文を書き直すか、人間に確認を通すこと。',
        'description・type・parent のうち少なくとも1つを渡すこと（1つも渡さない呼びは断る。何も変わらない）。',
        'type は premise または fact。premise は全文がプロンプトへ焼かれ、fact は目次の1行だけになる。',
        '区分が変わったときは、その変化が応答に出る。',
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
          .describe('premise または fact。渡さなければ既存の値のまま（既定は premise）'),
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
        const written = await stores.persona.write(slug, nextContent);
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

        return text(`記憶 ${slug} の frontmatter を更新した。\n\n${diff}${kindChangeNote}`);
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
      async ({ limit, since, until, types, id, offset = 0 }) => {
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
          ...(types === undefined || types.length === 0 ? {} : { types }),
        });
        if (entries.length === 0) {
          return text(
            since === undefined && until === undefined && types === undefined
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
                'さらに遡るなら until を、狭めるなら since / types を指定すること。',
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
        requestId: z
          .string()
          .optional()
          .describe(
            'マネージャーからの確認を人間に回す場合、受信箱に届いた requestId。' +
              '人間の回答をこの確認へ返すために必要なので、managerId と必ず対で渡すこと',
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
        '軸は5つ — 日・マネージャー（誰の分か）・モデル・layer（誰が: clone / manager）・site（どこで: session / distill）。',
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
      async ({ from, to, managerId, layer, site, axis, offset }) => {
        const aggregate = await stores.usage.aggregate({
          ...(from === undefined ? {} : { from }),
          ...(to === undefined ? {} : { to }),
          ...(managerId === undefined ? {} : { managerId }),
          ...(layer === undefined ? {} : { layer }),
          ...(site === undefined ? {} : { site }),
        });
        // **軸モードでは「続きの1軸」だけを返す。** アカウント全体の残りもまとめ表示も
        // 付けない — 続きを辿るほど同じ全体が積み増しで返ってくるのを避けるためである。
        if (axis !== undefined) {
          return text(
            renderUsage(aggregate, { axis, ...(offset === undefined ? {} : { offset }) }),
          );
        }
        return text(
          [
            renderAccountUsage(context.accountUsage?.() ?? { state: 'unknown' }),
            '',
            '## alteroid が使った分（台帳）',
            renderUsage(aggregate),
          ].join('\n'),
        );
      },
    ),

    // --- 継続中の依頼（時間起点の仕込み） --------------------------------------
    tool(
      'schedule_list',
      [
        '仕込んである継続中の依頼の一覧。周期と、前回それで動いた時刻が分かる。',
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
            ` 前回動いた時刻: ${plan.lastRunAt ?? '（まだ一度も動いていない）'}`;
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
            extra: [`  前回動いた時刻: ${plan.lastRunAt ?? '（まだ一度も動いていない）'}`],
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
      },
      async ({ id, offset = 0, includeClosed }) => {
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
        // **`list()` は `{ entries, unreadable }` を返す（issue #296）。**
        // 読める行（`entries`）が0件でも、読めない行（`unreadable`）だけは
        // 在りうるので、「無い」と返してよいのは両方0件のときだけである。
        const { entries, unreadable } = await stores.commitments.list(
          includeClosed === true ? { includeClosed: true } : undefined,
        );
        if (entries.length === 0 && unreadable.length === 0) {
          return text('（引き受けたまま終わっていない仕事は無い）');
        }
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
            ? '（読める行は無い）'
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
                omitted: ({ rest, shown, total }) =>
                  `…ほか ${rest} 件は省略（${
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
          const ids = unreadable
            .map((entry) => entry.id)
            .filter((id): id is string => id !== undefined);
          lines.push(
            `**読めない行が ${unreadable.length} 件ある${
              ids.length > 0 ? `（id: ${ids.join(', ')}）` : ''
            }。片付いたのではない。**`,
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
        await stores.commitments.close(id, new Date().toISOString(), reason, 'clone');
        return text(`${id} を片付けた。`);
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
            delivered.length === 0 ? null : `配った先: ${delivered.join(', ')}`,
            failed.length === 0
              ? null
              : `配れなかった先: ${failed.map((r) => `${r.runnerId}（${r.error ?? '理由不明'}）`).join(', ')}`,
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
            renderMemorySize(documents, renderMemoryDocuments(memoryDocuments)),
            '',
            renderLedgerCrossReference(runtime.sdkModel, aggregate),
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
        requestId: z
          .string()
          .optional()
          .describe(
            'どの確認への回答かを示す id（受信箱に届いた requestId）。' +
              '1本のマネージャーが複数を同時に待つことがあるので、回答では必ず添えること',
          ),
      },
      async ({ managerId, message, decision, requestId }) => {
        if (!context.managers) return NO_POOL;
        const result = await context.managers.send(managerId, message, {
          ...(decision === undefined ? {} : { decision }),
          ...(requestId === undefined ? {} : { requestId }),
        });
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
              `いまの状態: ${after === undefined ? '一覧から消えている' : `${after.status}${after.live ? '' : '/セッション切断'}`}。` +
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
            : `いまの状態: ${after.status}${after.live ? '' : '/セッション切断'}。`,
        );
        return text(lines.join('\n'));
      },
    ),

    tool(
      'manager_list',
      [
        'マネージャーの一覧と状態を見る。何が走っていて、何が返事待ちかが分かる。',
        // **状態の名前を「観測」より強く読ませない。** running は「走らせた」で
        // あって「進んでいる」ではなく、done は「マネージャーのターンが終わった」
        // であって「仕事が終わった」ではない。⚠ の行がその差を埋める。
        '状態の名前はデーモンが観測できた範囲でしかないので、⚠ の行まで読むこと。',
        '依頼文と報告は抜粋なので、全文が要るなら manager_report で取ること。',
      ].join(' '),
      {},
      async () => {
        if (!context.managers) return NO_POOL;
        const managers = await context.managers.list();
        if (managers.length === 0) return text('（マネージャーは1本も居ない）');

        // **予算を先に決めて、入るところまで積む。** 件数から出力量を決めると、
        // 何件で壊れるかが運任せになる。切ったなら必ずそう言う。
        // 積む形そのものは `renderListing` が持つ（一覧ごとに手で書かない）。
        const items = managers.map((manager) =>
          renderListingEntry({
            id: manager.managerId,
            title: `[${manager.status}${manager.live ? '' : '/セッション切断'}]`,
            createdAt: manager.startedAt,
            updatedAt: manager.updatedAt,
            summary: `依頼: ${excerptLine(manager.request, LIST_REQUEST_EXCERPT)}`,
            extra: [
              // **runnerId は空欄にしない。** 取れていないことを「未記録」という
              // 文字列で読める形にする（AGENTS.md「取れない軸に0の行を作らない」と
              // 同じ理由——空欄だと「取れていない」のか「読み忘れ」なのか区別できない）。
              `  runner: ${manager.runnerId ?? '未記録'}`,
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
              ...manager.waiting.map(
                (item) =>
                  `  返事待ち(requestId: ${item.requestId}): ` +
                  excerptLine(item.summary, LIST_WAITING_EXCERPT),
              ),
              manager.lastReport === undefined
                ? null
                : `  直近の報告: ${excerptLine(manager.lastReport, LIST_REPORT_EXCERPT)}`,
            ],
          }),
        );
        return text(
          [
            renderListing(items, {
              budget: LIST_BUDGET,
              omitted: ({ rest, total }) =>
                `…ほか ${rest} 件は省略（全 ${total} 件）。走っているものから順に出している。`,
            }),
            '（依頼と報告は抜粋。全文は manager_report <managerId> で取れる）',
          ].join('\n'),
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
          return text(
            part === 'request'
              ? `マネージャー ${managerId} の依頼文が記録に無い。`
              : `マネージャー ${managerId} からの報告はまだ無い（状態: ${found.status}）。`,
          );
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
          .describe('日誌を何件遡るか（既定 2000）。遡り切れたかは応答の注記で分かる'),
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
        const entries = await stores.journal.list({
          limit: scanLimit,
          types: ['exchange'],
          ...(since === undefined ? {} : { since }),
          ...(until === undefined ? {} : { until }),
        });
        // **`since` を渡されたら「先頭に届いた」とは言えない。**
        //
        // `reachedStart` が答えるのは「ストアが行を出し切ったか」だけである。
        // ところが `since` は LIMIT より先に効く（fs / pg / memory とも
        // WHERE → LIMIT の順。`storage-pg/src/journal.ts` は `where()` の後に
        // `.limit()` を呼ぶ）ので、件数が `scan` に届かないのは
        // 「日誌の先頭まで見た」ではなく「`since` より新しい範囲を出し切った」
        // でしかない。**ここを混ぜると「無い」と言い切ってしまう** —
        // 実際には `since` より古い側に在りうるのに、下の分岐が
        // 「当たる発言は無い」を選ぶ。これはこの道具が塞いでいる欠陥
        // （観測の欠落を「無い」と報告する形）そのものである。
        const exhausted = reachedStart(entries.length, scanLimit);
        const reached = exhausted && since === undefined;
        const scanNote =
          `（日誌を ${entries.length} 件遡った。` +
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
          return text(
            `マネージャー ${managerId} の生ログは無い。走行中の runner のディスク・` +
              '退避済みアーカイブ・預かったセッションの生ログ、3段のどこにも見当たらなかった。' +
              `（${managerId} という id 自体が台帳に無い場合と、id はあるが生ログが` +
              '一度も残らなかった場合のどちらも、この応答だけでは区別できない。' +
              'manager_list に出ているかで id の実在は別途確かめられる。）',
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
        'デーモン自身の版と、各 runner が名乗った版（コミット sha）も出る。' +
          'デーモンと runner は別々にデプロイされるので、同じ main から起こしていても' +
          '別のコミットで走る窓がある——調べ物で「コードはこうなっている」と言う前に、' +
          'いま走っている版がその主張と同じかを見ること。',
        '版が「不明」（器が自分の版を知らない）と「未確認」（名乗りをまだ聞けていない）は' +
          '別物で、疑う先が違う（前者は器の設定、後者は登録とネットワーク）。' +
          'state が lost の器の版は黙る前に聞いた古い値である。',
        'resources: true を渡すと器ごとの pids（プロセス数）の現在値/上限も出る' +
          '（#315 案1）。これは器の合計であって内訳ではない——何がその数を持って' +
          'いるかはこの数字からは分からない。空き（上限 − 現在値）も、次に何本' +
          '置けるかを意味しない——実測では vitest が1本立ち上がるだけで pids が' +
          '+131 跳ねている。「runner に訊けなかった」（器が開いていない・応答が' +
          '無い）と「訊けたが pids が読めない」（cgroup を持たない器）は別の文言で' +
          '出る——どちらも数字が出ない点は同じだが、疑う先が違う。',
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
            '器ごとの pids（プロセス数）を出すか。既定は出さない——このために' +
              'ネットワーク往復を足さない側に倒してある。頼んだときだけ各 runner の' +
              '/health を叩く。合計しか分からず内訳は出ない（#315 の本題である' +
              '内訳の特定はこれでは解決しない）。',
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
                shown.map((m) => `${m.managerId}[${m.status}]`).join(', ') +
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
                : `  鍵の指紋: ${runner.credentials.map((c) => `${c.name}=${c.sha256}`).join(', ')}`,
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
            'pids について: **これは器の合計であって内訳ではない。** 何がその数を持っているかは、' +
              'この数字からは分からない（#315 の本題である内訳の特定は、まだ誰にもできない）。' +
              '**空き（上限 − 現在値）は「次に何本置けるか」を意味しない**——実測では ' +
              'vitest が1本立ち上がるだけで pids が +131 跳ねている。',
          );
        }
        if (overview.unassigned.length > 0) {
          const shown = overview.unassigned.slice(0, RUNNER_MANAGER_LIST_LIMIT);
          const rest = overview.unassigned.length - shown.length;
          tail.push(
            `どの器か分からない: ${overview.unassigned.length}件（` +
              shown.map((m) => `${m.managerId}[${m.status}]`).join(', ') +
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
    case 'memory_update':
      return { head: `[memory_update ${entry.slug} (${entry.cause})]`, body: entry.summary };
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
const USAGE_AXES = ['date', 'manager', 'model', 'layer', 'site'] as const;
type UsageAxis = (typeof USAGE_AXES)[number];

/** `axis` を指定したときに1回で出す件数。 */
const USAGE_AXIS_PAGE = 100;

const USAGE_AXIS_TITLES: Record<UsageAxis, string> = {
  date: '日別',
  manager: 'マネージャー別',
  model: 'モデル別',
  layer: '層別（誰が）',
  site: '場所別（どこで）',
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

function renderUsage(
  aggregate: UsageAggregate,
  view: { axis?: UsageAxis; offset?: number } = {},
): string {
  const { rows, since, layersSince, beforeLedger, beforeLayers, notice } = aggregate;

  if (since === null) {
    return [
      '台帳にはまだ1件も記録が無い。',
      '（消費の記録はこの機能を入れた時点から始まる。それより前の分は残っていない）',
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
  } else {
    lines.push(`合計 ${formatUsd(summary.total.costUsd)}`);
    lines.push(
      `  入力 ${summary.total.inputTokens.toLocaleString('en-US')} / ` +
        `出力 ${summary.total.outputTokens.toLocaleString('en-US')} / ` +
        `キャッシュ読み ${summary.total.cacheReadInputTokens.toLocaleString('en-US')} / ` +
        `キャッシュ書き ${summary.total.cacheCreationInputTokens.toLocaleString('en-US')}`,
    );

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
 */
function renderMemorySize(documents: MemoryDocumentMeta[], totalMemory: string): string {
  const lines = [
    '## 記憶の大きさ（いま stores.persona を読み直した値）',
    '',
    `- 総文字数: ${totalMemory.length.toLocaleString('en-US')} 文字（${documents.length} 文書）`,
  ];
  if (documents.length === 0) return lines.join('\n');

  const items = documents.map((doc) => {
    const descriptor =
      doc.description === undefined
        ? ''
        : ` — ${excerptLine(doc.description, SELF_STATUS_MEMORY_DESCRIPTION_LIMIT)}`;
    return (
      `  - ${doc.slug}: ${doc.title} ` +
      `(作成: ${formatMemoryCreatedAt(doc.createdAt)} / 更新: ${doc.updatedAt}) ` +
      `${doc.bytes.toLocaleString('en-US')} bytes${descriptor}`
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
