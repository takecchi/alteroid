import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { z } from 'zod';

import type { UnreadableAccount } from './schema.js';
import type { RemoveUnreadableRowsOptions, RemoveUnreadableRowsResult } from './store.js';

/**
 * ログイン（誰が API を叩いているか）と、その人が alteroid を使ってよいかの2値。
 *
 * **これは PRD「権限境界」とは別の話である。** あちらは「クローンが何を人間に
 * 確認するか」を記憶で決める話で、行為の一覧を持ってはいけない。こちらは
 * 「そもそも誰がこの API に触れるか」であり、north_star 禁止2 が制限の表現方法
 * として**認めている実行環境の境界**（認証情報の配布範囲）そのものである。
 * 混ぜると、能力を削る仕組みを「認証」の名前で持ち込むことになる。
 *
 * したがってここに持つのは**許可されているか否かの2値だけ**で、
 * 「chat は可・記憶の編集は不可」のような行為別のスコープは持たない。
 *
 * マルチユーザーではない（PRD 非ゴール）。持ち主が複数の端末・複数のログイン手段
 * から入ってこられるようにするための層であって、利用者ごとにデータを分けない。
 *
 * ⚠️ **その非ゴールが禁じているのは「データを分けること」であって「入口の数」では
 * ない。** 許可は複数のアカウントへ出せる（2026-09-09 のオーナー決定。それ以前は
 * 高々1つだった）。許可を持つ全員が同じ1組の記憶・日誌・会話を見る — 分けたく
 * なった時点で、それが非ゴールの境界である（`AuthStore.grantAccess` の doc）。
 */

const isoDateTime = z.string().datetime({ offset: true });

/** プロバイダ識別子（`google` / 将来 `discord` / `password`）。 */
export const authProviderIdSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/);

/**
 * ログインした人。**外部 identity とは別の層に置く。**
 *
 * 分けておかないと、後からパスワード認証を足すときに「パスワードは外部
 * identity ではないのに identity 表に入る」というねじれが出る。また Google と
 * Discord の両方で入ったときに同一人物へ束ねられなくなる。
 */
export const authAccountSchema = z.object({
  id: z.string().min(1),
  /** 表示用の名前。初回のログイン時にプロバイダから貰ったものを入れる。 */
  displayName: z.string().nullable(),
  /**
   * 本人が選んだ連絡先。**プロバイダ側の変更で勝手に上書きしない。**
   * ここに入っているメールは検証済みであることを不変条件とする（未検証のものは
   * identity 側にだけ置く）。
   */
  email: z.string().nullable(),
  createdAt: isoDateTime,
  lastLoginAt: isoDateTime.nullable(),
  /**
   * 許可の2値。`null` なら未許可＝ログインはできるが alteroid は使えない。
   * 付与は CLI（`alteroid access grant`）から行う。
   */
  grantedAt: isoDateTime.nullable(),
  /**
   * 誰が許可したか。
   *
   * - `operator` = 状態ファイルを読める実行環境の持ち主
   * - **それ以外は、許可を与えたアカウントの id**（2026-09-06 の同格化で、許可された
   *   アカウントも `/access/*` を叩けるようになったため）
   *
   * **固定値を書かないこと。** ここが常に同じ値なら、この欄は情報を運ばない。
   */
  grantedBy: z.string().nullable(),
  /**
   * **実行環境の持ち主として宣言されたのはいつか。**（issue #1198）
   *
   * `null` なら誰も owner ではない。**立てられるのは operator トークンだけ**
   * （`AuthStore.setAccountOwner`）。`grantedBy === 'operator'`（旧
   * `isAccountGrantedByOperator` の近似）とは独立に持つ — 許可した事実と、
   * 持ち主本人であると宣言された事実は別のことである。
   *
   * **`.default(null)` は必須である。** 既存の fs の JSON にはこの鍵が無い。
   * 無ければ `authAccountSchema.parse` が失敗し、起動できなくなる —— 新しい
   * 欄を足すたびに、既存データがその欄を持たないことを既定値で吸収する。
   */
  ownerDeclaredAt: isoDateTime.nullable().default(null),
});

