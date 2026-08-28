import {
  accountUsageStateSchema,
  agentTokenInputSchema,
  agentTokenViewSchema,
  commitmentSchema,
  createMemoryStores,
  jobSchema,
  jobStatusSchema,
  journalEntrySchema,
  memoryDocumentMetaSchema,
  memoryDocumentSchema,
  pendingApprovalSchema,
  runnerCredentialFingerprintSchema,
  runnerProfileFingerprintSchema,
  scheduleSpecSchema,
  tokenRotationPolicySchema,
  tokenRotationSettingsSchema,
  unreadableCommitmentSchema,
  usageAggregateSchema,
  usageBreakdownSchema,
  waitingKindSchema,
  workspaceLocatorSchema,
  type CloneHost,
  type JournalEntry,
  type ManagerPool,
} from '@alteroid/core';
import type { GenerateSpecOptions } from 'hono-openapi';
import { z } from 'zod';

import { createApp } from './app.js';

/**
 * `GET /openapi.json` `GET /docs` が読む応答スキーマと documentation。
 *
 * `app.ts` を可読に保つため、ここへ分離してある（app.ts が全経路の
 * `describeRoute` で埋まると、肝心の配線が読めなくなる）。
 *
 * **core が既に zod スキーマを持っているもの（記憶・日誌・承認待ち・
 * chat イベントなど）はここで再定義しない。** 再定義すると実装のスキーマと
 * ドキュメントのスキーマが2つに分かれ、いつか必ずずれる（**spec が嘘になる**）。
 * core に無いもの（health の応答・会話一覧・マネージャー要約など）だけを
 * ここで新たに zod で書く。
 *
 * **禁じているのはずれることではなく、ずれが spec の嘘になることである。**
 * その嘘は、**成功応答を返す前に宣言スキーマの `.parse()` へ通す**ことで引き受けて
 * ある（規則は `app.ts`）。通した面では、宣言と実物がずれても spec は嘘にならず、
 * **宣言していないものが載らないだけ**になる — 倒れる向きが安全側に固定される。
 * だから parse を通す面では、外向きの view をここに別に宣言してよい
 * （`accountViewSchema`）。禁止の理由が別の手段で満たされているのであって、
 * 禁止を破って代償を払っているのではない。
 *
 * **parse を外すなら、この根拠はその場で消える。** 宣言だけが core から独立して
 * 残ると、ずれを誰も落とさないまま spec だけが古い、という最も悪い形になる。
 * 外すときは view も同時に捨てて core のスキーマへ戻すこと。
 *
 * view を書くかどうかは、core 側が*永続化*のスキーマかどうかで決まる。
 * `accountViewSchema` の元である `authAccountSchema` は、fs / pg ドライバが同じ行を
 * 保証するための*保存*の形であって、*外へ出す*形とは役割が違う。同じものとして扱うと、
 * 保存側にフィールドが1つ増えた日に**宣言ごと一緒に広がる** — parse を通していても
 * 落とすものが無い（`managerSummarySchema` が `ManagerSummary` を再利用しないのと
 * 同じ理由）。逆に、core 側が最初から外向きに書かれているもの
 * （`runnerCredentialFingerprintSchema` のように値を持たない指紋の形）は、
 * そのまま使ってよい。
 */

// ---------------------------------------------------------------------------
// 汎用のエラー形
// ---------------------------------------------------------------------------

/** ハンドラが手で返す `{ error: '...' }`（404 / 400 / 409 / 415 / 503）。 */
export const errorResponseSchema = z.object({ error: z.string() });

/**
 * `validator('query', ...)` が検査に落ちたときの応答（hono-openapi の既定フック）。
 * `@hono/zod-validator` の 400 とは形が違う（`error` が issue の配列で入る）ので、
 * 手書きの `errorResponseSchema` とは別に持つ。
 *
 * **`json` の経路はもうこの形を返さない（#424）。** `data` にリクエスト本文が
 * 丸写しされる既定であり、資格を運ぶ経路でそれが実際に秘密を応答へ出していた。
 * `app.ts` の `jsonBody` が全経路で `hook` を挟み、`{ error: string }`
 * （＝`errorResponseSchema`）へ畳んでいる。**この形を `json` の経路の 400 の
 * 宣言に書かないこと** —— 書くと spec だけが「まだ `data` が返る」と言い続ける。
 */
export const validationErrorResponseSchema = z.object({
  data: z.unknown(),
  error: z.array(z.unknown()),
  success: z.literal(false),
});

// ---------------------------------------------------------------------------
// /health
// ---------------------------------------------------------------------------

export const healthResponseSchema = z.object({
  ok: z.literal(true),
  pid: z.number().int(),
  /**
   * 実行環境の持ち主として認識されたか（`Authorization: Bearer <state/daemon.json
   * の token>` を提示したとき true）。
   *
   * **トークンそのものは返さない。** かつてはここに載せていたが、この値は
   * `access grant` を実行できる資格そのものになったので、無認証で読める応答に
   * 置けない。CLI は「自分の持っているトークンで operator になれるか」を見て
   * 本人確認する（PID の再利用検知としても同じ強さがある）。
   */
  operator: z.boolean(),
  /** 記憶の置き場（ローカルのパス / PostgreSQL）。接続情報は含めない。 */
  storage: z.string(),
  /** 認証の状態。CLI がログインの要否と手段を知るために読む。 */
  auth: z.object({
    enabled: z.boolean(),
    providers: z.array(z.object({ id: z.string(), label: z.string(), kind: z.string() })),
  }),
});

// ---------------------------------------------------------------------------
// /auth・/access（ログインとアクセス許可）
// ---------------------------------------------------------------------------

const isoDateTimeSchema = z.string().datetime({ offset: true });

/**
 * `/auth/*` `/access/*` が外へ返すアカウントの形。
 *
 * **core の永続化スキーマ（`authAccountSchema`）をそのまま使わない。** あちらは
 * fs / pg のどちらのドライバでも同じ行を保証するための「保存の形」であって、
 * 「外へ出す形」とは別物である。account の行にフィールドが1つ増えた日に、それが
 * 宣言も無いまま自動でここへも乗ってしまうと、`/managers` で塞いだのと同じ穴が
 * auth 側にだけ残ることになる（`managerSummarySchema` が `ManagerSummary`
 * 〈core の interface〉から独立して手書きされているのと同じ形にここも揃える）。
 *
 * フィールドと制約は現状の `authAccountSchema`（`packages/core/src/auth.ts`）と
 * 1対1に写してある。**ここがずれると `openapi.json` が動き、`packages/api-client`
 * 経由で `apps/web` の生成型まで動く** — 増やすときは意図して増やすこと。
 */
const accountViewSchema = z.object({
  id: z.string().min(1),
  /** 表示用の名前。初回のログイン時にプロバイダから貰ったものを入れる。 */
  displayName: z.string().nullable(),
  /** 本人が選んだ連絡先（検証済み）。プロバイダ側の変更で勝手に上書きしない。 */
  email: z.string().nullable(),
  createdAt: isoDateTimeSchema,
  lastLoginAt: isoDateTimeSchema.nullable(),
  /** 許可の2値。`null` なら未許可＝ログインはできるが alteroid は使えない。 */
  grantedAt: isoDateTimeSchema.nullable(),
  /** 誰が許可したか（`operator` = 状態ファイルを読める実行環境の持ち主）。 */
  grantedBy: z.string().nullable(),
});

export const authProvidersResponseSchema = z.object({
  enabled: z.boolean(),
  providers: z.array(z.object({ id: z.string(), label: z.string(), kind: z.string() })),
});

