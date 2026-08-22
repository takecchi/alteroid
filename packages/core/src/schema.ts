import { z } from 'zod';

import { CRON_EXPRESSION_MAX, isCronExpression } from './cron.js';
// `usage.ts` はこちら（`schema.js`）を import していない（確認済み。下記
// `turn_usage` の doc）ので循環しない。日誌の `turn_usage.layer` / `.site` /
// `.models` は台帳（`UsageStore`）の同名の列と**同じ値**であるべきなので、
// 書き写して2つの定義を持たず、ここから読む。
import { usageLayerSchema, usageSiteSchema, usageTotalsSchema } from './usage.js';

/**
 * 型付きメッセージのスキーマ（docs/architecture.md「配線」）。
 *
 * ここに定義されるのは層をまたぐメッセージだけである。M1 で実際に流れるのは
 * 人間の発言だけだが、受信箱・日誌・ジョブの構造は最初からイベント駆動で置く
 * （chat 専用の作りにすると M3 で自律に化けられない — AGENTS.md 地雷4）。
 */

const isoDateTime = z.string().datetime({ offset: true });

// ---------------------------------------------------------------------------
// 記憶（PersonaStore）
// ---------------------------------------------------------------------------

/** 記憶文書のスラッグ。ファイル名にそのまま使うので経路要素を含めない。 */
export const memorySlugSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9][a-z0-9._-]*$/, 'slug は英小文字・数字・. _ - のみ');

export const memoryDocumentMetaSchema = z.object({
  slug: memorySlugSchema,
  /** 文書の先頭見出し（`# ...`）。無ければ slug。 */
  title: z.string(),
  updatedAt: isoDateTime,
  bytes: z.number().int().nonnegative(),
});

export const memoryDocumentSchema = memoryDocumentMetaSchema.extend({
  content: z.string(),
});

export type MemorySlug = z.infer<typeof memorySlugSchema>;
export type MemoryDocumentMeta = z.infer<typeof memoryDocumentMetaSchema>;
export type MemoryDocument = z.infer<typeof memoryDocumentSchema>;

// ---------------------------------------------------------------------------
// 記憶の保護状態（human guard）
// ---------------------------------------------------------------------------

/**
 * 記憶1文書が「人間の手を経ているか」の3状態。
 *
 * **これ自体は新しい真実ではない。** 実体は日誌（`memory_update.cause`）に
 * あり、ここが表すのはその派生値（pg: `memory` テーブルの `human_touched_at` /
 * `content_sha256` 列 — pg では `packages/storage-pg` / fs: `.index.json` —
 * fs では `packages/storage-fs` が持つ）を読んだ結果である。
 *
 * - **`human`** — 過去に `cause:'human'` の `memory_update`（`action:'write'`）が
 *   在る。**一度立ったら絶対に降りない** — クローンが何度書いても、この状態は
 *   `clone-only` へは戻らない。
 * - **`clone-only`** — 履歴は在るが全部 `clone` / `distill`。
 * - **`unknown`** — 履歴が無い／派生値を失った／外から書き換えられた可能性がある。
 *   **`human` と同じ扱いで守る側へ倒す。**
 *
 * **`unknown` を `clone-only` に畳まないこと。** 畳むと、履歴を失った瞬間に
 * 「人間は書いていない」という嘘になる。判定・描画のどちらの側も3状態を
 * 分岐すること — 網羅性は `memory.ts` の `assertNeverMemoryProtectionStatus`
 * （`never` への代入）で強制する。状態を1つ足して分岐を足し忘れると `tsc` が落ちる。
 */
export type MemoryProtectionStatus =
  | { kind: 'human' }
  | { kind: 'clone-only' }
  | { kind: 'unknown' };

// ---------------------------------------------------------------------------
// 受信箱イベント
// ---------------------------------------------------------------------------

/**
 * 仕事の起点（PRD「自律」の4つ）。M1 で届くのは `human` だけだが、
 * 判別可能ユニオンとして最初から4つ揃えておく。
 */
export const inboxEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('human_message'),
    id: z.string(),
    at: isoDateTime,
    text: z.string(),
    /** 人間が chat セッションを閉じたか（会話終了 = 蒸留の契機） */
    conversationId: z.string(),
  }),
  z.object({
    type: z.literal('human_answer'),
    id: z.string(),
    at: isoDateTime,
    /** 承認待ちキューの項目 id */
    approvalId: z.string(),
    answer: z.string(),
  }),
  z.object({
    type: z.literal('distill'),
    id: z.string(),
    at: isoDateTime,
    reason: z.enum(['conversation_end', 'shutdown']),
  }),
  z.object({
    type: z.literal('timer'),
    id: z.string(),
    at: isoDateTime,
    /** 何の定期ジョブか */
    kind: z.string(),
    /**
     * その発火が何を対象にしているか（日報なら対象日 `YYYY-MM-DD`）。
     *
     * **発火時刻から逆算させないこと。** デーモンが止まっていた日の日報を後から
     * 作るとき、発火時刻はその日ではない。対象は起こした側が決めて運ぶ。
     */
    target: z.string().optional(),
    /**
     * 定期の予定で来たのか、人間が手で起こしたのか（`POST /schedule/:kind/run`）。
     *
     * **同じ形で運ぶが、意味が違う。** 手で起こした1回は「余分に1回」であって
     * 定期の予定をずらすものではない（`Scheduler.run` の契約）。ここで区別しないと、
     * 受け取った側が予定の基準を手動実行の時刻へ動かしてしまい、再起動後に位相が
     * ずれる。省略時は定期の予定である。
     */
    cause: z.enum(['schedule', 'manual']).optional(),
  }),
  z.object({
    type: z.literal('external'),
    id: z.string(),
    at: isoDateTime,
    source: z.string(),
    /** 中身のない通知（source だけが届く）もあるので省略できる。 */
    payload: z.unknown().optional(),
  }),
  z.object({
    type: z.literal('self_initiative'),
    id: z.string(),
    at: isoDateTime,
    reason: z.string(),
  }),
  z.object({
    type: z.literal('manager_message'),
    id: z.string(),
    at: isoDateTime,
    managerId: z.string(),
    /** マネージャーからの報告 / 質問 / 許可確認 */
    kind: z.enum(['report', 'question', 'permission']),
    text: z.string(),
    /**
     * 質問・許可確認のときだけ付く。マネージャー側でその1件が返事を待って
     * 止まっている。クローンが `manager_send` で答えるとそこだけが再開する。
     */
    requestId: z.string().optional(),
  }),
]);