/**
 * 外部プロバイダ上の identity。`(provider, subject)` が一意。
 *
 * `email` はプロバイダが言っているメールで、ログインのたびに同期してよい
 * （本人が選んだ連絡先ではないため）。
 */
export const authIdentitySchema = z.object({
  provider: authProviderIdSchema,
  /** プロバイダ側の一意な id（Google なら `sub`）。メールではない。 */
  subject: z.string().min(1),
  accountId: z.string().min(1),
  email: z.string().nullable(),
  emailVerified: z.boolean(),
  createdAt: isoDateTime,
  lastLoginAt: isoDateTime,
});

/**
 * 発行済みアクセストークン。**素の値は保存しない**（sha256 だけ持つ）。
 *
 * 記憶へ到達できる鍵なので、漏れた保管先から復元できてはいけない。
 * `GET /auth/tokens` も素の値は返さない（`credentials.ts` の指紋と同じ考え方）。
 */
export const accessTokenRecordSchema = z.object({
  id: z.string().min(1),
  accountId: z.string().min(1),
  sha256: z.string().length(64),
  /** どの端末で発行したか、人間が見分けるための覚書。 */
  label: z.string(),
  createdAt: isoDateTime,
  expiresAt: isoDateTime.nullable(),
  lastUsedAt: isoDateTime.nullable(),
  revokedAt: isoDateTime.nullable(),
});

/**
 * 進行中のログイン試行。CLI とブラウザの往復を繋ぐ。
 *
 * `state` を HMAC で署名する代わりに、この行そのものを突き合わせに使う
 * （サーバ側に置き場があるので署名鍵を増やす必要が無い）。
 */
export const loginRequestSchema = z.object({
  id: z.string().min(1),
  provider: authProviderIdSchema,
  /** state の後半。突き合わせは timing-safe に行う。 */
  nonce: z.string().min(1),
  /** PKCE の code_verifier。 */
  codeVerifier: z.string().min(1),
  /** CLI が引き取り時に提示する秘密の sha256。素の値は CLI だけが持つ。 */
  claimSha256: z.string().length(64),
  /** token 交換時にも同じ値を送る必要がある（プロバイダ側の突き合わせ）。 */
  redirectUri: z.string().min(1),
  label: z.string(),
  createdAt: isoDateTime,
  expiresAt: isoDateTime,
  /**
   * `processing` は「プロバイダとトークン交換中」。
   *
   * **これが無いと、同じ callback が並行に届いたとき両方が交換へ進む。** 認可コードは
   * 一度きりなので片方は必ず失敗し、その失敗が古い写しを元に `failed` を書いて、
   * 成功した側の `authenticated` を後から上書きしうる（ログインを回収できなくなる）。
   * 交換へ進む権利は1リクエストだけが取る。
   */
  status: z.enum(['pending', 'processing', 'authenticated', 'consumed', 'failed']),
  accountId: z.string().nullable(),
  /** 失敗した理由（ブラウザではなく端末側に見せる）。 */
  error: z.string().nullable(),
});

export type AuthAccount = z.infer<typeof authAccountSchema>;
export type AuthIdentity = z.infer<typeof authIdentitySchema>;
export type AccessTokenRecord = z.infer<typeof accessTokenRecordSchema>;
export type LoginRequest = z.infer<typeof loginRequestSchema>;
export type LoginRequestStatus = LoginRequest['status'];

/**
 * ログインとアクセス許可の置き場。fs / pg のどちらのドライバでも同じ IF を満たす
 * （器が違うだけで上の層が見るものは同じ）。
 */