export const loginStartResponseSchema = z.object({
  requestId: z.string(),
  /** 人間のブラウザで開く先。 */
  authorizationUrl: z.string(),
  /** 引き取り時に提示する秘密。**これを持つ端末だけがトークンを受け取れる。** */
  claimSecret: z.string(),
  expiresAt: z.string(),
});

/** ログイン結果の引き取り。まだ終わっていなければ 202 で `pending` が返る。 */
export const loginClaimResponseSchema = z.union([
  z.object({ status: z.literal('pending') }),
  z.object({
    status: z.literal('ready'),
    /** **この1回しか返らない。** ストアには sha256 しか残らない。 */
    token: z.string(),
    account: accountViewSchema,
    /** 許可されていなければ false。ログインできても使えるとは限らない。 */
    granted: z.boolean(),
  }),
]);

/** いま自分が誰として認識されているか。 */
export const meResponseSchema = z.union([
  z.object({ kind: z.literal('operator') }),
  z.object({ kind: z.literal('account'), account: accountViewSchema, granted: z.boolean() }),
]);

export const accountWithIdentitiesSchema = accountViewSchema.extend({
  granted: z.boolean(),
  identities: z.array(
    z.object({
      provider: z.string(),
      subject: z.string(),
      email: z.string().nullable(),
      emailVerified: z.boolean(),
      lastLoginAt: z.string(),
    }),
  ),
});

export const accessListResponseSchema = z.object({
  accounts: z.array(accountWithIdentitiesSchema),
});

export const accessAccountResponseSchema = z.object({ account: accountWithIdentitiesSchema });

// ---------------------------------------------------------------------------
// 会話（/conversations）
// ---------------------------------------------------------------------------

const conversationSchema = z.object({
  conversationId: z.string(),
  startedAt: z.string(),
  updatedAt: z.string(),
  messages: z.number().int(),
  /** 一覧に出す短い抜粋。全文は `GET /conversations/:id` にある。 */
  preview: z.string(),
});

export const conversationsResponseSchema = z.object({
  conversations: z.array(conversationSchema),
  /**
   * 遡った範囲。**人間との往復を何件遡ったか**（マネージャーとの往復・内部
   * ターンは数えない。issue #418）。ここより古い**人間との**会話は出てこない
   * （`scan` を増やせば見える）。
   */
  scanned: z.number().int(),
  /**
   * 窓（`scan`）が日誌の先頭に届いたか。**`GET /conversations/:id` と同じ
   * 意味・同じ名前で揃えてある**（`@alteroid/core` の `reachedStart`）。
   * `false` なら、`scanned` より古い人間との会話が残っている可能性がある。
   */
  reachedStart: z.boolean(),
  /**
   * **この窓の中で** `limit` に収まらず落とした会話の数（窓の外は数えて
   * いない）。
   *
   * この一覧は `scan` で窓を切ったあと `limit` で更に会話数を切って
   * いたが、それを黙ってやっていた（#418 の裏返し ——
   * #418 は「他の種別に食われる」窓、こちらは「自分の種別で溢れる」窓。
   * 人間との会話は増え続けるので、時間が経てば必ず踏む）。
   *
   * `collectConversations(entries)` は窓の全件を既に数え上げているので、
   * この数を出すのに追加の走査は要らない（`slice` の前後の差）。
   *
   * **いつページングを足すか**: この値が実際に断り書きとして出るように
   * なったら、ページング（あるいは `limit` を画面から動かせる形）を検討
   * する時期である。出ていないなら要らない —— 判断の材料は断り書きの
   * 有無であって、会話の本数ではない（依頼者の観測、2026-08-24: `scan=10000`
   * で会話15件・先頭到達。`limit` の上限 200 にも画面の既定 30 にも遠い）。
   */
  hiddenByLimit: z.number().int(),
});

const conversationMessageSchema = z.object({
  id: z.string(),
  at: z.string(),
  /** `inbound` = 人間の発言 / `outbound` = クローンの返答。 */
  role: z.enum(['inbound', 'outbound']),
  text: z.string(),
});

export const conversationDetailResponseSchema = z.object({
  conversationId: z.string(),
  messages: z.array(conversationMessageSchema),
  /**
   * 人間との往復を何件遡ったか。**一覧（`scanned`）と同じ意味で、詳細にも要る**
   * — この口も新しい方から `scan` 件（人間との往復だけを数えて。issue #418）
   * しか見ないので、ここが無いと「この会話はこれで全部」と読める応答になる。
   */
  scanned: z.number().int(),
  /**
   * 遡った窓が日誌の先頭に届いたか。**`messages` が空のときの意味がこれで変わる。**
   *
   * - `true` — ここに無いものは無い（`404` を返してよい状態）
   * - `false` — **無いとは言えていない。** 窓の外に続きが残っている可能性がある
   *
   * 「無い」と「判定できない」を2値へ潰さないために持っている（潰すと、判定できない
   * 場合が黙ってどちらかへ倒れる）。`scan` を増やせば窓は広がる。
   */
  reachedStart: z.boolean(),
});

// ---------------------------------------------------------------------------
// 記憶（/memory）— core の memoryDocument(Meta)Schema をそのまま使う
// ---------------------------------------------------------------------------

export const memoryListResponseSchema = z.object({ documents: z.array(memoryDocumentMetaSchema) });
export const memoryReadResponseSchema = z.object({ document: memoryDocumentSchema });
export const memoryDeleteResponseSchema = z.object({ ok: z.literal(true), slug: z.string() });

// ---------------------------------------------------------------------------
// 日誌（/journal, /journal/stream）— core の journalEntrySchema をそのまま使う
// ---------------------------------------------------------------------------

export const journalListResponseSchema = z.object({ entries: z.array(journalEntrySchema) });

/**
 * `journalEntrySchema` は discriminatedUnion。`/reports` が実際に返すのは
 * `daily_report` の枝だけなので、**再定義せず union から取り出す** — 手で
 * 書き直すと、schema.ts 側に日報の項目が増えたときにここだけ古いままになる。
 */
function journalVariant(type: JournalEntry['type']) {
  const found = journalEntrySchema.options.find((option) => option.shape.type.value === type);
  if (found === undefined) {
    throw new Error(`journal エントリ種別 "${type}" が見つからない（schema.ts の変更を確認）`);
  }
  return found;
}

const dailyReportEntrySchema = journalVariant('daily_report');

export const reportsResponseSchema = z.object({ reports: z.array(dailyReportEntrySchema) });

// ---------------------------------------------------------------------------
// 承認待ち（/approvals）— core の pendingApprovalSchema をそのまま使う
// ---------------------------------------------------------------------------

/**
 * 一覧の1件は core の `pendingApprovalSchema` に `updatedAt` を足しただけの形
 * （`.extend()`）。
 *
 * **新しい情報ではない。** `createdAt` と `answeredAt`（付いていれば）は
 * `pendingApprovalSchema` に既に載っており、受け手は `answeredAt ?? createdAt`
 * を自分で導けた。この欄はその導出をサーバ側で一度だけ行い、受け手に
 * やらせるのをやめるだけの変更である。導出は `packages/core/src/schema.ts` の
 * `approvalUpdatedAt` を呼ぶ（#269）。**ここで `??` を書き直さない。**
 *
 * **`.extend()` を土台にする理由。** ファイル冒頭の約束（core が既に zod
 * スキーマを持つものはここで再定義しない）に当たらない — `pendingApprovalSchema`
 * を再定義するのではなく、その上に派生欄を1つ足すだけで、元の全欄はそのまま
 * 通る。`updatedAt` は永続化の欄ではなく応答専用の派生値なので、`commitments`
 * と同じく「外向きの view を別に書く」問題（保存側にフィールドが増えた日に
 * 宣言ごと広がる）にも当たらない——土台が `pendingApprovalSchema` 自身なので、
 * 広がるとしてもそれは core 側の欄が増えたときだけである。
 *
 * **`total` / `nextCursor` は頁の封筒（issue #432）。** `order` / `limit` /
 * `cursor` のいずれかを明示的に渡したときだけ載る——何も渡さない既定の呼びでは、
 * この2欄は応答に**鍵として現れない**（`undefined` ではなく無い。
 * `apps/daemon/src/app.ts` の `/approvals` ハンドラが `optedIn` のときだけ
 * object へ足す）。opt-in の理由は `.claude/skills/listing-and-detail/SKILL.md`
 * ——既存の呼び手（画面・CLI）の応答をこの変更で変えないため。
 */
