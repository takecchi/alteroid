import {
  accountUsageStateSchema,
  agentTokenInputSchema,
  agentTokenViewSchema,
  appraisalSchema,
  commitmentSchema,
  createMemoryStores,
  INBOX_EVENT_TYPE_ORDER,
  jobSchema,
  jobStatusSchema,
  journalEntrySchema,
  memoryDocumentMetaSchema,
  mcpServersSchema,
  memoryDocumentSchema,
  pendingApprovalSchema,
  practiceMetaSchema,
  practiceSchema,
  practiceVersionMetaSchema,
  practiceVersionSchema,
  runnerCredentialFingerprintSchema,
  runnerCredentialSchema,
  runnerLivenessSchema,
  runnerMcpServersFingerprintSchema,
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
  /**
   * 誰が許可したか。`operator` = 状態ファイルを読める実行環境の持ち主。**それ以外は
   * 許可を与えたアカウントの id**（2026-09-06 の同格化以降）。
   */
  grantedBy: z.string().nullable(),
  /**
   * 実行環境の持ち主として宣言された日時（issue #1198）。`null` なら誰も owner
   * ではない。立てられるのは operator トークンだけ（`POST /access/:accountId/owner`）。
   */
  ownerDeclaredAt: isoDateTimeSchema.nullable(),
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
  /**
   * この発言が置き換える、過去の人間の発言の id（編集後の発言が持つ。
   * `includeSuperseded` の値によらず、編集後の発言自身がこの欄を持てば付く）。
   * チャットの「メッセージを編集する」機能（issue #edit-message）。
   */
  supersedes: z.string().optional(),
  /**
   * この発言を隠している編集の id（畳み込みで既定ビューから隠された側だけが
   * 持つ）。**既定（`includeSuperseded=false`）の応答には現れない**——隠された
   * 発言そのものが `messages` から除かれるため。`includeSuperseded=true` の
   * ときにだけ、どの編集がこれを隠したかを示す。
   */
  supersededBy: z.string().optional(),
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
  /**
   * この会話で、編集によって既定ビューから畳まれた発言の件数
   * （チャットの「メッセージを編集する」機能）。**`includeSuperseded` の値に
   * よらず常に含める**（0件でも含める）——出ないと、この会話に編集で隠された
   * 版が在ることに気づく手段が無くなる。畳まれた版を読むには
   * `includeSuperseded=true` を指定する。
   */
  supersededCount: z.number().int(),
});

// ---------------------------------------------------------------------------
// 記憶（/memory）— core の memoryDocument(Meta)Schema をそのまま使う
// ---------------------------------------------------------------------------

export const memoryListResponseSchema = z.object({ documents: z.array(memoryDocumentMetaSchema) });
export const memoryReadResponseSchema = z.object({ document: memoryDocumentSchema });
export const memoryDeleteResponseSchema = z.object({ ok: z.literal(true), slug: z.string() });

// ---------------------------------------------------------------------------
// 仕事のやり方（/practices）— core の practice(Meta)Schema をそのまま使う
// （#1055 段3③。PracticeStore の doc「器が持つのは『こう書いてある』までで、
// 『こう実行せよ』ではない」——ここに `apply` / `enforce` に当たる口を作らない）
// ---------------------------------------------------------------------------

export const practiceListResponseSchema = z.object({ practices: z.array(practiceMetaSchema) });
export const practiceReadResponseSchema = z.object({ practice: practiceSchema });
export const practiceDeleteResponseSchema = z.object({ ok: z.literal(true), slug: z.string() });

/**
 * やり方の版の履歴（#1309）。**一覧はメタだけ**——`practiceListResponseSchema` と
 * 同じ理由で、本文を含まない（`PracticeStore.listVersions` の doc）。
 */
export const practiceVersionListResponseSchema = z.object({
  versions: z.array(practiceVersionMetaSchema),
});
export const practiceVersionReadResponseSchema = z.object({ version: practiceVersionSchema });

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

/**
 * `POST /clone/interrupt` の応答（#1398 c23-1）。`interrupted` は止めた、`idle` は
 * 走っているターンが無かった、`unsupported` はこの器のクローンが止める口を持たない。
 */
export const cloneInterruptResponseSchema = z.object({
  outcome: z.enum(['interrupted', 'idle', 'unsupported']),
});

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
 *
 * **`respondedAt` は issue #1003（「放置」と「進行中」の見分け）のために足した
 * 導出値である。** `updatedAt` と同じ形の**加算のみの変更**——クローンから
 * 人間への返答が日誌の `exchange` に見つかった最初の時刻で、見つからなければ
 * 欄自体が応答に現れない（`undefined` であって `null` ではない。`??` の対象に
 * しないこと——「無い」と「見つからなかった」を区別しない値である）。導出は
 * `packages/core/src/schema.ts` の `commitmentRespondedAt` を呼ぶ
 * （`apps/daemon/src/app.ts` の `GET /commitments` ハンドラ）。
 *
 * **`activeManagerIds` は issue #1003 段2（「進行中（委譲あり）」）のために
 * 足した導出値である。** `respondedAt` と同じ形の**加算のみの変更**——同じ
 * 会話の中で、この行より後に始まって、いまも走っている（`running` /
 * `waiting_human`）マネージャーの `managerId` を並べたもので、無ければ
 * 欄自体が応答に現れない。**正確な1対1の紐付けではない**（同じ会話に複数の
 * 未了行や複数の委譲が並行していれば、無関係な行にも付きうる——
 * `packages/core/src/schema.ts` の `Job.conversationId` / `commitmentActiveDelegationIds`
 * の doc に限界を書いた）。導出は `commitmentActiveDelegationIds` を呼ぶ
 * （`apps/daemon/src/app.ts` の `GET /commitments` ハンドラ）。
 */