export interface AuthStore {
  /**
   * `createdAt` の**実時刻**昇順、**同着（`createdAt` が完全に同じ）は `id`
   * で決める**（issue #1676 / #1688）。
   *
   * 文字列の `localeCompare` で並べないこと——`isoDateTime` はオフセット
   * 付きの任意の表記を許すので、同じ瞬間でも書き方は一意ではなく、文字列比較
   * では実時刻の順が崩れうる。
   *
   * **2次キー（`id`）が要る理由**: `createdAt` だけでは同着行どうしの順が
   * 決まらない。fs は「既存行を消して末尾へ足す」実装なので、同着の2行の
   * うち片方だけ後から更新すると安定ソートで順が動く。pg は2次キーの無い
   * `ORDER BY` では同着の順を保証しない。**挿入順を約束にはしない**——
   * 3実装とも `id` という明示的な2次キーで並びを完全に決める。
   */
  listAccounts(): Promise<AuthAccount[]>;
  /**
   * **`listAccounts()` が読み飛ばした行**（fs の `invalidAccountsRaw`）を、**中身を含まない形**
   * （id と不正な欄名だけ）で返す（issue #2536。`PermissionGrantStore.listUnreadable` と同じ線）。
   * email・identity・アクセストークンは決して返さない（`unreadableAccountSchema` の doc）。
   * **pg とメモリは列/スキーマ越しで持つので読めない行が無く、常に空。**
   */
  listUnreadableAccounts(): Promise<UnreadableAccount[]>;
  getAccount(id: string): Promise<AuthAccount | null>;
  /**
   * 検証済みメールの衝突検査に使う。
   *
   * **大小文字を区別しない（#1702）。** `alice@example.test` と
   * `ALICE@EXAMPLE.TEST` は同じメールとして扱う——3実装（memory / fs / pg）
   * とも比較の前に小文字化する（pg は `lower(email) = lower($1)`）。保存する
   * メールそのもの（表示用）は正規化しない——比較のときだけ小文字にそろえる。
   *
   * ⚠️ **issue #1751 / #1741 以降、`completeLogin`（`auth-service.ts`）はこれを
   * 呼ばない。** 衝突検査は `createAccountWithIdentity` の1操作の中へ移した
   * （このメソッドの doc）——「読んでから書く」形の外側検査だと、別々の
   * identity が同じ検証済みメールで同時に初回ログインしたとき、両方が
   * 「衝突なし」を見てしまうため。**このメソッドは現時点でテスト以外の
   * 呼び手が無い。** IF には残す（衝突検査という概念そのものに用途が
   * 他に出てくる可能性があるため）が、新しい呼び手を足すときは、それが
   * 「読んでから書く」形の穴を再び作っていないか確かめること。
   */
  findAccountByEmail(email: string): Promise<AuthAccount | null>;
  putAccount(account: AuthAccount): Promise<void>;
  /**
   * この account の `lastLoginAt` だけを `at` にする（1操作。issue #1870）。
   *
   * **`lastLoginAt` 以外の欄には触らない。とくに `grantedAt` / `grantedBy` /
   * `ownerDeclaredAt` を書き戻さない。** `completeLogin`（`auth-service.ts`）の
   * 再ログイン分岐（既存 identity・同時ログインで負けた側の両方）は、以前
   * `getAccount` で読んだ行を `putAccount` で丸ごと書き戻していた。読んでから
   * 書くまでのあいだに `access grant` / `access revoke` / owner 宣言が完了
   * すると、その結果が読んだときの古いスナップショットで上書きされていた
   * （`markAccessTokenUsed` が #1782 で塞いだ lost update と同じ形——対象が
   * アクセストークンの `lastUsedAt` から account の `lastLoginAt` に変わっただけ）。
   *
   * その id の行が無いときは何もしない（投げない）。
   *
   * ドライバはそれぞれの器で原子性を出す — fs は1つの排他区間、pg は
   * 条件無しの UPDATE 1文で、`last_login_at` だけを書く。
   */
  markAccountLoggedIn(accountId: string, at: string): Promise<void>;
  /**
   * この account の許可を取り消す（1操作。issue #1915）。
   *
   * **`grantedAt` / `grantedBy` / `ownerDeclaredAt` の3欄だけを null にする。
   * それ以外の欄（`lastLoginAt` を含む）には触らない。** `AuthService.revoke`
   * は以前、`getAccount` で読んだ行を丸ごと `putAccount` で書き戻していた
   * ——読んでから書くまでのあいだに完了した再ログイン
   * （`markAccountLoggedIn`）の `lastLoginAt` を、読んだときの古い
   * スナップショットで上書きしていた（`markAccessTokenUsed` が #1782 で
   * 塞いだのと同じ形の lost update。対象がアクセストークンの `lastUsedAt`
   * から account の `lastLoginAt` に変わっただけ）。
   *
   * その id の行が無いときは何もしない（投げない）。**ただし行が在るのに読めない
   * （`authAccountSchema` に合わない。fs の `invalidAccountsRaw`）ときは
   * `UnreadableAccountError` を投げ、行は変えない**（issue #2425）。「無い」と
   * 同じ扱いにすると、落としたつもりの `grantedAt` が残ったまま、後で行が読める
   * ようになったときに許可が生き返る。読めない行は `getAccount()` に現れず認可は
   * 通らないので、投げても許可が余計に通ることは無い。
   *
   * ドライバはそれぞれの器で原子性を出す — fs は1つの排他区間、pg は
   * 条件無しの UPDATE 1文で、3欄だけを書く（pg は列で持つので読めない行の
   * 概念が無い）。
   */
  revokeAccountAccess(accountId: string): Promise<void>;
  /**
   * **読めないアカウントの行を、id で指して消す**（issue #2440。`PermissionGrantStore.
   * removeUnreadable` と同じ形・同じ約束）。読めない行（fs の `invalidAccountsRaw`）は
   * `revokeAccountAccess` が `UnreadableAccountError` を投げて触らないので、片付ける口は
   * これだけである。
   *
   * 指した id が1つでも読めない行に無ければ、何も消さずに `{ kind: 'unknown' }`（件数だけ）。
   * `beforeRemove` を排他区間の中で先に呼び、投げたら何も消さない。**読めたアカウントと、
   * identity・アクセストークンには触れない。** id が取れない行はこの口では消せない（手で直す）。
   *
   * **pg は列で持つので、読めない行という概念が無い**——常に `{ kind: 'unknown' }` を返す。
   */
  removeUnreadableAccounts(
    ids: readonly string[],
    options?: RemoveUnreadableRowsOptions,
  ): Promise<RemoveUnreadableRowsResult>;