export const approvalsResponseSchema = z.object({
  approvals: z.array(pendingApprovalSchema.extend({ updatedAt: isoDateTimeSchema })),
  total: z.number().int().optional(),
  nextCursor: z.string().optional(),
});

export const approvalsAnswerResponseSchema = z.object({
  results: z.array(z.object({ id: z.string(), ok: z.boolean(), error: z.string().optional() })),
});

export const okResponseSchema = z.object({ ok: z.literal(true) });

// ---------------------------------------------------------------------------
// 外部イベントの入口（/events）
// ---------------------------------------------------------------------------

export const eventAcceptedResponseSchema = z.object({ ok: z.literal(true), id: z.string() });

// ---------------------------------------------------------------------------
// 時間起点のジョブ（/schedule）
// ---------------------------------------------------------------------------

export const scheduleStatusSchema = z.object({
  kind: z.string(),
  description: z.string(),
  /** 次の発火時刻（ISO 8601）。 */
  nextAt: z.string(),
  /**
   * 継続中の依頼として仕込まれたものだけが持つ。
   *
   * 既定の日報・発意 tick には無い（あれは設定で回っているもので、依頼ではない）。
   * ここが出ているものは `DELETE /schedule/:kind` で外せる。
   */
  request: z.string().optional(),
  /**
   * 依頼を仕込んだときの周期そのもの。**`request` と同じく、仕込まれたものだけが持つ。**
   *
   * `description` は散文（「毎日 09:00（ローカル時刻）: …」）で、機械が読み戻せる形では
   * ない。編集画面が周期を prefill するにはこの値が要る — `POST /schedule` は
   * upsert なので（同じ kind なら置き換わる）、これが無いと編集フォームは周期を
   * 既定値から始めるしかなく、**本文だけ直したつもりの保存が周期を黙って書き換える。**
   *
   * **既定の日報・発意 tick には無い。それは「分からない」ではなく「無い」である**
   * — あれはコードに書かれた既定で、`spec` という値そのものが存在しない
   * （下の `createdAt` の doc と同じ理由）。
   *
   * **加算のみの変更である**（#235 の `createdAt` / `updatedAt` と同じ形）。既存の欄は
   * 1つも変えていないので、いまの消費側は壊れない。
   */
  spec: scheduleSpecSchema.optional(),
  /**
   * 仕込まれた時刻 / 最後に仕込み直された時刻（ISO 8601）。
   *
   * **`request` と同じく、仕込まれたものだけが持つ。** 既定の日報・発意には
   * 無い——「分からない」のではなく、**コードに書かれた既定なので作成という
   * 出来事が存在しない。** `unknown` を入れないこと（あれは「在るはずだが
   * 根拠が無い」を表す値である）。
   *
   * **加算のみの変更である**（#235）。既存の欄は1つも変えていないので、
   * いまの消費側は壊れない。CLI がこれを出せなかったのは、**API が返して
   * いなかったから**である（`docs/PRD.md`「片方でしかできないことを作らない」）。
   */
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
  /** 前回この kind で発火した時刻（ISO 8601）。一度も動いていなければ無い。 */
  lastRunAt: z.string().optional(),
});

export const scheduleListResponseSchema = z.object({ entries: z.array(scheduleStatusSchema) });

// ---------------------------------------------------------------------------
// 引き受けたまま終わっていない仕事の台帳（/commitments）
// ---------------------------------------------------------------------------

/**
 * 台帳の1件は core の `commitmentSchema` をそのまま外へ出す（`/approvals` と同じ扱い）。
 *
 * **外向きの view を別に書かない理由は「伏せるものが1つも無い」ことである。** この器が
 * 持つのは「何を頼まれたか」と「まだ片付いていない」の2値だけで、鍵も内部の識別子も
 * 入っていない（`packages/core/src/schema.ts` の `commitmentSchema`）。したがって
 * core 側にフィールドが増えたときに宣言ごと広がっても、それは**外へ出してよいものが
 * 増えた**というだけで、伏せていたものが漏れる形にはならない。
 *
 * 逆に view を別に書くと、器に持たせた内容と外から読める内容がずれ、**人間が API で
 * 見た台帳とクローンが `commitment_list` で見る台帳が違う**という形になる。それは
 * PRD「可観測性」が塞ごうとしているものそのものである。
 *
 * **`updatedAt` はその2つの懸念のどちらにも当たらない形で足してある。**
 * `commitmentSchema.extend({ updatedAt: ... })` は再定義ではなく（元のスキーマを
 * 土台にして派生欄を1つ足すだけ）、かつ別 view でもない（`commitmentSchema` の
 * 全欄はそのまま通る）。`closedAt` と `at` は既に応答に載っており、受け手は
 * `closedAt ?? at` を自分で導けた——この欄は新しい情報ではなく、その導出を
 * サーバ側で一度だけ行うことで受け手にやらせるのをやめる変更である。導出は
 * `packages/core/src/schema.ts` の `commitmentUpdatedAt` を呼ぶ（#269）。
 * **ここで `??` を書き直さない。**
 */
export const commitmentListResponseSchema = z.object({
  entries: z.array(commitmentSchema.extend({ updatedAt: isoDateTimeSchema })),
  /**
   * 読めなかった行（issue #296）。**「無い」でも「片付いた」でもない第3の状態。**
   *
   * `CommitmentStore.list`（`packages/core/src/store.ts`）が返す
   * `CommitmentList.unreadable` をそのまま外へ出す。クローンの `commitment_list`
   * が末尾に足す断りと同じ材料を、人間の側（Web UI・API を直接叩く側）にも
   * 渡す——片方にしか無いと、人間が API で見た台帳とクローンが見る台帳が
   * 違う、という上の doc が塞ごうとしている形そのものになる。
   *
   * **窓（`limit`/`cursor`）では絶対に切らない。** `entries` とは違い、opt-in
   * していても `unreadable` は常に全件を返す（`apps/daemon/src/app.ts` の
   * `GET /commitments` ハンドラの doc）。
   */
  unreadable: z.array(unreadableCommitmentSchema),
  /**
   * 保持上限を超えて物理削除された、片付いた行の累計件数（issue #416）。
   *
   * `CommitmentStore.list` が返す `CommitmentList.trimmedClosed`
   * （`packages/core/src/store.ts`）をそのまま外へ出す——クローンの
   * `commitment_list` が末尾に足す断りと同じ材料を、人間の側（Web UI・API を
   * 直接叩く側）にも渡す。**理由は `unreadable` の直上の doc と同じ**（片方に
   * しか無いと、人間が API で見た台帳とクローンが見る台帳が違うことになる）。
   *
   * **`unreadable` と同じく窓（`limit`/`cursor`）では切らない。** 頁ではなく
   * 累計件数そのものなので、そもそも「切る」対象ではない。
   *
   * **契約を守れている実装（`storage-pg` / 現行の `storage-fs` 以外）は常に
   * `0` を返す。** いまのところ `storage-fs` だけがこの値を増やしうる
   * （`packages/core/src/store.ts` の `CommitmentList` の doc）。
   */
  trimmedClosed: z.number().int().nonnegative(),
  /**
   * **`total` / `nextCursor` は頁の封筒（2026-08-25、人間の明示の「はい」を受けて
   * `limit`/`cursor` の opt-in で足した）。** `/approvals` の `total` / `nextCursor`
   * と同じ形——`limit` / `cursor` のいずれかを明示的に渡したときだけ載る。何も
   * 渡さない既定の呼びでは、この2欄は応答に**鍵として現れない**（`undefined`
   * ではなく無い。`apps/daemon/src/app.ts` の `GET /commitments` ハンドラが
   * `optedIn` のときだけ object へ足す）。opt-in の理由は `approvalsResponseSchema`
   * の doc と同じ——既存の呼び手（画面・CLI・クローンの `commitment_list`）の
   * 応答をこの変更で変えないため。
   */
  total: z.number().int().optional(),
  nextCursor: z.string().optional(),
});