export type InboxEvent = z.infer<typeof inboxEventSchema>;
export type InboxEventType = InboxEvent['type'];

// ---------------------------------------------------------------------------
// 日誌エントリ
// ---------------------------------------------------------------------------

/**
 * 追記専用の記録（PRD「可観測性」の中段）。
 * 型は architecture.md の JournalStore 行に対応する。
 */
export const journalEntrySchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('exchange'),
    id: z.string(),
    at: isoDateTime,
    /**
     * 誰との往復か。`self` は人間に見せない内部ターン（蒸留・自律の起点）。
     * 内部ターンも必ず日誌に残す — 見えない層を作らない（PRD「可観測性」）。
     */
    with: z.enum(['human', 'manager', 'self']),
    role: z.enum(['inbound', 'outbound']),
    text: z.string(),
    conversationId: z.string().optional(),
  }),
  z.object({
    type: z.literal('decision'),
    id: z.string(),
    at: isoDateTime,
    /** 何を判断したか */
    decision: z.string(),
    /** 記憶のどこに根拠があったか（無ければ人間に聞いたはず） */
    grounds: z.string(),
  }),
  z.object({
    type: z.literal('escalation'),
    id: z.string(),
    at: isoDateTime,
    question: z.string(),
    /** 承認待ちキューの項目 id、またはマネージャーの確認1件の id。 */
    approvalId: z.string(),
    /** マネージャー発の確認ならその manager_id（誰が止まっているかを辿るため）。 */
    managerId: z.string().optional(),
    answeredAt: isoDateTime.optional(),
    answer: z.string().optional(),
  }),
  z.object({
    type: z.literal('tool_use'),
    id: z.string(),
    at: isoDateTime,
    /**
     * 実行した層。`manager:<id>` / `worker:<id>:<agent>` /
     * `clone`（クローン自身の手）/ `clone:sub:<agent>`（クローンが起こした
     * サブエージェント）の形で入る。**全層の全ツール実行がここに落ちる（監査）。**
     *
     * **層をここで数え上げないこと。** 判定は `isCloneActor`（`usage.ts`）に1本だけ
     * あり、`=== 'clone'` と書き写すとサブエージェントぶんが委譲した量の側へ落ちる。
     */
    actor: z.string(),
    tool: z.string(),
    input: z.unknown(),
  }),
  z.object({
    type: z.literal('memory_update'),
    id: z.string(),
    at: isoDateTime,
    slug: memorySlugSchema,
    /**
     * 蒸留・人間の直接編集・クローンの書き込みのどれか。
     *
     * - **`'distill'`** — 蒸留のターンが書いた。**本セッションの蒸留ターン
     *   （`conversation_end` / `shutdown`）と `pre_compact` のサイドクエリの
     *   両方を含む**（`clone.ts` の `#toolContext` / `#distillFromTranscript`
     *   の `memoryCause`）。
     * - **`'clone'`** — **本セッションのクローンが書いた**（蒸留のターンでは
     *   ない、人間の発言などに応じた通常のターン）。**この配線が入る前は
     *   「クローン層が書いた」の意味で蒸留も含んでいた。** `optional` にした
     *   `action` と同じ形の理由で、**既存のエントリは書き換えていない** —
     *   だからこの配線より前の `cause: 'clone'` エントリは、蒸留か通常の
     *   ターンかの区別を持たない。
     * - **`'human'`** — 人間が API / CLI から直接書いた。書いているのは
     *   `app.ts` の `PUT` / `DELETE /memory/:slug` の2箇所だけである。
     *
     * **この `cause: 'distill'` は台帳（`usage.ts`）の `site: 'distill'` と
     * 同じ軸ではない。** `site` は `query()` 呼び出しごとの軸で、
     * `usageSiteSchema` の doc が明言しているとおり `pre_compact` の
     * サイドクエリだけを指す（本セッションの蒸留ターンの消費は `site:
     * 'session'` に合算されて分離できない）。`cause` は本セッションの蒸留
     * ターンも含むので、**この2つを突き合わせて数えても一致しない**
     * （片方が壊れているわけではない）。
     */
    cause: z.enum(['distill', 'clone', 'human']),
    /**
     * 「書いた」か「消した」かの機械可読な区別。
     *
     * **`optional` にしてあるのは、既存の日誌エントリを1件も壊さないため。**
     * これが無いエントリは「この区別が導入される前の古いエントリ」を意味する
     * （PR #144 と同じ形 — 機械可読な面が持たない区別を自由文の `summary` だけに
     * 持たせると、日誌を辿って「消した記録」を数えたい側が文言に一致させる
     * しかなくなる）。**`summary` の自由文は削らない**（人が読む説明を減らす
     * ことと機械可読な区別を足すことは別である）。
     */
    action: z.enum(['write', 'append', 'remove']).optional(),
    summary: z.string(),
  }),
  z.object({
    type: z.literal('daily_report'),
    id: z.string(),
    at: isoDateTime,
    date: z.string(),
    body: z.string(),
    /**
     * **この行は日報の代わりに置いた印であって、日報ではない。** 入っているのは
     * 「なぜ書けなかったか」である。
     *
     * ## なぜ印が必要か（印が無いと再試行が死ぬ）
     *
     * 日報を作るターンが上限で死ぬと、`clone.ts` の `#dailyReport` は本文なしで
     * 1件書いていた。その1件が**2か所で「日報がある日」として数えられる**:
     *
     * - `clone.ts` の `#dailyReport`（同じ日付の日報があれば早期 return）
     * - `schedule.ts` の `missingDailyReportDates`（起動時の後追いの対象から外す）
     *
     * 上限に当たった合図は保持され、枠が開いたら配り直される（`clone.ts` の
     * `#pump` の `finally`）。**つまり再試行は来る。** ところが来たときには
     * 代替文の行が既にあるので、どちらの経路も「もう書いた」と判断して
     * **本物の日報が永久に書かれない**。プレースホルダが再試行を殺していた。
     *
     * この印があると、人間には「その日に何かあった」ことが見えたまま、機構は
     * 「まだ書けていない」と数えられる。**両方を同時に満たす唯一の形**である
     * （書かなければ人間から消え、印なしで書けば再試行が死ぬ）。
     *
     * **`body` を空にして代用しないこと。** 空文字は「書けなかった」と
     * 「クローンが空文字を書いた」を区別しない。
     */
    unavailable: z.string().optional(),
  }),
  z.object({
    type: z.literal('external_event'),
    id: z.string(),
    at: isoDateTime,
    /** どこから届いたか（webhook の呼び出し元が名乗る名前）。 */
    source: z.string(),
    /**
     * 届いた中身。長いものは切って入る。
     *
     * 要約ではなく中身を落とすのは、日誌が「何かあったときに掘る」層だからである
     * （PRD「可観測性」）。何が届いたのか分からない記録は掘る役に立たない。
     */
    summary: z.string(),
  }),
  /**
   * 委譲1区間ぶんの集計。**フィールドの意味と doc は `runner-protocol.ts` の
   * `worker_wait` イベントに書いてある（二重管理を避けるためここには書き写さ
   * ない）。** `id` / `at` はストア側が埋める（`at` は区間が閉じた時刻、
   * `openedAt` が開いた時刻なので、区間の長さも後から出せる）。
   */
  z.object({
    type: z.literal('worker_wait'),
    id: z.string(),
    at: isoDateTime,
    openedAt: isoDateTime,
    tasks: z.number().int().nonnegative(),
    turns: z.number().int().nonnegative(),
    byCause: z.object({
      input: z.number().int().nonnegative(),
      notification: z.number().int().nonnegative(),
      continuation: z.number().int().nonnegative(),
    }),
    toolless: z.number().int().nonnegative(),
    notifications: z.number().int().nonnegative(),
    submits: z.number().int().nonnegative(),
    sources: z.record(z.string(), z.number().int().nonnegative()).optional(),
    settled: z.boolean(),
  }),
  /**
   * **ターン1回ぶんの消費の増分**（`usage.ts` の `UsageFold.delta`）。
   *
   * 台帳（`UsageStore`）は日 × actor × モデル × 層 × 場所の5軸に畳むので、
   * 「今日いくら使ったか」は言えるが「**どのターンが高かったか**」は言えない
   * （台帳の行は日単位でしか閉じない）。ここへ1ターン1行で残す。
   *
   * **なぜ台帳の軸を増やさずに日誌へ置いたかは PR 本文にある。** ここに書くのは
   * この行1件が何を言えて何を言えないかだけである — 日誌を読む者はこの PR を
   * 読んでいない。
   *
   * ## 「行が無い」理由は3つある。取り違えないこと
   *
   * 1. **増分が空**（`delta` が `{}`）。同じ累積の再送などで実際に増分が
   *    無かった回（`clone.ts` の `#recordUsage` / `manager.ts` の
   *    `case 'usage'` が書かない）。
   * 2. **台帳へ積めなかった**（記録の失敗）。**両層とも日誌に跡が残る**
   *    （非対称を事実として書いたのは #131、解消したのは #133。経緯は
   *    #133 の PR 本文にある） —
   *    マネージャー層は `case 'usage'` の `catch` が `exchange with=manager`
   *    として日誌に残し、クローン層は `#recordUsage` の `catch` が
   *    `exchange with=self` として日誌に残す（どちらも文言は
   *    「消費を台帳へ記録できなかった（この分は集計に出ない）」で揃えてある）。
   *    クローン層は stderr（`noteDroppedRecord`）も併せて残す — 台帳の
   *    失敗そのものを名指しする跡は stderr 側にしか無い（日誌への追記も
   *    失敗した場合、`exchange` の行自体も書かれず、`#journal` のフォール
   *    バックが別の文言で stderr に残るため）。**つまりこの2番の回でも、
   *    日誌への追記そのものがさらに失敗した稀な場合を除き、`turn_usage` は
   *    無いが `exchange with=self`（クローン層）／`with=manager`
   *    （マネージャー層）は残る。**
   * 3. **ターンが失敗して終わった**（`isSuccessResult` が偽）。`models` の
   *    doc を見よ — これが最も誤読を招きやすい形である。
   *
   * これで全て。`#recordUsage` の早期 return（1・3）と `case 'usage'` の
   * `try`/`catch`（2）を読めば数え上げが閉じる。
   *
   * - `id` / `at` はストアが埋める（他の型と同じ）。
   */
  z.object({
    type: z.literal('turn_usage'),
    id: z.string(),
    at: isoDateTime,
    /** どの層か。台帳と同じ語を使う（モデル id で代用しない。`usage.ts` の `usageLayerSchema`）。 */
    layer: usageLayerSchema,
    /**
     * どの `query()` 呼び出しか。**起点（`cause`）とは別の軸である。** 発意
     * tick を契機に回ったターンも、人間との会話のターンも、同じ
     * `site: 'session'` に入る。「どの起点が高かったか」を言うには別の軸が
     * 要るが、この PR では足していない（測って要るかを判断する。PR 本文）。
     */
    site: usageSiteSchema,
    /** 誰の分か（マネージャーの id か `CLONE_ACTOR_ID`）。台帳の `managerId` と同じ値。 */
    managerId: z.string(),
    /** SDK のセッション id（取れたときだけ）。生ログへ降りる鍵。 */
    sessionId: z.string().optional(),
    /**
     * モデル別の増分。**合計に潰さないこと。**
     *
     * **これはそのターンの「請求額」ではない。** `usage.ts` の
     * `usageSiteSchema` の doc（「## どの層にも出てこない消費がある」）が言う
     * とおり、`modelUsage` には compaction など内部の呼び出しが混ざっており
     * 分離できない。逆に permission classifier / token-count probe のような、
     * **台帳のどの層にも出てこない消費もある**（同 doc）。
     *
     * ## これは「このターンの消費」ではなく「前回成功した result からの増分」である
     *
     * `#recordUsage` と `case 'usage'` はどちらも `isSuccessResult(message)`
     * が偽の result を無条件に捨てる（`runner.ts` の既存コメント —
     * 「絞っても取りこぼさない。値は累積なので、失敗した回のぶんも次の成功が
     * 運んでくる」）。**これは台帳（合計）については正しいが、1ターン1行の
     * 増分にとっては意味が変わる** — 失敗して終わったターン（上限に当たって
     * 落ちた回を含む）は行を1件も作らず、**その消費は次に成功したターンの
     * `models` へ合算されて現れる。**
     *
     * つまり `turn_usage` の1行が高いのを見たとき、それは「そのターンだけが
     * 高かった」ではなく「直前に失敗したターンが無かったか」を確かめないと
     * 判断できない。突き合わせ先は日誌の `exchange`（クローン層は
     * `with: 'self'` / `with: 'human'` で `#reportFailure` が書く。マネージャー
     * 層は `with: 'manager'` に加え `ManagerSummary.lastFailure` — 報告の本文
     * だけでは失敗と判定できない回があるため）。**この注意は下の `reset` の
     * 注意と同じ種類である。** どちらも「この行の `models` を素朴に合計すると
     * 間違える」という形をしている。
     *
     * `cacheReadInputTokens` と `cacheCreationInputTokens` を分けたまま持つ
     * ことで、「キャッシュの書き直しに払っているのか」が推測ではなく事実として
     * 分かる。ここを合計に潰すと、その区別が消える。
     */
    models: z.record(z.string(), usageTotalsSchema),
    /**
     * 数え直し（resume / `/clear` で SDK 側の累積が0から始まった）を挟んだ
     * ターンの印。
     *
     * **これが付いた行の `models` は差分ではなく、新しい累積の先頭である**
     * （`usage.ts` の `foldUsageSnapshot` — 「数え直しを検知したときの増分は
     * スナップショットの全量」）。他の行と同じ扱いで合計へ足すと、記録済みの
     * 分を二重に数える。**`models` の doc の「前回成功した result からの増分」
     * の注意と同じ種類 — どちらも素朴に合計すると間違える。**
     *
     * **付いていないことは「数え直しが起きなかった」ではない。** 検知は
     * `usage.ts` の `detectReset` の2条件（モデルの値が減った／基準にあった
     * モデルが消えた）に基づく判定であって、この2条件に当たらない数え直しは
     * 検出されない。「このターンでは検出されなかった」であって「起きなかった」
     * ではない。
     */
    reset: z
      .object({
        fromCostUsd: z.number().nonnegative(),
        toCostUsd: z.number().nonnegative(),
      })
      .optional(),
  }),
]);