  findIdentity(provider: string, subject: string): Promise<AuthIdentity | null>;
  /**
   * `createdAt` の実時刻昇順、**同着は `provider` → `subject` で決める**
   * （`listAccounts` の doc と同じ理由。issue #1676 / #1688）。
   * `(provider, subject)` は一意なので、これで並びが完全に決まる。
   */
  listIdentities(accountId: string): Promise<AuthIdentity[]>;
  putIdentity(identity: AuthIdentity): Promise<void>;

  /**
   * 「初めて見る identity」の account 作成を**1操作で**行う（issue #1714。
   * `.claude/skills/auth-and-access/SKILL.md`「不変条件はストアの1操作に閉じる
   * こと」の4つ目）。
   *
   * `completeLogin` の当該分岐は、直す前は `findIdentity` → （無ければ）
   * `putAccount` → `putIdentity` という**読んでから書く**形をしていた。同じ
   * `(provider, subject)` の2つのログインが同時に着くと、両方が `findIdentity`
   * で `null` を見て、それぞれ別の `AuthAccount` を作ってしまう——`putIdentity`
   * は `(provider, subject)` で上書きなので後に書いた側が勝ち、**負けた側の
   * account は identity から参照されなくなる**（`listAccounts()` には残るが、
   * 二度とそのアカウントではログインできない）。
   *
   * その `(provider, subject)` の identity が**無ければ** `account` と
   * `identity` を一緒に作って `{ created: true, account }` を返す。**在れば
   * 何も書かず**既存の identity を `{ created: false, existing }` で返す——
   * 呼び手（`completeLogin`）はこれを「既存 identity のログイン」と同じ扱いに
   * 落とす（既存アカウントで認証し、`lastLoginAt` と identity のメールを
   * 追従させる）。
   *
   * **「読む → 検査 → 書く」に割ってはいけない。** 割ると、検査と書き込みの間に
   * 別の呼び出しが同じ identity を作る窓ができ、上と同じ形の重複が再発する。
   *
   * ⚠️ **検証済みメールの衝突検査も、この1操作の中で行う（issue #1751 /
   * #1741）。** `completeLogin` は `account.email` に「候補のメール」（検証済み
   * ならプロバイダのメールをそのまま）を載せて渡す——**衝突の有無はここが
   * 決める。** `account.email` が空でなく、**別の** account が大小文字を
   * 区別せずに同じメールを既に持っているなら、**空のメールで作る**
   * （検証済みメールの一意性を壊さない）。`{ created: true }` の `account` には
   * **実際に保存した account**（衝突していればメールが空の版）を載せる——呼び手は
   * これを見て、自分が渡した候補がそのまま通ったかどうかを知る。
   *
   * **なぜ `findAccountByEmail` の外側検査（直す前の形）では不十分だったか**:
   * 同じ `(provider, subject)` の競合はこの操作の内側（identity の一意制約）で
   * 塞がるが、**別々の** identity が同じ検証済みメールで同時に初回ログイン
   * すると、外側の `findAccountByEmail` は両方とも「衝突なし」を見る——
   * どちらの候補にもメールが乗ってしまう。衝突検査を「読んでから書く」の
   * 外側に置く限り、この形の競合は塞げない。
   *
   * ドライバはそれぞれの器で原子性を出す——fs は1回の書き込みで、pg は1つの
   * トランザクション内で**先に** identity を条件付き（一意制約）で insert し、
   * 入ったときだけ account を insert する。
   *
   * ⚠️ **pg で account を先に insert してはいけない。** `auth_accounts_email_
   * lower_idx`（#1702。検証済みメールの一意索引）が本番に在るため、同じ
   * identity の2つのログインが同じ検証済みメールを候補 account に載せうる
   * （メールの衝突検査はこの操作の中にあるが、識別は identity の一意制約が
   * 先に効くことに変わりはない）——account を先に insert すると、負けた側が
   * identity の一意制約へ辿り着く前に**メールの一意制約違反という別の例外**
   * で落ちる（`.claude/skills/auth-and-access/SKILL.md` にも同じ注記がある）。
   * identity を先にすれば、負けた側は identity の一意制約だけで do nothing
   * になり、メールの索引には当たらない。**別々の** identity が同じメールで
   * 競合する場合（#1751 / #1741 が直した形）は、account の insert 自体が
   * `on conflict do nothing` で試され、入らなければメールを空にして入れ直す
   * ——実装は `packages/storage-pg/src/auth.ts` の doc を見ること。
   */
  createAccountWithIdentity(input: {
    account: AuthAccount;
    identity: AuthIdentity;
  }): Promise<CreateAccountWithIdentityOutcome>;