/**
 * 積んだ1件の id。
 *
 * **返さないと閉じられない。** 閉じる口は id を取るので、積んだ側に id を渡さないと
 * 「人間は積めるが自分で閉じられない」という片道の口になる（一覧を引き直して本文で
 * 探すしかなくなり、同じ本文が2件あれば当てられない）。
 */
export const commitmentOpenedResponseSchema = z.object({ ok: z.literal(true), id: z.string() });

// ---------------------------------------------------------------------------
// マネージャー（/managers）
// ---------------------------------------------------------------------------

/**
 * 返事待ちで止まっている1件。
 *
 * **`kind`（`'question'` / `'permission'`）を宣言する（#334）。** これが無いと
 * 画面は質問（自由文で答える）と実行許可（許可／拒否）を区別できず、質問に
 * 拒否ボタンを押すと文字列「許可しない」が回答として注入されていた。種別は
 * `@alteroid/core` の `waitingKindSchema`（`packages/core/src/runner-protocol.ts`）
 * と同じ2値で、二重管理を避けるためにそこから引く。
 *
 * **`kind`・`askedAt` とも `.optional()`。** これは外向きの API の形なので、
 * `@alteroid/core` の `runnerWaitingSchema` と同じ理由（版のずれで旧 runner の
 * `/managers` 応答にこの2つが乗らない窓がある）がそのまま当てはまる。デーモン
 * がここへ既定値を作ってはいけない——`RunnerWaiting` が `undefined` のまま
 * 運んできたものを、ここで埋めると経路によって値の意味が変わる。
 */
const managerWaitingSchema = z.object({
  requestId: z.string(),
  summary: z.string(),
  kind: waitingKindSchema.optional(),
  /**
   * runner がこの確認を受け取った時刻（ISO8601, UTC）。**「回答が来た時刻」
   * ではない。** `packages/core/src/runner-protocol.ts` の
   * `runnerWaitingSchema.askedAt` と同じ意味・同じ値（#334、#323 対応）。
   */
  askedAt: isoDateTimeSchema.optional(),
});

/**
 * 確認へ上がらずに止められた道具と、その件数（`ManagerDenial`）。
 *
 * `count` は 0 を下回らない（帳面は `0 + 1` から積む）。**宣言できることは宣言する**
 * — この PR で `.parse()` を通した以上、ここに書いた範囲がそのまま外向きの面の
 * 定義になる。既定の `z.number().int()` は `minimum: -9007199254740991` を吐くので、
 * 書かなければ「負でもありうる」と宣言したことになってしまう。
 *
 * **`actor` を宣言しないと、値が在っても `.parse()` で黙って落ちる**
 * （`runnerLostSince` の doc、55行下と同じ断り）。**落ちると CLI と Web の
 * 両方が同時に盲目になる**——クローンの `manager_list` にだけ層が見え、
 * 人間の入口には出ない形になる（Issue #373）。
 */
const managerDenialSchema = z.object({
  tool: z.string(),
  count: z.number().int().nonnegative(),
  /**
   * どちらの手が止まったか。**`undefined` は「マネージャーだった」ではなく
   * 「層が取れなかった」という第3の状態である**
   * （`packages/core/src/manager.ts` の `ManagerDenial.actor` の doc と同じ
   * 規則。`via: 'result'` の拒否は SDK 側に判定材料が無いので、常にこの
   * 状態になる）。**`.optional()` をこの第3の状態のために使う**——
   * 「宣言していないから落ちた」と「観測できなかったので無い」を混同しない
   * ため、`z.enum(['manager', 'worker']).optional()` のまま書き、既定値
   * （例: `'manager'`）を持たせない。
   */
  actor: z.enum(['manager', 'worker']).optional(),
});

/**
 * `ManagerSummary`（`packages/core/src/manager.ts`）は zod スキーマを持たない
 * プレーンな TS interface なので、ここでだけ zod として書く。
 *
 * **書いただけでは効かない。** `describeRoute` の `resolver()` は spec を作るだけで、
 * ハンドラの `c.json(...)` を検査しない。ここの宣言が実際に外向きの面と一致して
 * いるのは、`app.ts` の `/managers` と `/managers/:id` が返す前にこのスキーマを
 * 通している（`.parse()`）からである。通していない経路では、interface に足した
 * フィールドが spec に無いまま黙って外へ出る。
 */