export type JournalEntry = z.infer<typeof journalEntrySchema>;
export type JournalEntryType = JournalEntry['type'];

export type DailyReport = Extract<JournalEntry, { type: 'daily_report' }>;

/**
 * 日報の行か（**印の行も含む**）。人間へ出す一覧はこちらを使う — 書けなかった
 * ことも人間には見えていなければならない。
 */
export function isDailyReport(entry: JournalEntry): entry is DailyReport {
  return entry.type === 'daily_report';
}

/**
 * **実際に書かれた**日報か（`unavailable` の印が付いた行を除く）。
 *
 * **「その日の日報はもうあるか」を数える側は必ずこちらを使うこと。** 印の行を
 * 数えてしまうと、後から本物を書き直す道が閉じる（`unavailable` の doc に経緯）。
 * 数える側は2か所ある — `clone.ts` の `#dailyReport` と `schedule.ts` の
 * `missingDailyReportDates` で、**片方だけ直すと片方の経路だけが死ぬ**。
 */
export function isWrittenDailyReport(entry: JournalEntry): entry is DailyReport {
  return isDailyReport(entry) && entry.unavailable === undefined;
}

/**
 * 日誌の種別の一覧（絞り込みの選択肢として外へ出す口）。
 *
 * **`satisfies Record<JournalEntryType, true>` で縛ってある。** 種別を足して
 * ここを足し忘れると型で落ちる — 一覧が黙って古びると、増えた種別だけが
 * 絞り込みから漏れて「あるのに見えない」が静かに生まれる。
 */