  putAccessToken(token: AccessTokenRecord): Promise<void>;
  /**
   * このアクセストークンの `lastUsedAt` だけを `at` にする（1操作。issue #1782）。
   *
   * **`lastUsedAt` 以外の欄には触らない。とくに `revokedAt` を書き戻さない。**
   * 以前の `touch()` は、読んだときの行の写しを `putAccessToken` で丸ごと
   * 書き戻していた。そのため、読んでから書くまでのあいだに完了したログアウト
   * （`revokeAccessToken`）の `revokedAt` が `null` に戻り、ログアウトした
   * トークンが黙って生き返っていた（許可 DB の #1680 / #1694 と同じ形の lost
   * update）。
   *
   * **失効済みのトークンには書かない**（使われた記録を、失効したトークンに
   * 残さない）。その id の行が無いときも何もしない。
   *
   * ドライバはそれぞれの器で原子性を出す — fs は1つの排他区間、pg は
   * 条件付き UPDATE（`revoked_at is null`）で、`last_used_at` だけを書く。
   */
  markAccessTokenUsed(id: string, at: string): Promise<void>;
  findAccessTokenBySha256(sha256: string): Promise<AccessTokenRecord | null>;
  /**
   * `createdAt` の実時刻昇順、**同着は `id` で決める**（`listAccounts` の doc
   * と同じ理由。issue #1676 / #1688）。
   */
  listAccessTokens(accountId: string): Promise<AccessTokenRecord[]>;
  /**
   * この1本のアクセストークンだけを失効させる（1操作。issue #1757）。
   *
   * **`revokedAt` が空のときだけ立てる。先に立っていた時刻は動かさない**
   * （冪等——同じトークンに二度失効を掛けても、最初に失効した時刻のまま）。
   * `AuthStore` の他の1操作（`grantAccess` / `setAccountOwner`）と同じ理由——
   * 「読む→検査→書く」に割ると、同じトークンへの同時ログアウトで、後から来た
   * 側が `revokedAt` を上書きしうる（このトークンは1件しか無いので「上書き」の
   * 実害は薄いが、規約は他の1操作と揃えておく——3実装が同じ形を守るほうが、
   * 後から読む者にとって驚きが無い）。
   *
   * **アカウントごとの `revoke()`（`access revoke`。許可そのものを落とす）とは
   * 別の操作である。** こちらは指定した **id の1本だけ** を失効させ、同じ
   * アカウントの他のトークンには触らない——ログアウトは「いま提示している
   * 資格」だけを失効させる操作であって、アカウント全体の締め出しではない。
   *
   * 戻り値は3つを区別する（`grantAccess` の `GrantOutcome` と同じ流儀）:
   * - `not_found` — その id のトークンが無い
   * - `already_revoked` — 既に失効済み（今回は何も書いていない。`token` は
   *   失効済みの現在の行）
   * - `revoked` — いま失効させた（`token` は失効後の行）
   *
   * ドライバはそれぞれの器で原子性を出す — fs は1回の書き込み、pg は
   * 条件付き UPDATE（`revoked_at is null`）で強制する。
   */
  revokeAccessToken(id: string, at: string): Promise<RevokeAccessTokenOutcome>;