export const managerSummarySchema = z.object({
  managerId: z.string(),
  status: jobStatusSchema,
  /**
   * このデーモンから話しかけられるか（宛先を失った分だけ `false`）。
   *
   * **⚠️ `live: false` を「送っても届かない」と読み替えないこと（指差しだけを
   * 置く。この欄の契約は動かしていない）。** この `false` を作っている
   * `isLive()` の枝のうち、**器が黙ったことによる `false`（真下の
   * `runnerLostSince` が立つ側）では、`ManagerPool.send()`（`POST
   * /managers/:id/messages` が呼ぶ先）が届いた実測がある**（2026-08-28。
   * `outcome: 'delivered'`）。⟹ **「送っても届かない」ことの証明ではない。**
   * **逆に「送れば届く」でもない** —— 相手の状態によって `delivered` /
   * `session_missing` / `unknown` のどれにもなる。実測と構造の根拠は
   * `packages/core/src/manager.ts` の `isLive()` の doc。
   */
  live: z.boolean(),
  /**
   * 宛先の器を、名簿が「名乗らなくなった」と判定した時刻。`live: false` の理由を
   * 1つだけ名指しする欄である（`packages/core/src/manager.ts` の
   * `ManagerSummary.runnerLostSince`）。
   *
   * **ここに宣言しないと、値が在っても黙って落ちる。** このスキーマは
   * `.parse()` として外向きの面を通っており、宣言していない欄は落ちる
   * （真上の `lastFailure` / `lastReportAt` と同じ断り）。**落ちると CLI と
   * Web の両方が同時に盲目になる** —— クローンの `manager_list` にだけ出て、
   * 人間の入口には出ない形になる。
   */
  runnerLostSince: z.string().optional(),
  /**
   * **宛先の runner が応答したうえで、この委譲のセッションを一覧に載せなかった**と
   * 観測した時刻（`packages/core/src/manager.ts` の
   * `ManagerSummary.sessionMissingSince`）。
   *
   * **`runnerLostSince` とは別の欄である。** あちらは「器が黙った」（`live` が
   * 落ちる）。こちらは**器は答えている**が、この委譲のセッションだけが無い——
   * `sessionId` が残っていれば resume から入り直せるので `live` は落ちない。
   * ⟹ **`live: true` とこの欄の組が、5つ目の形を名指しする。**
   *
   * **「聞けなかった」ではない。** runner に訊けなかった回はここに出さない。
   *
   * **ここに宣言しないと、値が在っても黙って落ちる**（真上の `runnerLostSince`
   * と同じ断り。落ちると CLI と Web の両方が同時に盲目になる）。
   */
  sessionMissingSince: z.string().optional(),
  /**
   * **デーモンが生ログの末尾を読んで計算した、直近のターンが終わっているらしい
   * という助言**（Issue #567。`packages/core/src/manager.ts` の
   * `ManagerSummary.turnEndedAt`）。
   *
   * **判定ではない。** runner が名乗る値ではなく、デーモンが計算した値——
   * `sessionMissingSince` と同じ扱いである。`status` を書き換える・委譲を
   * abort する・貸し出し期限を縮める、のどれもしない。読む側が
   * `lastReportAt` と突き合わせて判定する。
   *
   * **⚠️ `turnEndReason` は在るのにこの欄が無い状態を「症状ではない」と
   * 読まないこと。** 比較（`turnEndedAt > lastReportAt`）自体が行えないので
   * 既定は「分からない」——`ManagerSummary.turnEndedAt` の doc を参照。
   *
   * **ここに宣言しないと、値が在っても黙って落ちる**（真上の
   * `sessionMissingSince` と同じ断り）。
   */
  turnEndedAt: z.string().optional(),
  /**
   * `turnEndedAt` と対で運ぶ（`packages/core/src/manager.ts` の
   * `ManagerSummary.turnEndReason`）。`end_turn` / `stop_sequence` などの
   * `stop_reason` をそのまま写す——枠の壁（`stop_sequence`）と #567 の症状
   * （ターンが終わったのに報告が届かない）を混同しないための欄。
   */
  turnEndReason: z.string().optional(),
  /**
   * `turnEndedAt` と対で運ぶ（`packages/core/src/manager.ts` の
   * `ManagerSummary.turnEndTail`）。その行の本文の末尾の抜粋（全文ではない）。
   */
  turnEndTail: z.string().optional(),
  cwd: z.string(),
  request: z.string(),
  startedAt: z.string(),
  updatedAt: z.string(),
  sessionId: z.string().optional(),
  lastReport: z.string().optional(),
  /**
   * `lastReport` を**デーモンが受け取った時刻**（#358）。
   *
   * 「マネージャーが報告を生成した時刻」でも「クローンのターンへ配られた
   * 時刻」でもない——`packages/core/src/manager.ts` の `ManagerSummary.
   * lastReportAt` の doc と同じ断り。宣言しなければ `.parse()` がここで
   * 黙って落とす（同じ穴を openapi 側にも作らない）。
   */
  lastReportAt: z.string().optional(),
  /**
   * 直近の1ターンが**報告ではなく失敗**で終わったこと。
   *
   * **`jobSchema` の枝をそのまま借りる（ここで書き直さない）。** これは台帳の値を
   * `summaryOf`（`packages/core/src/manager.ts`）が写しているだけなので、ここに
   * 手書きの写しを置くと、`code` / `via` / `at` のどれかが片方だけ増えた日に
   * spec が黙って古びる。このファイルの冒頭の約束（core が zod を持つものは
   * 再定義しない）どおりの扱いである。
   *
   * **`status` とは別の軸なので、`status` を置き換えない。** 支出上限に当たった回も
   * セッションは生きており `done`（終えて待機中）のままである。
   *
   * **失敗した回だけ載る（`optional`）。** 応答として終わった回に空の値を載せると、
   * 「失敗していない」と「この器では見ていない」が同じ形になる。
   */
  lastFailure: jobSchema.shape.lastFailure,
  runnerId: z.string().optional(),
  workspace: workspaceLocatorSchema.optional(),
  /**
   * 貸し出し（M5 PR4）— **その宛先のどのプロセスが、いつまで握ると約束したか。**
   *
   * `lastFailure` と同じく**`jobSchema` の枝をそのまま借りる**（ここで手書きの写しを
   * 置くと、欄が片方だけ増えた日に spec が黙って古びる）。
   *
   * **判定（引き取ってよいか）は載せない。** 答えは時刻で変わるので
   * （`packages/core/src/lease.ts` の `judgeLease`）、応答に焼くと読んだ瞬間から
   * 古びる。出すのは材料だけである。
   */
  lease: jobSchema.shape.lease,
  waiting: z.array(managerWaitingSchema),
  /**
   * 確認へ上がらずに止められた道具と件数（**古い順**）。
   *
   * **`status` では表せないので、`status` に添える。** 分類器か deny 規則がその場で
   * 拒否すると、その仕事は `running` のまま手が止まる。デーモンが観測しているのは
   * 「拒否があった」ことだけで、それで止まったかどうかは見ていない。だから状態の
   * 値は増やさない（`jobStatusSchema` は触らない）。
   *
   * **`ManagerSummary`（core の interface）には無い。** これはデーモンのプロセス内
   * の像であって台帳には載らないので、`ManagerPool.denials()` という別の口から
   * 読んで、この外向きの面でだけ合流させる（`app.ts`）。
   *
   * **拒否を観測したときだけ載る（`optional`）。** 常に `[]` を載せると「0 件だった」
   * と読める。器を作り直した直後は数え直しなので、そこがいちばん静かに見えてしまう
   * — 「数えていない」と「0 件だった」を同じ形にしない。
   */
  denials: z.array(managerDenialSchema).optional(),
});

export const managersListResponseSchema = z.object({
  managers: z.array(managerSummarySchema),
});

export const managerDetailResponseSchema = z.object({ manager: managerSummarySchema });

/**
 * 台帳に1行も無い委譲（Issue #98「台帳が取りこぼした委譲」）。`GET /usage` が
 * `unrecordedManagers` として返す1件の形。
 *
 * **`managerSummarySchema` を再利用しない。** あちらは `ManagerSummary` を丸ごと
 * 写す一覧・詳細用の形で、ここに要るのは判定に使った3フィールド（`managerId` /
 * `status` / `startedAt`）だけである。`ManagerSummary` にフィールドが増えても、
 * この応答が増える理由は無い——core 側の対（`packages/core/src/usage-format.ts`
 * の `UnrecordedManagerCandidate`）と同じ絞り方にしてある。
 *
 * **`status` は絞り込みに使った軸ではない。** 判定は「台帳に1行も無いか」の
 * 1つだけで、これは読む側へ添える注記——`running` のまま出ている委譲は、
 * まだ記録される見込みが残っていると分かる。
 */
export const unrecordedManagerSchema = z.object({
  managerId: z.string(),
  status: jobStatusSchema,
  startedAt: z.string(),
});

/**
 * `GET /usage` の応答。
 *
 * **ここで組む（`app.ts` では組まない）。** `app.ts` はこのファイル（`openapi.ts`）
 * を import し、このファイルは `app.ts` から `createApp` を import している
 * （`buildOpenApiDocument` が `createApp` にスタブの deps を渡して spec を作るため）
 * ——つまり2ファイルは循環 import の関係にある。**循環の一方（`app.ts`）の
 * モジュール最上位で、もう一方（このファイル）から取った値を使って `.extend()` を
 * 呼ぶと、どちらが先に評価されるかで `unrecordedManagerSchema` が未定義のまま
 * `z.array()` へ渡り、`zod` が `undefined._zod` を読んで例外になることがある**
 * （実測: `openapi.ts` を entry にした `write-openapi.mjs` からの評価順で再現。
 * `app.ts` を entry にする本物のデーモン起動では再現しなかった——評価順に依存する
 * 不安定な壊れ方なので、依存する側を無くす）。`usageAggregateSchema` /
 * `usageBreakdownSchema` / `accountUsageStateSchema` はどれも `@alteroid/core`
 * （circular ではない）から来るので、この合成そのものをこちらへ移し、`app.ts` は
 * 完成品をそのまま import するだけにしてある。
 */