const journalEntryTypeNames = {
  exchange: true,
  decision: true,
  escalation: true,
  tool_use: true,
  memory_update: true,
  daily_report: true,
  external_event: true,
  worker_wait: true,
  turn_usage: true,
} satisfies Record<JournalEntryType, true>;

export const JOURNAL_ENTRY_TYPES = Object.keys(journalEntryTypeNames) as [
  JournalEntryType,
  ...JournalEntryType[],
];
/** 追記時に id / at はストアが埋める。 */
export type JournalEntryInput = DistributiveOmit<JournalEntry, 'id' | 'at'>;

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

// ---------------------------------------------------------------------------
// 定期の依頼（時間起点の器）
// ---------------------------------------------------------------------------

/**
 * 定期の依頼の名前。`kind` は受信箱の `timer` イベントに載り、人間が
 * `/schedule` や HTTP から手で起こすときの識別子にもなる。
 */
export const scheduleKindSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9._-]*$/, 'kind は英小文字・数字・. _ - のみ');

/**
 * 周期。
 *
 * **これは方針であって抑止装置ではない**（north_star 禁止2）。「何回まで」を
 * 表す形をここへ足さないこと。表すのは「いつ起こすか」だけである。
 */
export const scheduleSpecSchema = z.discriminatedUnion('type', [
  /**
   * 毎日この時刻（ローカル時刻）。
   *
   * **時刻の範囲までここで見る。** 形だけ見て通すと `25:99` が保存でき、一覧には
   * 「毎日 25:99」と出るのに実際は 00:00 に発火する（人間が読んで矛盾する状態を
   * 作れてしまう）。検査を経路ごとに置くと、どれか1本を通り忘れた時点で穴になる。
   */
  z.object({
    type: z.literal('daily'),
    at: z.string().regex(/^(?:[01]?\d|2[0-3]):[0-5]\d$/, 'HH:MM（00:00〜23:59）で書く'),
  }),
  /** この分数ごと。 */
  z.object({ type: z.literal('every'), minutes: z.number().int().min(1) }),
  /**
   * cron 式（ローカル時刻）。
   *
   * **人間が cron で書けることは、この階層でも書けるべきである**（north_star 禁止1）。
   * 「毎週月曜の朝」を `daily` で表そうとすると「毎日起きて曜日を見て何もしない」に
   * なり、7回に6回は上位モデルのターンを空焼きする。
   *
   * 読める式かどうかまでここで見る。読めない式を保存できると、一覧には出るのに
   * 発火しない仕込みが作れてしまう。
   */
  z.object({
    type: z.literal('cron'),
    expression: z
      .string()
      .max(CRON_EXPRESSION_MAX)
      .refine(isCronExpression, 'cron 式として読めない（例: 毎週月曜 10:00 なら `0 10 * * 1`）'),
  }),
]);

/**
 * 継続中の依頼1件（PRD「自律」の起点②を、記憶とは別に器として持つ）。
 *
 * **なぜ記憶だけでは足りないか。** 「毎朝 issue を見て進めておいて」は、記憶に
 * 書けば根拠として残るが、時刻が来たことを誰も教えてくれない。発意 tick で
 * 思い出せるかはそのときの判断に委ねられ、取りこぼしても誰も気づかない。
 * ここに置いた依頼は時刻が来れば必ずクローンの受信箱へ届く。
 *
 * 逆に、**判断の根拠は依然として記憶側にある**。ここに持つのは「いつ起こすか」と
 * 「何を頼まれたか」だけで、やるかやらないか・どうやるかはクローンが決める。
 */