  putLoginRequest(request: LoginRequest): Promise<void>;
  getLoginRequest(id: string): Promise<LoginRequest | null>;

  /**
   * `pending` のログイン要求を `processing` へ**原子的に**移し、移せたときだけ返す。
   *
   * **外部プロバイダとの交換へ進む権利をここで1つに絞る。** ブラウザの再送や
   * プロキシのリトライで同じ `state + code` が並行に届くのは普通に起きる。読んでから
   * 書く形だと両方が `pending` を通過して両方が交換し、認可コードが一度きりである以上
   * 片方は失敗する。その失敗が古い写しから `failed` を書けば、成功した側の
   * `authenticated` を上書きして**ログインを回収できなくなる**。
   */
  beginLoginExchange(id: string): Promise<LoginRequest | null>;

  /**
   * `authenticated` のログイン要求を `consumed` へ移し、**同じ操作で**
   * アクセストークンを保存する。移せたときだけ結果を返す（移せなければ `null`）。
   *
   * **2つに分けてはいけない。** 分け方は2通りあって、どちらも壊れる。
   *
   * - 「読む → 検査 → 書く」に分けると、同じ `requestId` と `claimSecret` を同時に
   *   投げるだけで両方が `authenticated` を読み、それぞれ有効なトークンを受け取れる
   *   （「返るのはこの1回だけ」が破れる）
   * - 「先に `consumed` にする → 後でトークンを保存する」に分けると、保存に失敗した
   *   ときトークンは返らないのに要求は `consumed` のままになり、**同じログインを
   *   二度と回収できない**（人間はやり直すしかないが、それが分からない）
   *
   * したがって `issue` は**この操作の中で**呼ばれ、両方が成るか両方が成らないかの
   * どちらかになる。`issue` は純粋関数として書くこと（中で待たない）。
   *
   * ドライバはそれぞれの器で原子性を出す — fs は1回の書き込みで、pg は1つの
   * トランザクション内の条件付き UPDATE ＋ INSERT で。
   */
  claimLoginRequest(
    id: string,
    issue: (request: LoginRequest) => AccessTokenRecord,
  ): Promise<{ request: LoginRequest; token: AccessTokenRecord } | null>;