export const usageResponseSchema = usageAggregateSchema.extend({
  breakdown: usageBreakdownSchema,
  /**
   * アカウント全体の残り（claude.ai 側が言っている値）。
   *
   * **台帳と足さない。** こちらは向こうが言っている値で、台帳は自分で数えた
   * 推定値である。`state` が `ok` 以外なら「取れなかった」であって「0」ではない。
   */
  account: accountUsageStateSchema,
  /**
   * 消費の記録が1件も無い委譲（Issue #98「台帳が取りこぼした委譲」）。
   *
   * **`ManagerPool.list()`（全期間・絞り込み無し）と `UsageStore.
   * recordedManagerIds()`（同じく全期間）を突き合わせた結果であって、この応答の
   * `from` / `to` などの絞り込みには影響されない** — 期間を絞っても件数は
   * 変わらない（変わったら、それこそが「照会範囲の外の委譲が記録が無いに化けた」
   * という壊れ方である）。判定そのものは `findUnrecordedManagers`
   * （`@alteroid/core`）が1箇所に持つ（`usageQuerySchema` のコメントに合わせて
   * CLI・Web・クローンの `usage_read` も同じ判定を返す）。
   */
  unrecordedManagers: z.array(unrecordedManagerSchema),
});

export const managerActionResponseSchema = z.object({
  /**
   * `answered` = 止まっていた確認を解いた（`POST .../messages`）。
   * `delivered` = 追加指示として届けた（同上）。
   * `stopped` = 止まったと確かめた（`DELETE /managers/:id`。`sessionGone === true`）。
   * `not_stopped` = **止まっていないと確かめた**（同上。`sessionGone === false`。
   * 明確な失敗であって「止めた」ではない）。
   * `unknown` = 確かめられなかった（同上。runner に確認が取れなかった）。
   * `session_missing` = **runner がこの委譲のセッションを持っておらず、resume でも
   * 入り直せなかった**（`POST .../messages`。#563）。
   *
   * **居ない（`absent`）はここに出ない。** その場合は 404 で `errorResponseSchema`
   * を返すので、この形には乗らない（`ManagerAbortResult` の doc）。
   *
   * **⚠️ `session_missing` は 404 にしない。** 「そのものは居る」側だからである——
   * 委譲は台帳に在り、`sessionId` が残っていればもう一度 resume を試せる。
   * `ManagerAbortResult` の doc が逐語で否定した形（「待てば直る状態を 404 という
   * 機械可読な終端で返す」）をここで作り直さない。**404 は人間もクローンも CLI も
   * Web も「そんなものは無い」としてしか読めず、文言と違って読み手の解釈で
   * 救われない。**
   */
  outcome: z.enum([
    'answered',
    'delivered',
    'stopped',
    'not_stopped',
    'session_missing',
    'unknown',
  ]),
  detail: z.string(),
});

// ---------------------------------------------------------------------------
// runner の名簿と鍵（/runners）— core の runnerCredentialFingerprintSchema を使う
// ---------------------------------------------------------------------------

/**
 * runner が名乗った版（コミット sha）。**3状態を区別する。**
 *
 * - `known` — 版が返ってきた
 * - `unknown` — 名乗った（`/health` が応答した）が、器自身が自分の版を知らない
 * - `unheard` — 名乗り自体をまだ一度も聞けていない（未接続・`/health` を
 *   一度も読めていない）
 *
 * **`unknown` と `unheard` を1つに畳まない。** 前者は runner 自体の設定を
 * 疑う材料、後者はネットワーク・登録を疑う材料であり、対処が違う
 * （core の `RunnerRevisionStatus` の doc）。**`RunnerLiveness`（`state`）の
 * `unreachable` とは主語が違う**（あちらは宛先が開けない、こちらは名乗りが
 * 聞けない）ので、あえて同じ語を避けている。**`state` から導出もできない**
 * ——`state: 'lost'` でも直前に聞いた `known` な版がそのまま残ることがある
 * （`RunnerRevisionStatus` の doc）。
 */
const runnerRevisionKnownSchema = z.object({
  status: z.literal('known'),
  commit: z.string(),
  short: z.string(),
  source: z.enum(['build', 'workspace', 'env', 'platform']),
});
const runnerRevisionUnknownSchema = z.object({ status: z.literal('unknown') });
const runnerRevisionStatusSchema = z.discriminatedUnion('status', [
  runnerRevisionKnownSchema,
  runnerRevisionUnknownSchema,
  z.object({ status: z.literal('unheard') }),
]);

/**
 * デーモン自身の版。**`unheard` は無い**（自分の名乗りを自分が聞けないという
 * 状態は意味を持たない）——`known` / `unknown` の2状態で足りる。
 */
const daemonRevisionSchema = z.discriminatedUnion('status', [
  runnerRevisionKnownSchema,
  runnerRevisionUnknownSchema,
]);

/**
 * 指紋を**聞きに行けたか**。
 *
 * **`credentials` / `profile` の「空」と、「聞けなかった」を分けるためにある。**
 * ここが無かったので、`GET /runners` は3つの状態を1つの表現へ潰していた —
 * 「繋がっていないので叩いていない」「叩いたが失敗した」「叩いて0件だった」が
 * すべて `credentials: []` / `profile: undefined` になり、読む側は**鍵が配られて
 * いないのか、確かめられなかったのか**を区別できなかった。
 *
 * **`state` から導出しないこと。** 一見 `state === 'connected'` なら叩いた、
 * それ以外なら叩いていない、で足りそうに見えるが、それは
 * `RunnerRegistry#list()` がいまどの状態を並べるかという**実装の都合**に依存する。
 * 同じ論法は `RunnerRevisionStatus` の doc（`runner-protocol.ts`）が
 * 「**`RunnerLiveness` から導出できない**」として反例2つで潰している。
 *
 * **`RunnerRevisionStatus` の語をそのまま借りない。** あちらの `unknown` は
 * 「繋がって名乗ったが版を知らない」＝ runner 自身が値を持っていない、という
 * 意味で、こちらの「叩いたが RPC が失敗した」とは主語が違う。**形（`status` の
 * 判別共用体）だけを揃え、語はこの契約に合わせる。**
 */
const runnerProbeSchema = z.discriminatedUnion('status', [
  /** 叩いて返ってきた。**中身が0件でもこれである**（0件であることが分かった）。 */
  z.object({ status: z.literal('asked') }),
  /** 叩いていない。繋がっていない相手には聞きに行かない（指紋は runner が持つ）。 */
  z.object({ status: z.literal('unheard') }),
  /**
   * 叩いたが失敗した。**理由は1行に畳んである**（`reasonOf`）——例外は失敗した
   * 呼び出しのパラメータを添えてくることがあるので、素のまま載せない。
   */
  z.object({ status: z.literal('failed'), error: z.string() }),
]);