export const scheduledRequestSchema = z.object({
  kind: scheduleKindSchema,
  spec: scheduleSpecSchema,
  /** 依頼の全文。時刻が来たらそのままクローンへ渡る。 */
  request: z.string().min(1),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
  /**
   * 前回この依頼で動いた時刻（定期の予定でも、人間が手で起こした分でも動く）。
   *
   * 「前にいつ見たか」が分からないと、同じ仕事を毎回まっさらから起こすことになる
   * （＝同じ issue に何本もマネージャーが立つ）。重複を数の上限で止めるのは
   * 禁止2に触るので、材料として渡して判断に使わせる。
   *
   * **これは観測用であって、次の予定を数える基準ではない**（下の
   * `lastScheduledRunAt` がその役）。
   */
  lastRunAt: isoDateTime.optional(),
  /**
   * 前回**定期の予定で**動いた時刻。次の予定を数える基準。
   *
   * `lastRunAt` と分けてあるのは、**手で起こした1回で位相を動かさない**ためである。
   * 人間が `POST /schedule/:kind/run` で余分に1回起こすのは「予定に代えて割り込む」
   * ことではない（`Scheduler.run` の契約）。ここを一緒にすると、手動実行の時刻が
   * 基準になり、再起動した瞬間に定期の予定がその分ずれる。
   */
  lastScheduledRunAt: isoDateTime.optional(),
  /**
   * 「この発火を引き受けたが、まだ終わっていない」印。
   *
   * **確定（claim）と完了を分けるためにある。** 引き受けた時点で印を付け、ターンが
   * 終わってから消す。器を作り直したときにこの印が残っていれば、その回は
   * **モデルに届かないまま失われた可能性がある**ので、依頼の本文つきで配り直す。
   *
   * 印が無く基準（`lastScheduledRunAt`）だけが進んでいると、claim の直後に落ちた
   * 発火は「もう動いた」と見えて、日次なら翌日・週次なら翌週まで消える。逆に印だけで
   * 基準を持たないと、動いた後に落ちたときの二重実行を止められない。**両方要る。**
   */
  pendingRun: z.object({ at: isoDateTime, cause: z.enum(['schedule', 'manual']) }).optional(),
});

export type ScheduleKind = z.infer<typeof scheduleKindSchema>;
export type ScheduleSpec = z.infer<typeof scheduleSpecSchema>;
export type ScheduledRequest = z.infer<typeof scheduledRequestSchema>;

/**
 * 既定の仕込み（日報・発意 tick）の位相。
 *
 * **これは「依頼」ではない。** 継続中の依頼（`ScheduledRequest`）は人間かクローンが
 * 書いた本文と周期を持ち、`schedule_list` / `GET /schedule` に現れて外せるものである。
 * こちらが持つのは「前回いつ動いたか」だけで、本文も周期も持たない（周期は環境変数、
 * やることを決めるのはクローンである）。
 *
 * **同じ行として持たないのは、既定の仕込みがクローンから「継続中の依頼」に見えて
 * `schedule_remove` で消せてしまうからである。** `tools.ts` の `schedule_list` は
 * ストアの `list()` を直に読み、説明文で「既定の日報・発意 tick はここには出ない」と
 * 約束している。器を1つにまとめると、その約束が静かに破れる。
 *
 * **これが無いと、器を作り直すたびに位相が捨てられる。** `schedule.ts` の `start()` は
 * 既定の仕込みへ `now + 周期` を置くだけなので、周期より短い間隔で再デプロイが続けば
 * 発意 tick は**一度も発火しない**（継続中の依頼について `#firstDue` が書いている穴と
 * まったく同じもの。実測: 2026-08-19 の本番の再デプロイで、動いていた発意 tick の
 * 次回が1時間先へずれた）。
 */
export const schedulePhaseSchema = z.object({
  kind: z.string().min(1),
  /**
   * 前回**定期の予定で**発火した時刻。次の予定を数える基準。
   *
   * `ScheduledRequest` の同名フィールドと同じ役だが、あちらは「引き受けた印
   * （`pendingRun`）を消すとき」に進む。こちらは**発火の瞬間**に進む — 既定の仕込みには
   * 引き受けの印が無いため。失敗の向きが違うので、同じものとして読まないこと
   * （`schedule.ts` の `#recordPhase` にその差を書いてある）。
   */
  lastScheduledRunAt: isoDateTime.optional(),
  /**
   * 手で起こした分も動く観測用の時刻。
   *
   * 分けてあるのは `ScheduledRequest` と同じ理由である（手で起こした1回で位相を
   * 動かさない）。人間が `/run self_initiative` を叩くたびに定期の予定がずれるのは、
   * `Scheduler.run` の「予定に代えて割り込むのではなく、余分に1回起こす」に反する。
   */
  lastRunAt: isoDateTime.optional(),
});

export type SchedulePhase = z.infer<typeof schedulePhaseSchema>;

// ---------------------------------------------------------------------------
// 引き受けたまま終わっていない仕事（未了の器）
// ---------------------------------------------------------------------------

/**
 * その未了が何から生まれたか。
 *
 * **「誰が言ったか」ではなく「どの起点から来たか」である。** 起点を落とすと、
 * 一覧を見たクローンが「これは人間との約束か、自分で思い立ったことか」を
 * 区別できない。取り返しのつかなさも急ぎ方もそこで変わる。
 */
export const commitmentOriginSchema = z.enum(['human', 'manager', 'external', 'self']);

/**
 * 引き受けたまま終わっていない仕事1件（PRD「自律」の器を、単発の依頼へ広げたもの）。
 *
 * **なぜ受信箱と日誌だけでは足りないか。** 受信箱の未読はプロセスが死んでも残るが、
 * **ターンが終われば消える**（`clone.ts` の `#forget`）。消す根拠は「失敗が記録
 * された」ことであって「仕事が終わった」ことではない。したがって「受け取って、
 * 返事はしたが、まだ着手していない」依頼はターンの終了と同時にどの器からも消え、
 * 残るのは日誌の散文だけになる。**日誌は追記専用で状態を持たない**ので、そこから
 * 「まだ終わっていないもの」を数え上げる手立ては誰にも無い。
 *
 * これは PRD「自律」が継続する依頼について既に書いている理由そのものである —
 * 「記憶に書くだけでは足りない。記憶は時計を持たないので、そこにだけ書いた依頼は
 * 思い出せるかどうかの賭けになり、取りこぼしても誰も気づかない」。**単発の依頼にも
 * 同じことが起きる。** 器を持つのは `manager_start` した仕事（JobStore）と
 * `schedule_create` した定期の依頼（ScheduleStore）だけで、その間が空いていた。
 *
 * **ここに持つのは「何を頼まれたか」と「まだ片付いていない」の2値だけである。**
 * 順序も優先度も締切も持たない — それらは PRD「自律」が器に持たせてはいけないと
 * 書いている「やることの一覧」の側であり、判断はクローンに残す。器がするのは
 * **忘れさせないこと**だけで、何を先にやるか・そもそもやるかは毎回クローンが
 * 記憶に照らして決め直す。
 */