  /**
   * この account を許可する（1操作）。**既に許可済みなら何も書かずに `granted` を返す。**
   *
   * ⚠️ **2026-09-09 のオーナー決定まで、ここは `grantExclusive` という名前で、
   * 「許可されたアカウントが他に居なければ」という条件が付いていた**（`granted_at` が
   * 入る行をテーブル全体で1行に絞り、2人目は `conflict` で弾いていた）。**その条件を
   * 外した** — 同じ人間が複数の Google アカウントから入れないことのほうが、実際の
   * 使い方に対する欠落だったためである。
   *
   * **外したのは入口の数であって、PRD 非ゴールそのものではない。** 非ゴールが禁じて
   * いるのは**利用者ごとにデータを分けること**で、許可を持つ全員が同じ1組の記憶・
   * 日誌・会話・実行 API を見る形は変わっていない（逐語は
   * `grep -Fn -- '利用者ごとにデータを分けない' docs/PRD.md`）。**だから「アカウント
   * ごとの記憶」「アカウントごとの日誌」を足したくなったら、そこが本当の境界である。**
   *
   * **原子性はいまも要る。** 消えたのは*他の行*との不変条件だけである。同じ account へ
   * 同時に grant が来たとき「読む → 検査 → 書く」に割ると、`grantedAt` / `grantedBy` が
   * 後から来た側で上書きされ、**日誌に残した「誰がいつ通したか」と食い違う**（日誌は
   * 追記なので、後から書かれた account の側だけが静かに変わる）。先に書いた側を
   * 勝たせ、後から来た側にはその結果を返す。
   */
  grantAccess(accountId: string, at: string, by: string): Promise<GrantOutcome>;

  /**
   * この account を「実行環境の持ち主として宣言された」状態にする、または解く（1操作）。
   *
   * **不変条件「宣言 ⟹ 許可済み」はここで強制する。** `declaredAt !== null` で
   * 呼ぶのに行が未許可（`grantedAt === null`）なら `not_granted` を返し、何も
   * 書かない。**「読む → 検査 → 書く」に割ってはいけない** — 割ると、検査と
   * 書き込みの間に許可が取り消された行へ宣言が乗る窓ができる（`.claude/skills/
   * auth-and-access/SKILL.md`「不変条件はストアの1操作に閉じること。ここは
   * 同じ失敗を3度踏んでいる場所である」）。
   *
   * **取り消し（`declaredAt === null`）は行が在れば常に通る。** 許可を取り消した
   * 後に宣言だけを取り消す（`AuthService.revoke` が両方を落とす）ケースがあるので、
   * 取り消し側に「許可済みであること」は要求しない。
   *
   * ドライバはそれぞれの器で強制する — fs は既存のロック区間の内側、pg は
   * `where granted_at is not null` を伴う条件付き UPDATE。
   */
  setAccountOwner(accountId: string, declaredAt: string | null): Promise<OwnerOutcome>;
}

/** 許可の付与の結果。 */
export type GrantOutcome = { status: 'granted'; account: AuthAccount } | { status: 'not_found' };

/** `revokeAccessToken` の結果（issue #1757）。3つを区別する——`AuthStore.revokeAccessToken` の doc。 */
export type RevokeAccessTokenOutcome =
  | { status: 'not_found' }
  | { status: 'already_revoked'; token: AccessTokenRecord }
  | { status: 'revoked'; token: AccessTokenRecord };

/** `setAccountOwner` の結果。 */
export type OwnerOutcome =
  { status: 'ok'; account: AuthAccount } | { status: 'not_found' } | { status: 'not_granted' };

/**
 * `createAccountWithIdentity` の結果（issue #1714）。
 *
 * **`created: true` の `account` は、渡した候補そのものとは限らない**
 * （issue #1751 / #1741）。別のアカウントが大小文字を区別せずに同じメールを
 * 既に持っていたら、ストアはメールを空にして保存し、その**保存した版**を
 * ここへ載せる。呼び手は渡した候補を使い回さず、必ずこの `account` を見ること。
 */
export type CreateAccountWithIdentityOutcome =
  { created: true; account: AuthAccount } | { created: false; existing: AuthIdentity };

// ---------------------------------------------------------------------------
// 乱数・ハッシュ
// ---------------------------------------------------------------------------