const runnerSummarySchema = z.object({
  /**
   * 人間が見る宛先（URL か「同一プロセス」）。
   *
   * **`runnerId` ではなくこれが名簿の鍵である。** `runnerId` は繋がるまで
   * 分からない（runner が `/health` で名乗る）ので、まだ開けていない1台は
   * label でしか指せない。
   */
  label: z.string(),
  /**
   * 生死と接続状態。**「登録されているのに繋がっていない」を表せるようにする。**
   *
   * これが無いと、上がってこない runner は一覧から消えるだけになり、人間には
   * 「設定し忘れた」のか「上がってこない」のかが区別できない。
   *
   * `lost` = 一度は開けたのに名乗り（`/health`）が返らなくなった。**`unreachable`
   * とは別物である** — あちらは「まだ開けていない」宛先で抱えている仕事が無く、
   * こちらは「開けていた」宛先で、走っていた仕事ごと黙った可能性がある。
   */
  state: z.enum(['connecting', 'connected', 'unreachable', 'unusable', 'lost']),
  /** この状態になった時刻。 */
  since: z.string(),
  /** 直近の失敗の一行。**原因を見るための窓であって、値は載らない。** */
  error: z.string().optional(),
  /** 繋がるまで分からないので、開けていない間は返らない。 */
  runnerId: z.string().optional(),
  workspacePath: z.string().optional(),
  /**
   * **いまこの宛先に応えているプロセス**（runner が起動ごとに作る識別子）。
   *
   * `runnerId` は宛先の名前で、器を作り直しても同じである。だから名前だけでは
   * 「いまその名前に応えているのが、さっき仕事を渡した相手と同じか」が言えない。
   *
   * **入れ替わった瞬間の知らせ（`onSwap`）とは別の口である。** あちらは遷移で、
   * ここは状態である。知らせを見落とした後・デーモン自身が再起動した後に
   * 「いまどのプロセスが応えているのか」を確かめる口が他に無いと、引き取りの判定
   * （`packages/core/src/lease.ts`）が正しいかを誰も検算できない。
   *
   * **名乗らない runner では返らない**（`identity()` を持たない実装・古い器）。
   * 無いことを「入れ替わっていない」と読まないこと。
   */
  instanceId: z.string().optional(),
  /** そのプロセスを**デーモンが初めて見た時刻**。引き取りの猶予はここから数える。 */
  instanceSince: z.string().optional(),
  /**
   * 配られている鍵の指紋。**値は返らない。**
   *
   * **空であることだけを見ないこと。** 叩けなかったときもここは空になるので、
   * 「鍵が配られていない」と読んでよいのは `credentialsProbe.status === 'asked'`
   * のときだけである。
   */
  credentials: z.array(runnerCredentialFingerprintSchema),
  /** 指紋を聞きに行けたか。**上の空と、聞けなかったことを分ける。** */
  credentialsProbe: runnerProbeSchema,
  /**
   * 置かれている実行環境プロファイルの指紋。**本文は返らない。**
   *
   * **無いことだけを見ないこと。** 叩けなかったときもここは省略される。
   */
  profile: runnerProfileFingerprintSchema.optional(),
  /** プロファイルの指紋を聞きに行けたか。**上の不在と、聞けなかったことを分ける。** */
  profileProbe: runnerProbeSchema,
  /**
   * runner が名乗った版。**名簿に既にある値をそのまま出す**（ここで新たに
   * runner を叩かない）。
   */
  revision: runnerRevisionStatusSchema,
});

export const runnersListResponseSchema = z.object({
  runners: z.array(runnerSummarySchema),
  /**
   * デーモン自身の版。**runner の版と1回の読みで比較できるように、同じ応答の
   * 外側へ並べて出す。** 別々の場所に出すと依頼者が手で突き合わせることになり、
   * 突き合わせ忘れがそのまま見逃しになる。
   */
  daemonRevision: daemonRevisionSchema,
});

export const runnersCredentialsResponseSchema = z.object({
  results: z.array(
    z.object({
      runnerId: z.string(),
      ok: z.boolean(),
      credentials: z.array(runnerCredentialFingerprintSchema).optional(),
      error: z.string().optional(),
    }),
  ),
});

// ---------------------------------------------------------------------------
// 実行環境プロファイル（/profile）
// ---------------------------------------------------------------------------

/**
 * 人間が置いたプロファイル。
 *
 * **本文を返す。** ここは持ち主だけが通る口であり（`/access` と同じ資格）、
 * 人間が自分で書いたものを読み直せないと、typo ひとつ直せない。指紋しか返さない
 * のは runner の制御面のほうで、あちらは「マネージャーが読めてはいけない」から
 * そうしている。守っている相手が違う。
 */
export const profileResponseSchema = z.object({
  script: z.string(),
  updatedAt: z.string().optional(),
  sha256: z.string().optional(),
  bytes: z.number().optional(),
});

/**
 * 保存も配布もしなかったときの応答。
 *
 * **理由を本文で返す。** シェルの構文エラーは行番号込みでしか直せないので、
 * 「読めなかった」だけ返すのは実質「直せない」と同じである。
 */
export const profileErrorResponseSchema = z.object({
  error: z.string(),
  detail: z.string(),
});

export const profileUpdateRequestSchema = z.object({
  /** シェルスクリプトそのもの。空文字は「プロファイルを外す」。 */
  script: z.string(),
});

export const profileUpdateResponseSchema = z.object({
  updatedAt: z.string(),
  sha256: z.string().optional(),
  bytes: z.number().optional(),
  /**
   * クローン（デーモン自身）へ効かせた結果。**壊れていれば置いていない。**
   */
  clone: z.object({
    ok: z.boolean(),
    error: z.string().optional(),
    output: z.string().optional(),
    names: z.array(z.string()).optional(),
  }),
  /** 各 runner へ降ろした結果。 */
  runners: z.array(
    z.object({
      runnerId: z.string(),
      ok: z.boolean(),
      error: z.string().optional(),
      output: z.string().optional(),
      names: z.array(z.string()).optional(),
      profile: runnerProfileFingerprintSchema.optional(),
    }),
  ),
});

// ---------------------------------------------------------------------------
// 認証トークンのプール（/tokens）——Issue #393「PR1 プールの器」。**回さない。**
// ---------------------------------------------------------------------------

/**
 * `GET /tokens` `PUT /tokens` の応答。
 *
 * `agentTokenViewSchema`（core）をそのまま使う——`AgentTokenView` は最初から
 * *外向き*に書かれた型で（`value` を持たない指紋の形）、`runnerCredentialFingerprintSchema`
 * と同じ理由でここに書き直さない。`tokenRotationSettingsSchema` も同様——
 * 秘密を持たない設定行そのものなので、そのまま外へ出してよい。
 */
export const tokensResponseSchema = z.object({
  tokens: z.array(agentTokenViewSchema),
  settings: tokenRotationSettingsSchema,
});

/**
 * `PUT /tokens` の body。`agentTokenInputSchema`（core）をそのまま使う——
 * `value` を省略できる形そのものが、人間・CLI・クローンの道具が共有する入力
 * 契約であって、ここで別の形に書き直す理由が無い。
 */
export const tokensUpdateRequestSchema = z.object({
  tokens: z.array(agentTokenInputSchema),
});

/**
 * `PUT /tokens/policy` の body。3つとも省略可（部分更新）。
 */
export const tokensPolicyUpdateRequestSchema = z.object({
  rotateOn: tokenRotationPolicySchema.optional(),
  cooldownMs: z.number().int().positive().optional(),
});

// ---------------------------------------------------------------------------
// アーカイブ（/archive）
// ---------------------------------------------------------------------------

export const archiveListResponseSchema = z.object({ entries: z.array(z.string()) });

// ---------------------------------------------------------------------------
// documentation（`GET /openapi.json` の骨格）
// ---------------------------------------------------------------------------