export const commitmentSchema = z.object({
  id: z.string(),
  /**
   * 受け取った（あるいはクローンが自分で立てた）時刻。
   *
   * **これが「齢」の出所である。** 優先度のフィールドを持たない代わりに、
   * どれだけ放置されているかを見て判断できるようにしてある。
   */
  at: isoDateTime,
  origin: commitmentOriginSchema,
  /**
   * どこから来たか（会話 id / マネージャー id / webhook の source）。
   *
   * 自分で立てたもの（`self`）には無い。
   */
  source: z.string().optional(),
  /**
   * 何を頼まれたか（全文）。
   *
   * **要約にしないこと。** 一覧で切るのは表示側の仕事で、器が要約を持つと
   * 「頼まれた内容そのもの」が二度と取れなくなる。
   */
  body: z.string(),
  /** 片付いた時刻。無ければ未了。 */
  closedAt: isoDateTime.optional(),
  /**
   * どう片付いたか（閉じた側が書く1行）。
   *
   * **「閉じた」だけを残さない。** 人間が後から否定できることが最終承認の実体で
   * あり（north_star）、何をもって終わりとしたのかが無いと否定のしようがない。
   */
  closedReason: z.string().optional(),
});

export type CommitmentOrigin = z.infer<typeof commitmentOriginSchema>;
export type Commitment = z.infer<typeof commitmentSchema>;

// ---------------------------------------------------------------------------
// ジョブ・承認待ち
// ---------------------------------------------------------------------------

/**
 * ジョブの状態。
 *
 * - `running`: マネージャーが手を動かしている
 * - `waiting_human`: 上（クローン、必要なら人間）の返事待ちで、**その仕事だけ**が止まっている
 * - `done`: **マネージャー自身のターン**が終わって待機中。セッションは生きているので
 *   追加指示を送れる。その下で作業者が走っているかまでは見ていない
 * - `failed`: セッションが落ちた
 * - `lost`: **前のセッションへ戻れなかった。** 自動では挑み直さない
 * - `stopped`: **明示的に止められ、runner のセッション一覧から消えたことを確かめた
 *   終端。** ただし「話しかけても続かない」は誤りだった（2026-08-22 訂正）——
 *   デーモンが**自動では**起こし直さないだけである（`restore()` / `#reattach()`
 *   のホワイトリストは `running` / `waiting_human` のみで `stopped` を含まない。
 *   `manager.ts`）。`abort()` は `job.sessionId` を消さないので、**人間・クローン
 *   の明示的な `manager_send` なら続きへ戻せる**（`lost` と同じ扱い。`send()` が
 *   `record.attached === false` を見て resume を投げ、戻れたら `status` を
 *   `running` へ書き戻す）。ここを本当に「続かない」にすると、人間が止めた
 *   Claude Code のセッションを `--resume` で戻せる能力を消すことになり、
 *   `docs/north_star.md` の禁止2（追加制限禁止）に触れる
 *
 * 「終わったら片付ける」ためのものではない。人間が Claude Code の窓を開いたまま
 * にしておくのと同じで、`done` は死ではなく待機である。
 *
 * **どれも「デーモンが観測できたこと」でしかない。** ここに並んでいるのは仕事の
 * 進み具合ではなく、セッションの見え方である。`running` は「走らせた」であって
 * 「進んでいる」ではない（分類器の拒否で手が止まっていても `running` のままで、
 * それは `manager_list` が状態に添える拒否の件数のほうに出る）。
 *
 * **`lost` を `done` と一緒にしない。** `done` は「終えて待っている」であり、
 * 話しかければ続く。`lost` はそのどちらでもない — **続ける手立てが無い**。ここを
 * 潰すと、戻せなかった仕事が「完了」として片付き、誰も起こし直さないまま消える。
 * クローンが「起こし直す対象」として見分けられる形で残すためにある
 * （roadmap M5 受け入れ基準4）。
 *
 * **ただし `lost` は「成果が無い」ではない。** 観測しているのは「戻れなかった」
 * ことだけで、デーモンは PR もブランチも見に行かない（リポジトリの事情は
 * マネージャーの領域である）。落ちる直前にマージまで済ませていた仕事が `lost` に
 * なった例が実際にある。**起こし直すかどうかは、リモートを確かめてから決める。**
 *
 * **`stopped` を `done` と一緒にしない。** どちらも「セッションは生きているように
 * 見えるかもしれない」状態だが、`done` は**自分から手を離しただけ**（待てば/話し
 * かければ続く）で、`stopped` は**外から止められ、実際に runner から消えたことを
 * 確かめた**終端である。ここを混ぜると、止めたはずのマネージャーが「待機中」と
 * 見えて話しかけられる相手が残る（`manager.ts` の `abort()` の doc）。
 */
export const jobStatusSchema = z.enum([
  'running',
  'waiting_human',
  'done',
  'failed',
  'lost',
  'stopped',
]);

export type JobStatus = z.infer<typeof jobStatusSchema>;

/**
 * workspace の所在（M4 で置く継ぎ目）。
 *
 * 文字列のパスだけにしないのは、**runner が増えたときに移送の話になる**からである
 * （M5）。いまは `runner-volume` しか使わないが、共有 FS や git からの再構築へ
 * 伸ばせる形で JobStore に残しておく。ここが欠けると、runner が落ちたときに
 * 「どこで何を触っていたのか」が復元できない。
 */
export const workspaceLocatorSchema = z.discriminatedUnion('kind', [
  /** その runner に固定された volume。M4 の既定。 */
  z.object({
    kind: z.literal('runner-volume'),
    runnerId: z.string(),
    path: z.string(),
  }),
  /** 複数 runner から見える共有ファイルシステム（M5 の選択肢）。 */
  z.object({ kind: z.literal('shared-volume'), path: z.string() }),
  /** git から作り直す（M5 の選択肢。未コミット差分は別途退避が要る）。 */
  z.object({
    kind: z.literal('git'),
    repository: z.string(),
    ref: z.string(),
    patchId: z.string().optional(),
  }),
]);