/** URL に載る乱数。既定 32 バイト（256 bit）。 */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * 16進文字列どうしの定数時間比較。
 *
 * 長さが違うと `timingSafeEqual` が投げるので、先に長さを見てから比較する
 * （長さの違いは秘密ではない）。
 */
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/** 発行するアクセストークンの見た目（ログに出たとき何か分かるように接頭辞を付ける）。 */
export const ACCESS_TOKEN_PREFIX = 'alt_';

export function issueAccessTokenValue(): string {
  return `${ACCESS_TOKEN_PREFIX}${randomToken(32)}`;
}

/** PKCE（S256）。公開クライアント相当なので必ず付ける。 */
export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = randomToken(32);
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

/** `state` は `<ログイン要求 id>.<nonce>`。id で引いて nonce を定数時間で突き合わせる。 */
export function encodeState(requestId: string, nonce: string): string {
  return `${requestId}.${nonce}`;
}

export function decodeState(state: string): { requestId: string; nonce: string } | null {
  const separator = state.indexOf('.');
  if (separator <= 0 || separator === state.length - 1) return null;
  return { requestId: state.slice(0, separator), nonce: state.slice(separator + 1) };
}

// ---------------------------------------------------------------------------
// 判定（ストアを触らない純粋関数 — テストしやすさのために切ってある）
// ---------------------------------------------------------------------------

export function isAccountGranted(account: AuthAccount): boolean {
  return account.grantedAt !== null;
}

/**
 * **実行環境の持ち主として宣言されたアカウントか。**（issue #1198。本来の形）
 *
 * `ownerDeclaredAt` は operator トークンだけが立てられる（`AuthStore.
 * setAccountOwner`）ので、真になるのは「ホストのファイルを読める者が明示的に
 * 宣言した」ときだけである。**旧 `isAccountGrantedByOperator`（`grantedBy ===
 * 'operator'` による近似。#1195 の PR #1199 が採った形）はここで置き換える** —
 * あちらは「端末から直に許可した」という別の事実からの推測で、宣言していない
 * 相手をここが見ることはない。
 *
 * **許可が外れていないことも見る。** `AuthStore.setAccountOwner` は未許可の行に
 * 宣言を立てさせないが、`AuthService.revoke` は許可の取り消しと同時に
 * `ownerDeclaredAt` も `null` に落とすため、実際には「宣言はあるが未許可」の
 * 行は生まれない。**それでもここで両方見るのは、その不変条件が崩れた日に
 * 資格の側が緩まないようにするためである** —— 守りは、守られている前提が
 * 壊れたときにこそ要る。
 */
export function isDeclaredOwner(account: AuthAccount): boolean {
  return isAccountGranted(account) && account.ownerDeclaredAt !== null;
}

/**
 * **判定できない期限は「使えない」に倒す（issue #1789）。**
 *
 * `expiresAt` が解釈できない文字列だと `Date.parse` は `NaN` を返し、
 * `NaN <= now` は `false` になる。以前はこの形で比べていたので、壊れた期限の
 * トークンが期限の検査を素通りして「使える」に倒れていた。スキーマ
 * （`isoDateTime`）は書き込みの時点で解釈できない値を拒むが、検査を迂回して
 * 保存された値（手で書き換えた保存先・スキーマの版のずれ）はここへ届きうる。
 * **資格の判定は、判定できないときに閉じる側へ倒す。** 比べる向きも
 * 「期限より前なら開く」にしてある——`NaN` との比較はどれも `false` なので、
 * この形なら書き方を間違えても閉じる側に落ちる（`isLoginRequestOpen` と同じ形）。
 */
export function isAccessTokenUsable(token: AccessTokenRecord, now: Date): boolean {
  if (token.revokedAt !== null) return false;
  if (token.expiresAt === null) return true;
  const expiresAt = Date.parse(token.expiresAt);
  if (Number.isNaN(expiresAt)) return false;
  return expiresAt > now.getTime();
}

export function isLoginRequestOpen(request: LoginRequest, now: Date): boolean {
  return Date.parse(request.expiresAt) > now.getTime();
}