export const commitmentListResponseSchema = z.object({
  entries: z.array(
    commitmentSchema.extend({
      updatedAt: isoDateTimeSchema,
      respondedAt: isoDateTimeSchema.optional(),
      activeManagerIds: z.array(z.string()).optional(),
    }),
  ),
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
  /**
   * この道具×層が最後に止められた時刻（ISO 8601。issue #1455）。止められた後に
   * 委譲が報告を返したかを `lastReportAt` と突き合わせる材料。**無いことは
   * 「取れていない」であって「古い」ではない。** 宣言しないと `.parse()` が黙って落とす。
   */
  lastAt: z.string().optional(),
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
   * **真上の印が何を確かめたものか**（#579。`packages/core/src/manager.ts` の
   * `ManagerSummary.sessionMissingKind`）。
   *
   * - `resume-failed` — 送った／引き取ろうとした結果、**resume でも入り直せなかった**
   * - `unlisted` — 10秒ごとの生存確認で、**器が抱えている一覧に載っていなかった**
   *   （resume はまだ試していない）
   *
   * **読み手の次の一手が違うので、1つに畳まない。** 前者はもう話しかけられない
   * ので、拾えるものを拾って始末をつける側へ回る。後者は `manager_send` で
   * 入り直せることがある。
   *
   * **`sessionMissingSince` が在るときだけ載る**（単独では出ない）。
   *
   * **ここに宣言しないと、値が在っても黙って落ちる**（真上と同じ断り。落ちると
   * CLI と Web の両方が同時に、この2つを区別できなくなる）。
   */
  sessionMissingKind: z.enum(['resume-failed', 'unlisted']).optional(),
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
  /**
   * **その委譲がどうだったか**（#1054）。台帳（`Job.appraisal`）をそのまま写す。
   *
   * **`status` とは別の軸である** —— `done` は「セッションが終わった」であって
   * 「良かった」ではない。無いことは「まだ評定していない」であって「普通」では
   * ないので、読む側は `good` にも `bad` にも寄せないこと。
   *
   * **型は `z.string()` で緩い**（既知の値は `appraisalSchema`）。台帳の
   * `Job.appraisal` と同じ理由で、未知の値1つで応答が丸ごと壊れる側へ倒さない。
   */
  appraisal: z.string().optional(),
  appraisedAt: z.string().optional(),
  appraisedBy: z.string().optional(),
  appraisalReason: z.string().optional(),
  /**
   * 評定が述べた仕事の種類（#1308。`Job.workKind`）。無ければ未分類。**宣言しなければ
   * `.parse()` がここで黙って落とす**（この schema は手書きの再宣言である）。
   */
  workKind: z.string().optional(),
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
  /**
   * セッションが `failed` として畳まれたときの、器の資源による落ち方の分類
   * （#713 段3）。
   *
   * **`jobSchema` の枝をそのまま借りる（ここで書き直さない）。** `lastFailure`
   * と同じ理由——`code` / `errno` / `syscall` / `at` のどれかが片方だけ増えた
   * 日に spec が黙って古びる。
   *
   * **`lastFailure` とは軸が違う。** あちらは「直近の1ターンが報告ではなく
   * 失敗で終わった」でセッションは生きている。こちらは「セッションその
   * ものが `closed` として畳まれた」、その落ち方の OS 由来の事実——セッション
   * はもう走っていない（`packages/core/src/schema.ts` の `lastSystemError` の
   * doc）。
   *
   * **`code` を持つ落ち方の回だけ載る（`optional`）。** 枠（429）や signal で
   * 畳まれた回には無いので、「器の資源で落ちていない」と「この軸では判定
   * できなかった」を欄の有無だけでは言い分けられない——そこは本文
   * （`lastReport` / 受信箱）を見る。
   */
  lastSystemError: jobSchema.shape.lastSystemError,
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
  /**
   * **背景処理（`run_in_background` の子・作業者への委譲）の完了待ちで畳んだ
   * 報告が握り潰されていること**（#621 / #643。`packages/core/src/manager.ts` の
   * `ManagerSummary.awaitingBackground`）。
   *
   * **`status` とは別の軸なので、`status` を置き換えない。** 台帳の
   * `status` はこの回も `done` のままである（`case 'report'` が
   * `record.job.status = event.status;` を分岐より前に実行するため）——
   * 「手が空いた」と「待って畳んだ」を `status` だけでは言い分けられない。
   *
   * **握り潰しが在るときだけ載る（`optional`）。** 常に載せると「待っていない」と
   * 「この器では観測していない」が同じ形になる——この欄を送らない古い runner が
   * 在るので、無いことは「そうではない」ではなく「そう名乗られていない」である。
   *
   * **ここに宣言しないと、値が在っても黙って落ちる**（真上の `lastReportAt` /
   * `runnerLostSince` と同じ断り）。**落ちると CLI と Web の両方が同時に盲目に
   * なり、クローンの `manager_list` にだけ出る形になる。**
   */
  awaitingBackground: z
    .object({
      /** 器が最後に名乗った背景タスクの在り高。 */
      tasks: z.number(),
      /** 握り潰した報告の本数（**在り高とは別の観測**。1つに畳まない）。 */
      withheldReports: z.number(),
      breakdown: z.string(),
      since: z.string(),
    })
    .optional(),
  /**
   * この委譲が抱えている認証トークンの世代（Issue #914 提案1。
   * `packages/core/src/manager.ts` の `ManagerSummary.tokenGeneration`）。
   *
   * **`activeTokenGeneration` と対で運ぶ**（真下）。プールを使っていない
   * 構成・まだ観測していない委譲では欄ごと消える。
   *
   * **ここに宣言しないと、値が在っても黙って落ちる**（真上の
   * `awaitingBackground` と同じ断り。落ちると CLI と Web の両方が同時に
   * 盲目になり、クローンの `manager_list` にだけ出る形になる）。
   */
  tokenGeneration: z.number().int().nonnegative().optional(),
  /**
   * 呼び出した時点の現役の世代（`ManagerSummary.activeTokenGeneration` の
   * 写し。Issue #914 提案1）。`tokenGeneration` と対で運ぶ——単独では
   * 出ない（比べる相手が無い判定を作らない）。
   */
  activeTokenGeneration: z.number().int().nonnegative().optional(),
  /**
   * `tokenGeneration` が `undefined` になっている理由（Issue #988。
   * `packages/core/src/manager.ts` の `ManagerSummary.tokenGenerationUnknownReason`
   * / `TokenGenerationUnknownReason`）。
   *
   * - `pool-not-wired` — このデプロイが認証トークンの世代そのものを配線して
   *   いない（全マネージャーで共通の理由）
   * - `not-yet-observed` — プールは配線されているが、この委譲のセッションが
   *   まだ一度もこのプロセスで起きていない
   * - `reattached-across-restart` — デーモンの再起動をまたいで、runner に
   *   生きているセッションを見つけて引き取っただけ。**唯一、対処
   *   （manager_stop → manager_start）を持つ理由**
   *
   * **`tokenGeneration` が定義されているときは欄ごと消える。**
   *
   * **ここに宣言しないと、値が在っても黙って落ちる**（真上の
   * `activeTokenGeneration` と同じ断り。落ちると CLI と Web の両方が
   * 同時に盲目になり、クローンの `manager_list` にだけ理由が出る形になる）。
   */
  tokenGenerationUnknownReason: z
    .enum(['pool-not-wired', 'not-yet-observed', 'reattached-across-restart'])
    .optional(),
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

/**
 * プロファイル・環境変数・認証トークンの押し込みが1回、直近どうだったか。
 * `@alteroid/core` の `RunnerPushOutcome` / `RunnerPushHealth` と同じ形。
 *
 * **プロセス内の記憶であって、DB には残らない**（デーモンを作り直せば消える）。
 */
const runnerPushOutcomeSchema = z.object({
  status: z.enum(['ok', 'failed']),
  /** その結果を確かめた時刻（ISO 8601）。 */
  at: z.string(),
  /** `status: 'failed'` のときだけ載る、失敗の理由（原文）。 */
  error: z.string().optional(),
});

const runnerPushHealthSchema = z.object({
  profile: runnerPushOutcomeSchema.optional(),
  credentials: runnerPushOutcomeSchema.optional(),
  agentToken: runnerPushOutcomeSchema.optional(),
  /** 人間の MCP 連携の登録（#325 段3）。口を持たない古い runner へは `failed` で残る。 */
  mcpServers: runnerPushOutcomeSchema.optional(),
});

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
   *
   * `vacating` = 意図して空けている最中（drain）。値の集合は `@alteroid/core` の
   * `runnerLivenessSchema`（`packages/core/src/runner-protocol.ts`）と同じ6値で、
   * 二重管理を避けるためにそこから引く。
   */
  state: runnerLivenessSchema,
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
  /**
   * プロファイル・環境変数・認証トークンの押し込みの、直近の結果。
   *
   * **`credentials`/`profile` と違い、常に載る**（`runnerId` を持つ行だけ）。
   * runner への新しい往復を払わない——デーモンのプロセス内に既にある記憶を
   * 読むだけである（`@alteroid/core` の `RunnerOverview.pushHealth` の doc）。
   */
  pushHealth: runnerPushHealthSchema.optional(),
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

/**
 * `POST /runners/vacate` の入力（#485 PR-2）。`runnerId` は `GET /runners` が
 * 出す `runnerId`（runner が名乗った値）そのもの。`railway/scale-runners.sh`
 * が既にこの形を名指ししている。
 */
export const runnersVacateCommandSchema = z.object({
  runnerId: z.string(),
});

// ---------------------------------------------------------------------------
// 実行環境プロファイル（/profile）
// ---------------------------------------------------------------------------

/**
 * 人間が置いたプロファイル。
 *
 * **本文を返す。** ここは実行環境の持ち主だけが通る口である。**⚠️ `/access` とは
 * もう同じ資格ではない**（2026-09-06 のオーナー決定で `/access` `/tokens` は
 * alteroid を使う許可があれば通るよう緩めたが、ここは変えていない——鍵をまるごと
 * 運ぶ口だからである）。人間が自分で書いたものを読み直せないと、typo ひとつ
 * 直せない。指紋しか返さないのは runner の制御面のほうで、あちらは「マネージャーが
 * 読めてはいけない」からそうしている。守っている相手が違う。
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
// 人間の MCP 連携の登録（/mcp-servers。#325 段1）
// ---------------------------------------------------------------------------

/**
 * 登録そのもの（`.mcp.json` と同じ形）。**値を返す。** 人間が自分で書いたものを
 * 読み直せないと typo ひとつ直せない（`profileResponseSchema` と同じ理由）。
 * `env` / `headers` に鍵が入りうるので、口は持ち主だけに絞ってある
 * （`app.ts` の `/mcp-servers`）。
 */
export const mcpServersResponseSchema = z.object({
  mcpServers: mcpServersSchema,
  /** 置かれていなければ欠ける。 */
  updatedAt: z.string().optional(),
});

/**
 * 全文置換。`.mcp.json` をそのまま貼れる形にしてある。空の `mcpServers` は
 * 「登録を外す」。**未知の欄は拒む**（`mcp-servers.ts` の doc —— 捨てると
 * 綴りを間違えた欄が「保存できたのに効かない」になる）。
 */
export const mcpServersUpdateRequestSchema = z.strictObject({
  mcpServers: mcpServersSchema,
});

/**
 * 差し替えた結果。**名前だけを返す**（値は送った本人が持っている。応答に載せる
 * 理由が無い口で鍵を往復させない）。
 */
export const mcpServersUpdateResponseSchema = z.object({
  names: z.array(z.string()),
  updatedAt: z.string(),
  /**
   * 保存した登録の指紋（#325 段3。`mcpServersFingerprintOf`）。各 runner の
   * `mcpServers.sha256` と突き合わせれば、届いた版が同じかが値を見ずに言える。
   * 空の登録（外した）なら欠ける。
   */
  sha256: z.string().optional(),
  /**
   * いつから効くか。**クローンの次のセッションから・マネージャーは次に開く
   * セッションから**であって、走行中のセッションには届かない
   * （`claude-provider.ts` の `cloneMcpServers` / `buildManagerSessionOptions` の doc）。
   */
  appliesFrom: z.string(),
  /**
   * 各 runner へ降ろした結果（#325 段3。`PUT /profile` の `runners` と同じ位置づけ）。
   * **名前と指紋だけで、値は載せない。** 保存は済んでいるので、ここに失敗が
   * 在っても 200 である —— 失敗した runner へは次の名乗り（`hello`）で降ろし直す。
   */
  runners: z.array(
    z.object({
      runnerId: z.string(),
      ok: z.boolean(),
      /** 置いた後の指紋と名前。外した（空の登録）なら欠ける。 */
      mcpServers: runnerMcpServersFingerprintSchema.optional(),
      /**
       * 相手が MCP の登録を受け取る口を持たない古い runner だった。一時障害と
       * 区別する（疑う先が「待てば直る」ではなく「runner の版」だから）。
       */
      unsupported: z.literal(true).optional(),
      error: z.string().optional(),
    }),
  ),
});

// ---------------------------------------------------------------------------
// マネージャーへ降ろす環境変数（/credentials）
// ---------------------------------------------------------------------------

/**
 * 撒く先。既定は 'all'（クローン・マネージャー双方）。
 * packages/core/src/store.ts の StoredCredential.scope と同じ意味・同じ既定。
 */
const credentialScopeSchema = z.enum(['all', 'app', 'runner']);

/**
 * デーモンが外向けに返す指紋に、scope・secret・（非シークレットなら）値を足したもの。
 *
 * runnerCredentialFingerprintSchema を直接拡張せず、こちらで .extend() する
 * ——あちらは runner 側の指紋（GET /runners の credentials）とも共有する土台
 * なので、そちらへ scope/secret/value の概念を持ち込まない（runner には
 * 「クローンの器の env」のような比較対象も scope の概念も無い）。
 */
const credentialFingerprintWithMetaSchema = runnerCredentialFingerprintSchema.extend({
  /**
   * GitHub の名前（GITHUB_CREDENTIAL_NAMES）で、正本のこの行より
   * デーモンの器の環境変数の値が優先して配られている（＝正本のこの行は
   * どこにも配られていない）ときだけ true。既定では付かない
   * （Issue #865 の恒久策、2026-09-12）。値そのものは載らない。
   */
  shadowsCloneEnv: z.boolean().optional(),
  /** 撒く先（共通/clone/manager）。 */
  scope: credentialScopeSchema,
  /** シークレット可否。false の行だけ value が併走する。 */
  secret: z.boolean(),
  /** secret === false の行だけ載る。シークレットの行では欄自体が無い。 */
  value: z.string().optional(),
});

export const credentialsResponseSchema = z.object({
  credentials: z.array(credentialFingerprintWithMetaSchema),
});

/**
 * PUT /credentials の入力。部分更新である（入力に無い名前は触らない）。
 *
 * 名前の形は runnerCredentialSchema（runner の制御面と同じ）をそのまま使う——
 * 名前は器の中のファイル名になるので、パスとして解釈されうる形を最初から名前と
 * して認めない（そちらの doc）。2つ書くと必ずずれるので、書き直さない。
 *
 * scope・secret はこの口だけの拡張（runnerCredentialSchema 自体は拡張
 * しない——runner の制御面の命令はいまも名前と値だけでよい）。
 */
const credentialInputSchema = runnerCredentialSchema.extend({
  /** 省略時は 'all'（新規行）／既存行の値を引き継ぐ（更新）。 */
  scope: credentialScopeSchema.optional(),
  /**
   * 新規作成時にだけ効く。既存行に対して既存の値と異なる secret を
   * 渡すと 400 で拒否される（StoredCredential.secret の doc）。省略時は
   * 新規行なら true、既存行の更新なら前回の値を引き継ぐ。
   */
  secret: z.boolean().optional(),
});

export const credentialsUpdateRequestSchema = z.object({
  credentials: z.array(credentialInputSchema).min(1),
});

export const credentialsUpdateResponseSchema = z.object({
  /** 置き換えた後の正本の指紋。 */
  credentials: z.array(credentialFingerprintWithMetaSchema),
  /** 各 runner へ降ろした結果。台ごとに返す（畳んで1つの成否にしない）。 */
  runners: z.array(
    z.object({
      runnerId: z.string(),
      ok: z.boolean(),
      error: z.string().optional(),
      credentials: z.array(runnerCredentialFingerprintSchema).optional(),
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
// 握り潰しの跡（/dropped）——#242 の HTTP 面。PRD「入口の等価性」。
// ---------------------------------------------------------------------------

/**
 * `GET /dropped` の `origin`。**いまは `'daemon'` の1値しか無い**
 * （`packages/core` の `DroppedTraceOrigin` と同じ値）。
 *
 * **ここへ書き直しているのは core が zod スキーマを持っていないからである。**
 * `journalEntrySchema` 等（core が zod で書いている型）はこのファイルの
 * 冒頭 doc の方針どおり再定義しないが、`dropped-record.ts` は stderr へ
 * 出す文字列とプレーンな TS の型しか持たない——ここが初めて zod の形にする。
 */
export const droppedTraceOriginSchema = z.literal('daemon');

/**
 * `GET /dropped` の応答。
 *
 * - `origin`: 帳面がどのプロセスの跡かを示す。**daemon だけが名乗る**
 *   （runner は別プロセスで、この帳面には原理的に現れない。
 *   `dropped-record.ts` の `DroppedTraceOrigin` の doc）。
 * - `since`: この帳面が数え始めた時刻（`droppedTraceLedgerSince()`）。
 * - `limit`: 帳面自体の保持件数（`RECENT_TRACE_LIMIT`）。**クエリでは
 *   絞れない**——`app.ts` の `GET /dropped` の doc を見ること。
 * - `total`: いま帳面に乗っている件数（`traces.length` と同じ）。
 * - `traces`: 古い順（末尾が最新）。本文は1文字も含まない
 *   （`dropped-record.ts` 冒頭 doc「本文は出さない」）。
 */
export const droppedResponseSchema = z.object({
  origin: droppedTraceOriginSchema,
  since: z.string(),
  limit: z.number().int(),
  total: z.number().int(),
  traces: z.array(z.string()),
});

// ---------------------------------------------------------------------------
// 評定の内訳（/appraisal-stats）——#1278「評定の内訳を要るときに数える口が無い」の HTTP 面。
// PRD「入口の等価性」（droppedResponseSchema の doc と同じ理由）。
// ---------------------------------------------------------------------------

/**
 * 評定（`good`/`bad`/`unclear`）を先頭一致で数えた内訳。**`@alteroid/core` の
 * `AppraisalDecisionTally` と同じ形**（core は zod で書いていないので、
 * ここで zod の形に写す。`droppedResponseSchema` 冒頭 doc と同じ方針）。
 *
 * `other`: 3値のどれでもない値（保存層は緩い文字列なので理論上ありうる）。
 * `total`: good + bad + unclear + other。
 */
export const appraisalDecisionTallySchema = z.object({
  good: z.number().int(),
  bad: z.number().int(),
  unclear: z.number().int(),
  other: z.number().int(),
  total: z.number().int(),
});

/**
 * 仕事の種類ごとの評定行（#1308 段B。`@alteroid/core` の `AppraisalWorkKindTally`）。
 * `workKind` が `null` の行は**未分類**（構造欄の無い過去の評定行・種類を述べて
 * いない評定行）であって、種類の1つではない。
 */
export const appraisalWorkKindTallySchema = appraisalDecisionTallySchema.extend({
  workKind: z.string().nullable(),
});

/** 1つの `JobStatus`（終端した状態だけ）について、評定の有無を数えた行。 */
export const jobAppraisalCoverageRowSchema = z.object({
  status: jobStatusSchema,
  total: z.number().int(),
  appraised: z.number().int(),
  unappraised: z.number().int(),
});

/**
 * (クローンの値 → 人間の値) の組ごとの件数（#1310）。**`@alteroid/core` の
 * `AppraisalReconciliationTransition` と同じ形。**
 *
 * `cloneValue` / `humanValue` は3値のどれでもなければ `'other'`
 * （`appraisalDecisionTallySchema` の `other` と同じ理由）。
 */
export const appraisalReconciliationTransitionSchema = z.object({
  cloneValue: z.union([appraisalSchema, z.literal('other')]),
  humanValue: z.union([appraisalSchema, z.literal('other')]),
  count: z.number().int(),
});

/**
 * 1つの軸（台帳 or 委譲）ぶんの (b)/(c) 食い違い。**`@alteroid/core` の
 * `AppraisalReconciliation` と同じ形。**
 *
 * `undetermined` は「id または誰が付けたかが復元できず、対の判定に使えな
 * かった」評定行の件数——0件は「無かった」であって「測っていない」ではない
 * （`appraisal-stats.ts` の doc）。
 */
export const appraisalReconciliationSchema = z.object({
  transitions: z.array(appraisalReconciliationTransitionSchema),
  totalPairs: z.number().int(),
  matched: z.number().int(),
  mismatched: z.number().int(),
  undetermined: z.number().int(),
});

/**
 * `GET /appraisal-stats` の応答。
 *
 * - `journal.commitments` / `journal.jobs`: 日誌の `decision` 行を
 *   `COMMITMENT_APPRAISAL_DECISION_PREFIX` / `JOB_APPRAISAL_DECISION_PREFIX`
 *   それぞれの先頭一致で数えた**全期間の総数**（ページ送りで最後まで読み切って
 *   数えている。`limit` は1ページごとに掛かるが、総数か下限かとは別の軸である
 *   ——`appraisal-stats.ts` の doc、#1342）。**この2つを混ぜて読まないこと** —— 台帳の
 *   行の始末と、マネージャーに出した仕事の出来は別の軸である。
 * - `jobCoverage`: `JobStore` を終端の仕方（`done`/`failed`/`lost`/`stopped`）
 *   ごとに割った、評定の有無の内訳。`running`/`waiting_human`（まだ終端して
 *   いない）は `byStatus` に含めず、件数だけ `nonTerminalTotal` に出す。
 * - `reconciliation`（#1310）: (b) 人間 と (c) クローンの食い違い——クローンが
 *   付けた評定を人間が後から付け直した対を `commitments` / `jobs` の軸ごとに
 *   数えたもの。台帳と委譲は混ぜない（同じ理由）。
 * - `journal.byWorkKind`（#1308 段B）: 上の2つを評定行の構造欄が述べた仕事の
 *   種類ごとに割ったもの。件数の多い順で、未分類（`workKind: null`）は必ず最後。
 *   各軸の群の `total` の和は `journal.commitments` / `journal.jobs` の `total` と一致する。
 */
export const appraisalStatsResponseSchema = z.object({
  journal: z.object({
    commitments: appraisalDecisionTallySchema,
    jobs: appraisalDecisionTallySchema,
    byWorkKind: z.object({
      commitments: z.array(appraisalWorkKindTallySchema),
      jobs: z.array(appraisalWorkKindTallySchema),
    }),
  }),
  jobCoverage: z.object({
    byStatus: z.array(jobAppraisalCoverageRowSchema),
    terminalTotal: z.number().int(),
    terminalAppraised: z.number().int(),
    terminalUnappraised: z.number().int(),
    nonTerminalTotal: z.number().int(),
  }),
  reconciliation: z.object({
    commitments: appraisalReconciliationSchema,
    jobs: appraisalReconciliationSchema,
  }),
});

// ---------------------------------------------------------------------------
// アーカイブ（/archive）
// ---------------------------------------------------------------------------

/**
 * `GET /archive` / `GET /archive/sessions` の1行の共通部分（#698）。
 *
 * `storedBytes` は**その置き場（pg / fs）がこの行に実際に使っている量**で
 * あって、生ログの文字数ではない。**デーモンの永続化層をまたいで比較しては
 * ならない**——同じ応答の中で比べる分には安全である（同一デーモンは同一の
 * 層で動く）。詳しい意味は `@alteroid/core` の `ArchiveEntry` の doc を見ること
 * （このスキーマはそれをそのまま JSON へ写す）。
 */
export const archiveEntrySchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  at: z.string(),
  storedBytes: z.number().int(),
  /** tombstone 済み（`DELETE /archive/:id`）の行にだけ載る。 */
  removedAt: z.string().optional(),
  removedBytes: z.number().int().optional(),
  /**
   * 直前の退避との連続性（#698。`@alteroid/core` の `ArchiveContinuity` の
   * doc）。**この機能より前に積まれた行には無いので optional。**
   */
  continuity: z.enum(['first', 'continues', 'diverged', 'unknown']).optional(),
});

export const archiveListResponseSchema = z.object({ entries: z.array(archiveEntrySchema) });

/**
 * `GET /archive/sessions`（#698）の1行——`sessionId` ごとの集計。
 *
 * `rows` は `archive()` が呼ばれた回数（tombstone 済みの行も含む）。
 * Issue #698 でいちばん効いたのはこの `rows` である——同じセッションの
 * 生ログが68回積まれている、という重複の事実が、個々の大きさより先に
 * 問題の所在を特定した。
 *
 * `continuity`（#698 続き）はこの `sessionId` の全行の連続性判定の内訳。
 * **`absent` と `unknown` は別物である**（`@alteroid/core` の
 * `ArchiveContinuityTally` の doc）——`unknown` は判定はできたが直前の行に
 * 指紋が無かった、`absent` はその行自体が判定の門より前に積まれた。5つとも
 * 必須（`first + continues + diverged + unknown + absent === rows`）。
 */
export const archiveSessionSummarySchema = z.object({
  sessionId: z.string(),
  rows: z.number().int(),
  storedBytes: z.number().int(),
  maxStoredBytes: z.number().int(),
  firstAt: z.string(),
  lastAt: z.string(),
  continuity: z.object({
    first: z.number().int(),
    continues: z.number().int(),
    diverged: z.number().int(),
    unknown: z.number().int(),
    absent: z.number().int(),
  }),
});

export const archiveSessionsResponseSchema = z.object({
  sessions: z.array(archiveSessionSummarySchema),
});

/**
 * `DELETE /archive/:id` が消せた（あるいは前から消されていた）ことを言う
 * （#698）。**`alreadyRemoved` を隠さない**——「いま消した」と「前から消えて
 * いた」を同じ応答へ畳むと、呼び出し側は自分の呼び出しが実際に何をしたのかを
 * 見失う（`ArchiveRemoval` の doc と同じ理由）。
 */
export const archiveRemoveResponseSchema = z.object({
  ok: z.literal(true),
  id: z.string(),
  bytes: z.number().int(),
  alreadyRemoved: z.boolean(),
  /**
   * 走行中のマネージャーの退避を override で消したときだけ載る（#698）。
   * 既定拒否を開けた事実と理由を、応答からも追える形にする——`journal` にも
   * 同じ内容を残す（`app.ts` の `DELETE /archive/:id` ハンドラの doc）。
   */
  override: z.object({ managerId: z.string(), reason: z.string() }).optional(),
});

/**
 * `GET /archive/:id` / `GET /managers/:id/transcript` が 410 で返す本文
 * （tombstone。本文は落ちているが行は残っている、の詳細。#698）。
 *
 * `archiveId` は `GET /managers/:id/transcript` のときだけ載る——`/archive/:id`
 * は URL 自体が id を持つので冗長になる。
 */
export const archiveRemovedResponseSchema = z.object({
  error: z.literal('removed'),
  removedAt: z.string(),
  bytes: z.number().int(),
  archiveId: z.string().optional(),
});

/**
 * `POST /archive/remove` の入力（issue #698）。`POST /inbox/remove`
 * （#972）と同じ設計を踏襲する——絞り込み・既定（`dryRun` を省略すると
 * 試算）・`reason` 必須。
 *
 * **絞り込みの3項（`sessionIds` / `before` / `minStoredBytes`）はどれも
 * 任意だが、1つも渡さない呼びはハンドラ側（`app.ts`）が 400 で断る**
 * ——`@alteroid/core` の `ArchiveRemoveManyFilter` の doc と同じ役割分担で、
 * このスキーマ自身は「絞り込みが無い」を特別扱いしない。
 *
 * `requireContainment` の既定は `true`（`selectArchiveRemovalTargets` と
 * 同じ既定を踏襲する）。`false` を渡すのは、`continuity` を持たない既存の
 * 残骸を、内容が失われることを承知の上で人間が明示的に畳むときだけ。
 */
export const archiveRemoveManyRequestSchema = z.object({
  sessionIds: z.array(z.string().min(1)).min(1).optional(),
  before: z.string().min(1).optional(),
  minStoredBytes: z.number().int().min(0).optional(),
  requireContainment: z.boolean().optional(),
  dryRun: z.boolean().optional(),
  limit: z.number().int().min(1).optional(),
  reason: z.string().min(1),
});

/**
 * `POST /archive/remove` の応答（issue #698）。`skipped` の5つの理由は
 * `ArchiveRemovalSelection.skipped` の4つ（`newest` / `alreadyRemoved` /
 * `notContained` / `protected`）に、この HTTP 層だけが持つ5つ目
 * `inUse`（走行中のマネージャーの退避で `guardArchiveRemoval` が
 * `denied` / `unknown` を返した件数）を足したもの——`skipped` は0件でも
 * 欄を省かない（`ArchiveRemovalSelection` の doc と同じ理由）。
 *
 * `remaining` は絞り込みに当たったが `limit` に溢れて対象にすら
 * ならなかった件数（`selectArchiveRemovalTargets` の `remaining` を
 * そのまま写す）。**`limit` は guard（`inUse`）より前に効く**——
 * `selectArchiveRemovalTargets` が `limit` を適用した後の集合に guard を
 * 回すので、guard で飛ばした行も `limit` の枠を1つ使い切っている。⟹
 * `targeted` が `limit` に届いていないのに `remaining` が残っていることが
 * あるが、それはバグではない（`apps/daemon/src/app.ts` の
 * `POST /archive/remove` の doc）。
 *
 * `raced` は、guard までは通ったが実際に `stores.archive.remove()` する
 * までの間に他経路が先に消していた（`result.kind === 'missing'`）件数——
 * `dryRun: true` では `remove()` 自体を呼ばないので常に0（測れないことを
 * 隠さず0の理由を明記する。0件でも欄は省かない）。
 *
 * **不変条件（5欄で1行は必ず1回だけ数える。歯で撃つこと）:**
 * ```
 * matched === targeted + remaining + (skipped.protected + skipped.alreadyRemoved
 *            + skipped.newest + skipped.notContained + skipped.inUse)
 * targeted === removedIds.length + raced   // dryRun: false のときのみ
 * ```
 * `targeted` は **guard を通った後の件数**（＝実際に消しにいく件数）で
 * あって、`selectArchiveRemovalTargets` が選んだ件数そのものではない
 * ——guard で飛ばした行を `targeted` と `skipped.inUse` の両方に数えると
 * 1行を2回数えることになり、上の等式が壊れる。**`dryRun: true` でも
 * guard を評価するので、`targeted` / `skipped.inUse` は下見と実行で
 * 同じ値になる**（下見が実行の予告になっている、ということ）。
 */
export const archiveRemoveManyResponseSchema = z.object({
  ok: z.literal(true),
  dryRun: z.boolean(),
  totalRows: z.number().int(),
  matched: z.number().int(),
  targeted: z.number().int(),
  removedIds: z.array(z.string()),
  removedBytes: z.number().int(),
  remaining: z.number().int(),
  skipped: z.object({
    newest: z.number().int(),
    alreadyRemoved: z.number().int(),
    notContained: z.number().int(),
    protected: z.number().int(),
    inUse: z.number().int(),
  }),
  raced: z.number().int(),
});

// ---------------------------------------------------------------------------
// 受信箱（/inbox）— issue #972（畳む＝ POST /inbox/remove）/ #783 段0
// （読む＝ GET /inbox。内訳を読む口がクローンの道具にしか無かった欠落）
// ---------------------------------------------------------------------------

/**
 * `GET /inbox` の応答（issue #783 段0の最後の欠落——内訳を読む口が
 * HTTP に無かった）。`@alteroid/core` の `summarizeInboxBacklog` の結果を
 * そのまま JSON にしたもので、**ここでは集計を1文字も行わない**——集計を
 * 2箇所に複製すると、クローンの道具（`manager_list`）とこの口が違う数を
 * 見ることになる（`inboxBacklogDedupeKey` の doc「なぜ1箇所に閉じるか」と
 * 同じ理由）。
 *
 * **core は zod で書いていないので、ここで zod の形に写す**
 * （`appraisalStatsResponseSchema` 冒頭 doc と同じ方針）。詳しい意味は
 * `@alteroid/core` の `InboxBacklogBreakdown` の doc を見ること。
 *
 * `byType` / `undeliveredByType` の `type` は `INBOX_EVENT_TYPE_ORDER`
 * （7種）をそのまま使う——`inboxRemoveManyRequestSchema.types` と同じ配列を
 * 参照するので、`InboxEvent` に型が増えたらここも自動で追随する。
 * `humanOriginated.byType` だけは人間起点の2種に絞る
 * （`isHumanOriginated` の doc）。
 *
 * **`bySource` は上位5件で打ち切ってある（`summarizeInboxBacklog` 側の
 * 上限）。ここでは新しい上限を足していない**——`bySourceOverflowKinds` /
 * `bySourceOverflowCount` / `bySourceUnknownCount` が、打ち切った分・
 * 送信元を言えない型の分を0件でも必ず運ぶので、`bySource` の内訳の合計 +
 * この3値 === `total` が常に成り立つ（`InboxBacklogBreakdown` の doc）。
 */
export const inboxBacklogResponseSchema = z.object({
  total: z.number().int(),
  oldestAt: z.string().optional(),
  byType: z.array(z.object({ type: z.enum(INBOX_EVENT_TYPE_ORDER), count: z.number().int() })),
  bySource: z.array(z.object({ source: z.string(), count: z.number().int() })),
  bySourceOverflowKinds: z.number().int(),
  bySourceOverflowCount: z.number().int(),
  bySourceUnknownCount: z.number().int(),
  distinct: z.number().int(),
  distinctAcrossManagers: z.number().int(),
  undelivered: z.number().int(),
  deliveredOnce: z.number().int(),
  redelivered: z.number().int(),
  maxDeliveries: z.number().int(),
  undeliveredByType: z.array(
    z.object({ type: z.enum(INBOX_EVENT_TYPE_ORDER), count: z.number().int() }),
  ),
  ageBuckets: z.array(z.object({ label: z.string(), count: z.number().int() })),
  observedAt: z.string(),
  humanOriginated: z.object({
    total: z.number().int(),
    byType: z.array(
      z.object({ type: z.enum(['human_message', 'human_answer']), count: z.number().int() }),
    ),
    oldestAt: z.string().optional(),
    undelivered: z.number().int(),
  }),
});

/**
 * `POST /inbox/remove` の入力（issue #972 提案4「人間の入口から叩けること」）。
 * 絞り込み（種類・送信元・齢）・既定（`dryRun` を省略すると試算）は
 * `commitment_close_many`（#844）を参照モデルにした。
 *
 * **クローン自身の道具（`inbox_remove_many`）は在る**（`packages/core/src/tools.ts`）。
 * ⚠️ **ここには「まだ無い」と書いてあったが、いまは嘘である**（#1049 の PR で
 * 直した。経緯は #972 本文が「クローン自身の道具にするかは別途の判断」と保留
 * していたところへ依頼のブリーフが誤って必須スコープに書き、いったん取り下げ、
 * その後に入った——詳しい経緯は `tools.ts` の `inbox_remove_many` の側にある）。
 *
 * **選べる種類は道具と HTTP で違う。** 道具は
 * `CLONE_REMOVABLE_INBOX_EVENT_TYPES`（人間起点の合図を選べない）に絞るが、
 * この HTTP の口は `types` に在る7種類のどれも制限なく渡せる（人間が直接操作
 * する入口なので、自分自身の発言を巻き込むことの是非は道具の場合と条件が
 * 異なる）。
 *
 * **`types` は必須で空にできない。** ハンドラ側（`app.ts`）で「在る7種類を
 * 全部並べた呼びは断る」を判定する——ここでは判定しない（`z.array` に
 * 「特定の組み合わせを禁じる」制約は素直に書けないため。`commitment_close_many`
 * と同じ役割分担）。
 */
export const inboxRemoveManyRequestSchema = z.object({
  types: z.array(z.enum(INBOX_EVENT_TYPE_ORDER)).min(1),
  sources: z.array(z.string().min(1)).min(1).optional(),
  before: z.string().min(1).optional(),
  reason: z.string().min(1),
  dryRun: z.boolean().optional(),
  limit: z.number().int().min(1).optional(),
});

/**
 * `POST /inbox/remove` の応答。**`removedIds` は打ち切らない**——JSON の
 * 応答は人間・スクリプトが読むもので、クローンの道具の文脈窓のような制約が
 * 無い。
 *
 * ## `droppedFromDelivery`（issue #1049）
 *
 * **消した合図のうち、クローンの配達待ちからも外せた件数。** この口はかつて
 * 器（`InboxStore`）の行しか消さず、**既にクローンのメモリ上の待ち行列へ載った
 * 合図はそのまま配られ続けた**のに、応答は `removedIds` を並べて「消した」と
 * 名乗っていた。⟹ **消えた件数だけを返すと、その名乗りに戻る。**
 *
 * **`removedIds.length` より小さいのが普通である。** 器に在っても、まだ待ち
 * 行列へ載っていない合図（`#restoreUnread` がこれから拾う分）が在るので。
 * ⚠️ **既に取り出して処理中の1件は取り消せない**ので、ここにも数えない
 * （`Clone#dropQueuedInboxEvents` の doc）。
 *
 * **`dryRun: true` の回は常に 0 である**（1件も消していないので、止める対象が
 * 無い）。**欄を省かずに 0 を返す** —— 省くと「配達を止める機構が無い版」と
 * 「試算だったから 0」が応答から区別できなくなる。
 */
export const inboxRemoveManyResponseSchema = z.object({
  ok: z.literal(true),
  dryRun: z.boolean(),
  totalPending: z.number().int(),
  matched: z.number().int(),
  targeted: z.number().int(),
  removedIds: z.array(z.string()),
  droppedFromDelivery: z.number().int(),
  remaining: z.number().int(),
});

// ---------------------------------------------------------------------------
// ワークスペースのリセット（/reset）— #workspace-reset
// ---------------------------------------------------------------------------

/**
 * **`confirm: true` を必須にする。** CLI（読み確認プロンプト）・Web UI（確認
 * ダイアログ）はどちらも呼ぶ前に人間へ確認するが、この口自体にも確認の印を
 * 要求することで、確認を経ずにこの経路を直接叩くどんな呼び出し（スクリプト・
 * 将来の第三の UI）も 400 で止まる——確認は UI の見た目の話にせず、契約の
 * 一部にする。
 */
export const resetRequestSchema = z.object({
  confirm: z.literal(true),
});

/**
 * 何を何件消したか（`@alteroid/core` の `WorkspaceResetSummary` をそのまま
 * JSON へ写す）。**件数を返すのは「本当に消えたか」を呼び出し側が確かめられる
 * ようにするためである** — `{ ok: true }` だけでは、対象が既に空だったのか
 * 何百件と消したのかが呼び出し側から見えない。
 */
export const resetResponseSchema = z.object({
  cleared: z.object({
    memory: z.number().int(),
    journal: z.number().int(),
    jobs: z.number().int(),
    approvals: z.number().int(),
    schedules: z.number().int(),
    schedulePhases: z.number().int(),
    inbox: z.number().int(),
    commitments: z.number().int(),
    /**
     * やり方（#1055 段3）。**ここへ足し忘れると静かに落ちる** —— この schema は
     * `resetResponseSchema.parse({ cleared })` として応答に当てており、zod は
     * 未知のキーを既定で**黙って捨てる**。器は消したのに申告には出ない、という
     * 形になる（`WorkspaceResetSummary.practices` の doc）。
     */
    practices: z.number().int(),
    archive: z.number().int(),
    sessions: z.number().int(),
    profile: z.number().int(),
    usageDaily: z.number().int(),
    usageBaseline: z.number().int(),
    usageLedger: z.number().int(),
    usageTurns: z.number().int(),
    /** pg 構成でだけ付く（`WorkspaceResetSummary.sessionLog` の doc）。 */
    sessionLog: z.number().int().optional(),
  }),
});

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
      name: 'mcp-servers',
      description:
        '人間の MCP 連携の登録（.mcp.json 相当。#325）。記憶ストアに置き、クローンの' +
        'セッションへ SDK の mcpServers として渡す。env / headers に鍵が入りうる',
    },
    {
      name: 'auth',
      description:
        'ログイン（誰がこの API を叩いているか）。PRD「権限境界」（クローンが記憶を' +
        '根拠に何を人間へ確認するか）とは別の層で、持つのは許可の2値だけである',
    },
    {
      name: 'access',
      description:
        'アクセス許可の付与・剥奪。alteroid を使う許可（access grant 済み）があれば' +
        '実行環境の持ち主と同格に叩ける（2026-09-06 のオーナー決定）',
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
          '`token`。CLI がこれを使う。ここを読めること自体が境界である）。\n\n' +
          '**`/access/*` `/tokens*` は①②どちらでも通る**（2026-09-06 のオーナー決定' +
          '——alteroid を使う許可があれば実行環境の持ち主と同格）。**②でしか通らない' +
          'のは `/profile`（実行環境そのものを差し替える口）だけである。**\n\n' +
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
    appraise() {
      throw new Error('spec 生成専用のスタブ: 評定は書かない');
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
    pushHealthOf() {
      throw new Error('spec 生成専用のスタブ: 押し込み結果は持たない');
    },
    runnerBacklog() {
      throw new Error('spec 生成専用のスタブ: 器の滞留は観測していない');
    },
    runnerIdOf() {
      throw new Error('spec 生成専用のスタブ: 委譲の像は持たない');
    },
    transcript() {
      throw new Error('spec 生成専用のスタブ: 生ログは持たない');
    },
    unpushedWork() {
      throw new Error('spec 生成専用のスタブ: 未 push の実装は数えない');
    },
    runningManagerOwning() {
      throw new Error('spec 生成専用のスタブ: 走行中の像は持たない');
    },
    restore() {
      throw new Error('spec 生成専用のスタブ: 引き継ぎはしない');
    },
    resumeStoppedByUsage() {
      throw new Error('spec 生成専用のスタブ: 枠で止まった委譲は起こさない');
    },
    reattachRunner() {
      throw new Error('spec 生成専用のスタブ: 取り直しはしない');
    },
    relocateFrom() {
      throw new Error('spec 生成専用のスタブ: 移送はしない');
    },
    vacate() {
      throw new Error('spec 生成専用のスタブ: 空けない');
    },
    probeTurnEnds() {
      throw new Error('spec 生成専用のスタブ: ターン終了の探りはしない');
    },
    flushWithheldReports() {
      throw new Error('spec 生成専用のスタブ: 握り潰した報告は無い');
    },
    settleStalledUsageWakes() {
      throw new Error('spec 生成専用のスタブ: 枠で止まった借りは清算しない');
    },
    stop() {
      throw new Error('spec 生成専用のスタブ');
    },
  };

  const stubClone: CloneHost = {
    managers: stubManagers,
    // **`managers` と同じ扱い——読み取り専用のプロパティは throw できない**
    // （関数と違い、参照した瞬間に値が要る）。spec 生成はこの値を1文字も見ないので、
    // 中身に意味は無い。
    usageBlocked: false,
    usageReleasePending: false,
    usageBlockedResetsAt: undefined,
    usageBlockedTokenId: undefined,
    recycleSessionForToken() {
      throw new Error('spec 生成専用のスタブ: セッションは作らない');
    },
    post() {
      throw new Error('spec 生成専用のスタブ: 受信箱には積まない');
    },
    dropQueuedInboxEvents() {
      throw new Error('spec 生成専用のスタブ: 配達の待ち行列は無い');
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