export type WorkspaceLocator = z.infer<typeof workspaceLocatorSchema>;

/**
 * 貸し出し期限（lease）— **この委譲を、いまどのプロセスが握っているか**（M5 PR4）。
 *
 * ## なぜ `runnerId` だけでは足りないか
 *
 * `runnerId` は宛先の名前で、器を作り直しても同じである（台帳の鎖
 * `manager_id → runner_id` がそれで繋がっている）。だから名前だけでは
 * 「いまその名前に応えているプロセスが、さっき仕事を渡した相手と同じか」が言えない。
 * `instanceId`（runner が起動ごとに作る乱数。`apps/runner/src/app.ts`）を並べて初めて
 * **握っているプロセスの同一性**が表せる。
 *
 * ## なぜ期限が要るか
 *
 * 「落ちた」は観測の欠落であって停止の証明ではない（roadmap M5）。黙った器の仕事を
 * 別の器へ起こし直すと、実は生きていた器と合わせて**同じマネージャーが2台で走る** —
 * `gh pr create` のような取り返しのつかない操作が二重に走る。だから引き取る側は
 * 「もう動いていない」を**片側だけで言える材料**を要る。それがこの期限である
 * （判定は `lease.ts` の `judgeLease`、runner 側の自己失効は `runner.ts`）。
 *
 * **時刻はすべてデーモンの時計である。** 器をまたいで時計を合わせる前提を置かない
 * （合っていないことに気づく場所が無い）。runner へ渡すのは `ttlMs`（相対）だけで、
 * あちらは受け取った瞬間から自分の時計で数える。
 */
export const jobLeaseSchema = z.object({
  /** 貸し出し先の宛先の名前。**台帳の鎖と同じ値**（ここで別の名前へ繋ぎ変えない）。 */
  runnerId: z.string(),
  /**
   * いまその名前に応えているプロセス（runner の `/health` の `instanceId`）。
   *
   * **欠けることがある。** `identity()` を持たない runner（同一プロセスの
   * `runner-local` や古い器）は名乗らないので、そのときは**判定しない**
   * （「入れ替わっていない」とも「入れ替わった」とも読まない。`judgeLease` 参照）。
   */
  instanceId: z.string().optional(),
  /**
   * 世代番号。**引き取るたびに1つ増える**（fencing token）。
   *
   * runner はセッションごとに最後に受け取った世代を覚えていて、**それより古い世代の
   * 命令を拒む。** これが無いと、引き取りの後に遅れて届いた古い命令が、新しい世代の
   * セッションへ黙って混ざる。
   *
   * **返しても 1 へ戻さない**（返却は `releasedAt` を立てるだけで、この欄は残す）。
   *
   * かつては返却でこの欄ごと消していた。「世代が意味を持つのは runner のセッションが
   * 生きている間だけだから、数え直してよい」という理屈だったが、**その前提は保証
   * されていなかった。** 返却の契機（`closed`）は runner から遅れて届きうるので、
   * 「返した」と「そのセッションはもう無い」がずれる。ずれた側で数え直すと、runner が
   * 覚えている世代より小さい世代を渡すことになり、**runner はその命令を拒む
   * （409）** — 生きているマネージャーへ永久に届かなくなり、届かないことを
   * 「戻せなかった」と読んだ側が新しく起こし直して**二重実行になる。**
   *
   * だから単調に増やす。**返却は「もう握っていない」を表すだけで、数え直しの合図
   * ではない。**
   */
  fence: z.number().int().nonnegative(),
  /** 貸し出した時刻。 */
  grantedAt: isoDateTime,
  /**
   * デーモンが**最後にこの貸し出し先の生存を確かめた時刻**。
   *
   * ここが古いことは「落ちた」を意味しない（見に行っていないだけのこともある）。
   * 判定に使うのは `judgeLease` であって、この値の古さそのものではない。
   */
  seenAt: isoDateTime,
  /**
   * 貸し出し先が**自分で畳むまでの猶予**（ミリ秒）。runner へ渡した値の写しである。
   *
   * 写しを持つのは、引き取る側が「あちらはいつ自分で畳むと約束したか」を台帳だけから
   * 言えるようにするため（渡した値を後から変えても、この委譲に効いている約束は
   * 渡した時のものである）。
   */
  ttlMs: z.number().int().positive(),
  /**
   * **返した時刻**（もう握っていない）。立っていれば、次の引き取りは期限を待たない。
   *
   * **消すのではなく印を立てるのは、世代（`fence`）を残すためである**（上の項）。
   * 返却の契機は「持ち主自身がそのセッションを終えたと言った」（`closed`）か
   * 「止まったと確かめた停止」だけで、**確かめていない停止では立てない。**
   */
  releasedAt: isoDateTime.optional(),
});

export type JobLease = z.infer<typeof jobLeaseSchema>;