/**
 * `openAPIRouteHandler(app, { documentation, exclude })` にそのまま渡す。
 *
 * `exclude` で `/openapi.json` `/docs` 自身を spec から外す。実際には
 * `describeRoute` を付けていない経路はそもそも spec に載らない（hono-openapi の
 * 既定動作）ので二重の安全策だが、Issue の指示（「excludePaths などで除外」）
 * どおり明示しておく。
 */
export const openApiExcludePaths = ['/openapi.json', '/docs'];

export const openApiDocumentation: GenerateSpecOptions['documentation'] = {
  openapi: '3.1.0',
  info: {
    title: 'alteroid daemon API',
    // API 自体の版。apps/daemon/package.json の version（0.0.0 のプレースホルダ、
    // 非公開パッケージなので固定していない）とは別に持つ。
    version: '0.1.0',
    description:
      'alteroidd（常駐デーモン）の HTTP API。クローンとの対話・記憶・日誌・日報・' +
      '承認待ち・委譲先マネージャーの操作までを持つ。**runner の制御面（SDK の ' +
      'start/send/stop など）は含まない** — そこはマネージャーが自分宛の許可確認に ' +
      '自分で答えられてしまう境界であり、外へ出す面ではない（docs/architecture.md ' +
      '「制御面の保護」）。',
  },
  servers: [
    {
      url: 'http://127.0.0.1:4517',
      description:
        '既定の待ち受け。ポートは ALTEROID_PORT で変わる（既定 4517）。既定では ' +
        '127.0.0.1 以外には開いていない（ALTEROID_BIND で変更可）。',
    },
  ],
  tags: [
    { name: 'system', description: '死活監視・停止など、デーモン自体の管理' },
    { name: 'chat', description: '人間とクローンの対話（SSE）と会話終了（蒸留の契機）' },
    {
      name: 'conversations',
      description: '会話の履歴。日誌から組み立てる（新しい状態は持たない）',
    },
    {
      name: 'memory',
      description: '記憶（PersonaStore）。人間が読んでいつでも直せる Markdown 文書群',
    },
    { name: 'journal', description: '日誌（追記専用の記録）。可観測性の中段' },
    { name: 'reports', description: '日報。可観測性の最上段（人間の普段の接点はほぼこれだけ）' },
    { name: 'approvals', description: '承認待ちキュー（`ask_human` の応答口）' },
    { name: 'events', description: '外部イベントの入口（仕事の起点③）' },
    { name: 'schedule', description: '時間起点のジョブ（起点②④）の一覧と手動起動' },
    {
      name: 'commitments',
      description:
        '引き受けたまま終わっていない仕事の台帳。クローンの commitment_* と同じものを' +
        '人間の側からも読み・積み・閉じられる',
    },
    { name: 'managers', description: '委譲先マネージャーの一覧・状態・生ログ・直接の指示/停止' },
    { name: 'runners', description: '委譲先 runner の名簿と、そこへ配る鍵の指紋' },
    { name: 'archive', description: 'セッション生ログ（可観測性の最下段）' },
    {
      name: 'auth',
      description:
        'ログイン（誰がこの API を叩いているか）。PRD「権限境界」（クローンが記憶を' +
        '根拠に何を人間へ確認するか）とは別の層で、持つのは許可の2値だけである',
    },
    {
      name: 'access',
      description:
        'アクセス許可の付与・剥奪。実行環境の持ち主（状態ファイルを読める者）だけが叩ける',
    },
    {
      name: 'tokens',
      description:
        '認証トークンのプール（Issue #393）。**回さない**——枠に当たったときに回す' +
        '候補を置くだけの器。値は決して出さない（label と指紋だけ）',
    },
  ],
  components: {
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        description:
          '2種類のトークンが同じ形で通る。①**アクセストークン**（`alt_` で始まる。' +
          '`alteroid login` で発行し、許可されたアカウントのものだけが通る）。' +
          '②**実行環境の持ち主のトークン**（`~/.alteroid/state/daemon.json` の ' +
          '`token`。CLI がこれを使う。ここを読めること自体が境界であり、' +
          '`/access/*`（許可の付与）はこちらでしか通らない）。\n\n' +
          '`ALTEROID_AUTH=off`（既定はログイン手段が未設定のとき）では認証を要求しない。',
      },
    },
  },
  // 既定で全経路に認証を要求し、公開してよい経路（/health・/auth/*・spec）だけが
  // 各 describeRoute で `security: []` を明示して外す。**逆にすると、経路を
  // 足した人が security を書き忘れたときに黙って穴が開く。**
  security: [{ bearerAuth: [] }],
};

// ---------------------------------------------------------------------------
// ビルド時の spec 生成
// ---------------------------------------------------------------------------

/**
 * `createApp` を実際には走らせず、経路定義（`describeRoute` / `validator` が
 * 積んだメタデータ）だけから spec を組み立てる。
 *
 * **なぜスタブの deps でよいのか。** `GET /openapi.json` のハンドラ
 * （`openAPIRouteHandler`）は各ハンドラを実行しない — hono のルーティング表を
 * 読んで、`describeRoute`/`validator` が付けたメタデータを集めるだけである。
 * だから `clone` や `stores` が実際に何かをする必要は無く、`createMemoryStores()`
 * （fs/pg ドライバ不要のインメモリ実装）と、呼ばれたら即 throw する `CloneHost`
 * で十分に足りる。呼ばれてしまったらそれ自体がバグ（spec 生成のはずがハンドラを
 * 実行した）なので、黙って何もしないダミーではなく throw にしてある。
 */
export async function buildOpenApiDocument(): Promise<unknown> {
  const stubManagers: ManagerPool = {
    start() {
      throw new Error('spec 生成専用のスタブ: マネージャーは起こさない');
    },
    send() {
      throw new Error('spec 生成専用のスタブ: マネージャーには送らない');
    },
    abort() {
      throw new Error('spec 生成専用のスタブ: マネージャーは止めない');
    },
    list() {
      throw new Error('spec 生成専用のスタブ: マネージャー一覧は持たない');
    },
    denials() {
      throw new Error('spec 生成専用のスタブ: 拒否は数えていない');
    },
    runners() {
      throw new Error('spec 生成専用のスタブ: 器の一覧は持たない');
    },
    runnerBacklog() {
      throw new Error('spec 生成専用のスタブ: 器の滞留は観測していない');
    },
    transcript() {
      throw new Error('spec 生成専用のスタブ: 生ログは持たない');
    },
    restore() {
      throw new Error('spec 生成専用のスタブ: 引き継ぎはしない');
    },
    reattachRunner() {
      throw new Error('spec 生成専用のスタブ: 取り直しはしない');
    },
    probeTurnEnds() {
      throw new Error('spec 生成専用のスタブ: ターン終了の探りはしない');
    },
    stop() {
      throw new Error('spec 生成専用のスタブ');
    },
  };

  const stubClone: CloneHost = {
    managers: stubManagers,
    recycleSessionForToken() {
      throw new Error('spec 生成専用のスタブ: セッションは作らない');
    },
    post() {
      throw new Error('spec 生成専用のスタブ: 受信箱には積まない');
    },
    subscribe() {
      throw new Error('spec 生成専用のスタブ: 購読は無い');
    },
    endConversation() {
      throw new Error('spec 生成専用のスタブ');
    },
    answerApproval() {
      throw new Error('spec 生成専用のスタブ');
    },
    stop() {
      throw new Error('spec 生成専用のスタブ');
    },
  };

  const app = createApp({
    clone: stubClone,
    stores: createMemoryStores(),
    token: 'spec-generation',
    shutdown: () => undefined,
  });

  const response = await app.request('/openapi.json');
  return response.json();
}