export const jobSchema = z.object({
  id: z.string(),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
  status: jobStatusSchema,
  /** マネージャーの識別子。ジョブ1件 = マネージャー1本なので id と同じ値が入る。 */
  managerId: z.string().optional(),
  /** SDK のセッション id。M4 の resume の足がかり。 */
  sessionId: z.string().optional(),
  /**
   * SDK が生ログを預けるときの scope（SessionStore の `projectKey`）。
   *
   * **これが無いと、器を作り直したあとに生ログを引き当てられない。** ローカルの
   * トランスクリプトはコンテナと一緒に消えるので、可観測性の最下段へ降りる経路は
   * `projectKey` + `sessionId` の対で持つしかない（PRD「可観測性」）。
   */
  projectKey: z.string().optional(),
  summary: z.string(),
  /** クローンが出した依頼の全文。 */
  request: z.string().optional(),
  /** マネージャーの作業ディレクトリ（人間が Claude Code を開く場所と同じ）。 */
  cwd: z.string().optional(),
  /**
   * どの manager-runner で走っているか（M4）。
   *
   * `manager_id → runner_id → session_id → workspace` の鎖をここで持つ。
   * **これが無いと、runner が増えた瞬間に `manager_send` の宛先が決まらない。**
   * 1台構成でも最初から残しておく（後から足すと、既存のジョブに宛先が無い）。
   */
  runnerId: z.string().optional(),
  /** workspace の所在。runner affinity と合わせて復元できるようにする。 */
  workspace: workspaceLocatorSchema.optional(),
  /**
   * 貸し出し期限（M5 PR4）。**いまどのプロセスがこの委譲を握っているか。**
   *
   * `runnerId` が「どの宛先か」なのに対し、こちらは「その宛先のどのプロセスか」と
   * 「いつまで握っていると約束したか」である。
   *
   * **欠けている＝判定材料が無い、であって「握られていない」ではない。** それでも
   * `judgeLease` は欠けているときに引き取りを許す — この欄が無かった頃のジョブと、
   * 貸し出しを名乗らない runner のジョブが**永久に引き取れなくなる**のを避けるため
   * である（能力の削除になる。north_star 禁止1）。判定できないことは、判定の結果の
   * 側ではなく `judgeLease` の返り値の種類として持つ。
   */
  lease: jobLeaseSchema.optional(),
  /**
   * 退避済みトランスクリプト以外の生ログへの入口は**ここに持たない**。
   *
   * 走行中の生ログは manager-runner のディスクの上にあり、デーモンはその中を
   * 仮定しない（runner のローカルパスを台帳に書くと、runner が入れ替わった
   * 瞬間に嘘になる）。降り方は runner の API → アーカイブ → 預かった
   * セッションの生ログ、の順である。
   */
  /** 退避済みトランスクリプト（TranscriptArchive の id）。 */
  archiveIds: z.array(z.string()).optional(),
  /** 直近の報告。一覧でクローンが状況を掴むためのもの。 */
  lastReport: z.string().optional(),
  /**
   * 直近の報告が**報告ではなく失敗**だったこと（SDK が「これは応答ではない」と
   * 言った回）。応答として終わった回では消える。
   *
   * **`status` では表せない。** あちらは仕事の状態（`done` は「終えて待機中。
   * 話しかければ続く」）で、ここは**直近の1ターンがどう終わったか**である。
   * 支出上限に当たった回はセッション自体は生きているので、`status` を `failed`
   * へ倒すと嘘になる（クローンは話しかけ直せる）。
   *
   * **これが無いと、人間の一覧に「報告が来た」としか出ない。** 直す前は
   * `You've hit your org's monthly spend limit …` が `lastReport` にそのまま入り、
   * マネージャーが何か報告してきたように見えていた（`sdk-failure.ts` の doc）。
   */
  lastFailure: z
    .object({
      /** SDK の語そのまま（`billing_error` / `error_during_execution` など）。 */
      code: z.string(),
      /** どの印で分かったか（`sdk-failure.ts` の `SdkFailureVia`）。 */
      via: z.string(),
      at: isoDateTime,
    })
    .optional(),
});

export type Job = z.infer<typeof jobSchema>;

/** ask_human の承認待ちキュー（PRD「権限境界」）。 */
export const pendingApprovalSchema = z.object({
  id: z.string(),
  createdAt: isoDateTime,
  question: z.string(),
  context: z.string().optional(),
  /** どのマネージャーの件か（= manager_id）。 */
  jobId: z.string().optional(),
  /**
   * マネージャー側で止まっている確認の id。
   *
   * **`jobId` だけでは足りない。** 1本のマネージャーが同時に複数を待つので、
   * ここが欠けると人間の回答をどの確認へ返せばよいか決められず、答えたのに
   * 仕事が再開しない。人間へ回る経路の端から端まで、この id を運ぶこと。
   */
  requestId: z.string().optional(),
  answeredAt: isoDateTime.optional(),
  answer: z.string().optional(),
});

export type PendingApproval = z.infer<typeof pendingApprovalSchema>;

// ---------------------------------------------------------------------------
// chat ストリーム（daemon → CLI）
// ---------------------------------------------------------------------------

/**
 * SSE で流す chat のイベント。CLI はこれだけを見て表示する
 * （CLI は core を埋め込まない — architecture.md「脳は1インスタンス」）。
 */
export const chatStreamEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  /**
   * 受信箱に積んだ（＝受理したが、まだ順番が来ていない）。
   *
   * **`thinking` に潰さないこと。** クローンは受信箱を一件ずつ取り出して直列に
   * 処理するので（architecture.md「同時実行モデル」）、先客（蒸留・マネージャー
   * との往復・自律の起点）が走っているあいだ、届いた発言は**受理されているのに
   * 誰も考えていない**。`thinking` は「入力がモデルへ渡って最初の出力を待って
   * いる」という別の事実で、`queued` の後に必ず来る（順番が来たとき）。
   *
   * 1つの語へ寄せると、待っている理由が「順番待ち」なのか「モデルが考えている」
   * なのかを見る側から区別できなくなり、**長く待たされたときにこそ嘘になる**
   * （数分の順番待ちが「考えている」と表示される）。2つの状態には2つの語を置く。
   */
  z.object({ type: z.literal('queued') }),
  z.object({ type: z.literal('thinking') }),
  /**
   * 枠（利用上限）が閉じていて、この合図はそもそもモデルへ投げていない。
   *
   * **`queued` にも `thinking` にも潰さないこと。** `queued` は「先客が居て
   * 順番を待っている」で、`thinking` は「モデルが考えている」だが、どちらも
   * 前提は同じ — **入力はいずれモデルへ渡る**。`usage_limited` はそれが崩れて
   * いる場面である。枠が閉じているあいだ、届いた合図はモデルへ一度も渡らず、
   * 保持されたまま次の合図（人間の発言・自律の発意など）を待つ
   * （`clone.ts` の `#usageBlocked` / `#deferred`）。3つ目の語を置かず
   * どれかへ寄せると、`queued` の doc と同じ理由で**長く待たされたときにこそ
   * 嘘になる** — 枠が数時間閉じていても「順番待ち」や「考えている」と表示され
   * 続け、実際には誰も手をつけていないことが画面から見えなくなる。
   *
   * **終端ではない。** 保持したこの合図は、次に別の合図が届いたときに
   * 配り直されて実際に投げられる。ターンの終端は従来どおり `done` と `error`
   * だけである（この合図のあとには必ず `error` が続く — 送り主を待たせない
   * ため、いまは投げられないという結果を終端として返す。ただし枠が閉じたこと
   * 自体は消えない情報なので、その `error` より必ず先に出す）。
   */
  z.object({ type: z.literal('usage_limited'), message: z.string() }),
  z.object({ type: z.literal('tool'), tool: z.string() }),
  z.object({ type: z.literal('ask_human'), approvalId: z.string(), question: z.string() }),
  z.object({ type: z.literal('done') }),
  z.object({ type: z.literal('error'), message: z.string() }),
]);

export type ChatStreamEvent = z.infer<typeof chatStreamEventSchema>;
