import {
  CREDENTIAL_NAME,
  ENV_FILE_OWNED_CREDENTIAL_NAMES,
  fingerprintOf,
  GITHUB_CREDENTIAL_NAMES,
  isWithheldCredentialName,
  POOL_OWNED_CREDENTIAL_NAMES,
  ROTATABLE_CREDENTIAL_KEYS,
  type CredentialEntry,
  type CredentialFingerprint,
} from './credentials.js';
import type {
  RunnerClient,
  RunnerCredentialFingerprint,
  RunnerRegistry,
} from './runner-protocol.js';
import type { StoredCredential, Stores } from './store.js';

/**
 * マネージャーへ降ろす環境変数を**置いて配る**までの1本道。
 *
 * ## なぜ「1本道」でなければならないか
 *
 * `ProfileService` とまったく同じ理由である。更新は2段（① 正本へ保存
 * ② 各 runner へ配布）で、直列化しないと**同時に2つ更新が入ったときに層ごとに
 * 違う値が残る**:
 *
 *     A が ① → B が ①② → A が ②   ⇒ 正本=B、runner=A
 *
 * どちらの呼び出しも成功を返すのに、これから起こすマネージャーは A の鍵で走り、
 * デーモンを再起動すると正本の B へ突然変わる。**鍵でそれが起きると、「どの鍵で
 * 失敗したのか」が誰にも分からなくなる**（3つとも「置けた」と答える）。
 *
 * runner が名乗り直したときの降ろし直し（`syncRunner`）も runner へ書く操作なので、
 * 同じ列へ入れる。
 *
 * ## 器（`credentials.ts` の `CredentialStore`）との分担
 *
 * | ここ（デーモン） | 器（runner） |
 * | --- | --- |
 * | 正本を持つ（記憶ストア。器を作り直しても残る） | 降ってきたものを名前ごとのファイルに置く |
 * | 誰が置けるかを決める（HTTP の資格） | 誰が読めるかを決める（0400・子の UID へ chown） |
 * | 名前を検査する（形・伏せる鍵・プールの持ち物） | 名前を検査する（形・伏せる鍵） |
 *
 * **検査が両側に在るのは重複ではない。** 器の側は「デーモン以外が繋いできても
 * 越えられない」ための壁で、こちら側は「早く落ちる」ためのものである（400 を
 * 返せる位置で落ちれば、人間は何が悪いのかを応答で読める）。
 */
export interface CredentialService {
  /**
   * いま正本に在る鍵の指紋。**値は出さない。**
   *
   * 値を返す口をここに作らないこと——正本を読み出せる口が在ると、`GET` の資格が
   * 「置く」のと同じ強さを要求することになり、指紋だけ見たい人（届いているかを
   * 確かめたい人）まで巻き込む。
   */
  fingerprints(): Promise<CredentialFingerprint[]>;
  /**
   * 置いて配る。**保存 → 配布を1つの区間として直列に行う。**
   *
   * 空文字の値は「その名前を外す」。**外す指示も配る** ——正本から消えた名前を
   * 配らないと、runner の器には古い鍵が残り続ける。
   */
  apply(entries: readonly CredentialEntry[]): Promise<ApplyCredentialsResult>;
  /**
   * 1台の runner へ、いま正本に在るものを降ろし直す。
   *
   * **runner は記憶ストアを読めない**ので、器が作り直されたときに降ろすのはこちら
   * の責任である（`ProfileService#syncRunner` と同じ位置・同じ理由）。
   *
   * **差があるものだけを降ろす。** 全部降ろし直すと、`CLAUDE_CODE_OAUTH_TOKEN`
   * の指紋が変わったときにセッションを畳む仕組み（`recycleForToken`）を、
   * 再接続のたびに無意味に叩きうる。
   *
   * 降ろすものが無ければ `null`。
   */
  syncRunner(runner: RunnerClient): Promise<RunnerCredentialFingerprint[] | null>;
  /**
   * いま覚えている正本の**同期の写し**。**値を含む**——正本そのものを
   * 配る経路なので、このデーモンのプロセスの外へは出さないこと。
   *
   * ## 何のためか（人間の決定 2026-09-12、「梯子を1本に統一する」）
   *
   * `Clone#childEnv()` は同期関数だが、正本（`stores.credentials`）の読み出しは
   * 非同期である。⟹ クローンが正本を`effective()`と同じ1本（`resolveCredentialRows`）
   * で解決するには、非同期の正本を同期で覗ける形が要る。ここがその窓である。
   *
   * ## 鮮度
   *
   * このサービスが正本を読む・書くたびに更新する——`apply()`（書いた直後の
   * 全行）・`fingerprints()`（読んだ全行）・`syncRunner()` 経由の `effective()`
   * （読んだ全行）。**加えて、構築直後に1回、能動的に読みに行く**
   * （`createCredentialService` 内）——最初の HTTP 呼び出しや `syncRunner()` を
   * 待たずに温める。
   *
   * ## まだ一度も読めていないとき
   *
   * 空配列。**これは退行ではない**——この口が無かった以前から、クローンは
   * 正本を1文字も読んでいなかった（`Clone#childEnv()` は器の env をそのまま
   * 持つだけだった）。空の写しで解決した結果は、その「以前の `Clone#childEnv()`」
   * とちょうど同じ集合になる（正本の上乗せが無いだけで、器の env の値は
   * そのまま届く）。**痩せるのは「正本にしか無い名前」だけで、それは
   * この変更より前から届いていなかった名前である。**
   */
  vaultSnapshot(): readonly StoredCredential[];
}

export interface CredentialServiceOptions {
  stores: Stores;
  /** 委譲先。無ければ配布はしない（保存はする）。 */
  runners?: RunnerRegistry;
  /**
   * 子プロセスへ伏せる環境変数の名前。**この名前は鍵として受け付けない。**
   *
   * 器の側（`CredentialStore`）と同じ拒否をここにも置く（`CredentialService` の
   * doc「検査が両側に在るのは重複ではない」）。**渡し忘れると検査が消える**ので、
   * 省略可能にしていない。
   */
  withheldEnvKeys: readonly string[];
  /**
   * **クローンの器（デーモンのプロセス）の環境変数。** 既定は `process.env`。
   *
   * ## なぜ読むのか（2026-09-11 の人間の決定）
   *
   * **runner は自分の env から鍵を拾わない器になった**（`apps/runner/src/index.ts` の
   * `seed: {}` と `runner.ts` の `#childEnv()`）。⟹ 器の `.env` / Shared Variables
   * に鍵を置いただけの構成では、**誰も配らないので鍵が消える。**
   *
   * だから**クローンの器の env を最後の土台として配る**（正本に無い名前だけ）。
   * 人間が `.env` に1行置くだけで従来どおり動き、しかも配るのは常にクローンである。
   *
   * **見るのは `ROTATABLE_CREDENTIAL_KEYS` だけ。** env を総なめにしない —— 何が鍵かを
   * 推測すると、鍵でないものを晒すか鍵を取りこぼす（`credentials.ts` の同じ doc）。
   * ⟹ 任意の名前を器の env に置く形は支えない。**それは正本へ置く**（この口の本題）。
   *
   * **⚠️ GitHub の名前（`GITHUB_CREDENTIAL_NAMES`）については、この土台の
   * ほうが正本より勝つ**（人間の決定 2026-09-12、Issue #865 の恒久策——
   * オーナーの仕様「クローンへ渡す環境変数と同じものをマネージャーへ渡す」）。
   * `resolveCredentialRows` が両方の主体（マネージャー側の `effective()` と
   * クローン側の `Clone#childEnv()`）で同じ解決を通すことで、**構造的に
   * ずれない**——以前は「正本にその名前の行が在れば `effective()` は正本の値を
   * 配るが、クローンはここ（この `env`）を直に読む」という2本の梯子が在り、
   * 正本の値とこの `env` の値が違うと2つの主体が別の鍵で走った（Issue #865 の
   * 実測: マネージャーは GitHub App のトークン、クローンは classic PAT）。
   * **GitHub 以外の名前（プールの名前・任意の名前）は従来どおり正本が勝つ。**
   * この食い違いの検出は `cloneEnvShadowedNames` に置いてある。
   */
  env?: NodeJS.ProcessEnv;
  /**
   * 正本のこの名前の行が、クローンの器の環境変数の値に優先順位で負けて
   * 配られていない（`cloneEnvShadowedNames` が名前を返した）ことを知らせる。
   * **渡すのは名前の配列だけ。値も指紋も渡さない**——ここから先へ値を運ぶ
   * 経路をひとつも作らない。
   *
   * 呼ぶ位置は `syncRunner()`（後述のdocを見ること）。**同じ食い違いを
   * 連続して知らせない**——直前に知らせた名前の集合と変わらなければ黙る
   * （`syncRunner` は runner が名乗り直すたびに叩かれるので、そのたびに
   * 出すと同じ1行で日誌が埋まり、意味のある行が埋もれる）。
   */
  onCloneEnvShadowed?: (names: readonly string[]) => void;
}

export interface ApplyCredentialsResult {
  /** 置き換えた後の正本の指紋。**値は出さない。** */
  fingerprints: CredentialFingerprint[];
  /** 各 runner への配布結果。 */
  runners: {
    runnerId: string;
    ok: boolean;
    error?: string;
    credentials?: RunnerCredentialFingerprint[];
  }[];
}

/**
 * 受け取った入力の形を検める。**落ちるなら、何も書かない前に落ちる。**
 *
 * 名前の重複もここで落とす——同じ名前を2行で渡されると、正本には後の行が入り、
 * 応答の指紋も後の行のものになる。つまり**前の行は黙って捨てられる**ので、
 * 「置いたはずの値が無い」を静かに作る。
 */
function assertEntries(
  entries: readonly CredentialEntry[],
  withheld: readonly string[],
  existingByName: ReadonlyMap<string, StoredCredential>,
): void {
  if (entries.length === 0) {
    throw new Error('鍵が1つも渡されていない（置くものが無い）');
  }
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!CREDENTIAL_NAME.test(entry.name)) {
      throw new Error(
        `鍵の名前として認められない: ${JSON.stringify(entry.name)}（英大文字・数字・_ のみ）`,
      );
    }
    if (isWithheldCredentialName(entry.name, withheld)) {
      throw new Error(
        `${entry.name} は子プロセスへ伏せる鍵なので、鍵として配れない` +
          '（伏せる仕組みを鍵の仕組みで越えさせない）',
      );
    }
    if (POOL_OWNED_CREDENTIAL_NAMES.includes(entry.name)) {
      throw new Error(
        `${entry.name} の正本は認証トークンのプールである（alteroid token add / PUT /tokens）。` +
          'ここへ置くと撒き手が2つになり、回した鍵をこちらが名乗り直しで上書きして' +
          'ローテーションが黙って効かなくなる',
      );
    }
    /**
     * **置くのは拒む。外す（空文字）のは通す**（2026-09-15 に後者を分けた）。
     *
     * `POOL_OWNED_CREDENTIAL_NAMES`（直上）は空文字も拒むが、**あちらには別の
     * 消し口が在る**（`alteroid token remove` / `PUT /tokens`）ので、ここで拒んでも
     * 消せなくならない。こちらには**消し口が1つも無い** —— `PUT /credentials` が
     * 名前→値の袋を触る唯一の口なので、空文字まで拒むと、**一覧へ名前を足す前に
     * 置かれた行を人間が二度と消せなくなる**（画面には残り、`resolveCredentialRows`
     * は配らず、消すこともできない行になる）。
     *
     * **⟹ 対称に見えて、消し口の有無が違う。** 空文字を通すのは「置ける」ことに
     * はならない —— 空文字は行そのものを消す操作であり、正本が2つになる側へは
     * 1文字も倒れない。
     */
    if (ENV_FILE_OWNED_CREDENTIAL_NAMES.includes(entry.name) && entry.value.length > 0) {
      throw new Error(
        `${entry.name} の正本は器の生の環境変数（.env / Railway の Service 変数）である。` +
          'ここへ置いても誰にも配られない（正本を2つにしないため、読み出しでも落とす）' +
          '（直すのは railway/setup.sh が置く側、または器の .env）',
      );
    }
    if (seen.has(entry.name)) {
      throw new Error(`${entry.name} が2回渡されている（どちらが残るかを決めない）`);
    }
    seen.add(entry.name);

    /**
     * {@link StoredCredential.secret} は作成時に決まり、後から変えられない。空文字（＝外す）は行そのものが消えるので
     * 検査しない —— 外して同じ名前を作り直すのは「新規作成」であり、不変の対象ではない。
     */
    if (entry.value.length > 0 && entry.secret !== undefined) {
      const existing = existingByName.get(entry.name);
      if (existing !== undefined) {
        const existingSecret = existing.secret ?? true;
        if (entry.secret !== existingSecret) {
          throw new Error(
            `${entry.name} の secret（シークレット可否）は作成時に決まり、後から変更できない` +
              `（いまは ${existingSecret ? 'シークレット' : '非シークレット'}）。` +
              '値を変えたいだけなら secret を省略すること',
          );
        }
      }
    }
  }
}

/**
 * 正本のこの名前の行が、クローンの器の env の値に優先順位で負けていて
 * 配られていない名前を返す。**名前だけを返す。値も指紋も返さない**
 * （`fingerprintOf` で比べた結果しか外へ出さない）。
 *
 * ## 検出条件（これがすべて）
 *
 * 1. GitHub の名前である（`GITHUB_CREDENTIAL_NAMES`）
 * 2. 正本（`stores.credentials`）にその名前の行が在る
 * 3. クローンの器の env（`CredentialServiceOptions.env`）にも、その名前の
 *    空でない値が在る
 * 4. 両者の指紋（`fingerprintOf`）が違う
 *
 * この4つが揃ったときだけ立つ。実測（Issue #865）: マネージャーは GitHub App
 * の user-to-server トークン、クローンは classic PAT だった。
 *
 * **GitHub 以外の名前・正本にしか無い・器の env にしか無いときは立たない。**
 * GitHub 以外は `resolveCredentialRows` が正本を配るので両者は揃う。
 * 正本にしか無ければ両者とも正本の値になる。器の env にしか無ければ
 * `resolveCredentialRows` が env から埋め、こちらも揃う。**「GitHub の名前で
 * 両方に在って中身が違う」ときだけが揃わない**——ここが唯一の食い違いである。
 *
 * **`POOL_OWNED_CREDENTIAL_NAMES` は最初から見ない。** `GITHUB_CREDENTIAL_NAMES`
 * に含まれないので自動的に外れるが、比べる意味そのものも無い——比べるべき
 * 「クローンが実際に使う値」はそもそも正本ではなくプールの撒き手
 * （`token-spread.ts`）が撒く値である。正本と器の env をここで比べても、
 * クローンが本当に使っている値とは無関係な比較になる（＝誤検出を作るだけ）。
 *
 * **この関数は検出するだけで、どちらの値を配るかには手を出さない**
 * （それは `resolveCredentialRows` の役目）。GitHub の名前について「正本が
 * 勝つ」だった以前の仕様は 2026-09-12 に反転しており、この旗が立つのは
 * いまや「クローンの器の env が勝っていて、正本のその行が配られていない」
 * ことを意味する（`CredentialFingerprint.shadowsCloneEnv` の doc）。
 */
function cloneEnvShadowedNames(
  authoritative: readonly StoredCredential[],
  env: NodeJS.ProcessEnv,
): string[] {
  const vaultValue = new Map(authoritative.map((row) => [row.name, row.value]));
  return GITHUB_CREDENTIAL_NAMES.filter((name) => {
    const vault = vaultValue.get(name);
    if (vault === undefined) return false; // 正本に無い(食い違いようがない)
    const clone = env[name];
    if (clone === undefined || clone.length === 0) return false; // 器の env に無い
    return fingerprintOf(vault) !== fingerprintOf(clone);
  });
}

/**
 * `resolveCredentialRows` が器の env を出所とする行に付ける `updatedAt`。
 * 器のファイルには更新時刻が無いので、正本の行（`StoredCredential.updatedAt`
 * が実際のタイムスタンプ）と区別できる固定文字列を置く。
 */
const CLONE_ENV_UPDATED_AT = '(クローンの器の環境変数)';

/**
 * 正本の行とクローンの器の env から、**配る名前→値を1本で決める。**
 *
 * マネージャー（`effective()`）とクローン（`Clone#childEnv()`）の両方が
 * この同じ関数を同じ入力（正本の行・クローンの器の env）で呼ぶことで、
 * **梯子を1本に統一する**（人間の決定 2026-09-12、Issue #865 の恒久策）。
 * 優先順位を両側で個別に実装して揃える形は、揃え忘れをまた作りうる——
 * 解決そのものを1本にすれば、構造的にずれ得ない。
 *
 * ## 優先順位
 *
 * - **GitHub の名前（`GITHUB_CREDENTIAL_NAMES`）だけ**、クローンの器の env に
 *   空でない値が在れば、そちらを正本より優先する。**正本にその名前の行が
 *   在っても配らない。** オーナーの仕様「クローンへ渡す環境変数と同じものを
 *   マネージャーへ渡す」——クローンが基準である。
 * - **それ以外は従来どおり正本が勝つ**——`CLAUDE_CODE_OAUTH_TOKEN` を含む
 *   プールの名前（`POOL_OWNED_CREDENTIAL_NAMES`）と、`ROTATABLE_CREDENTIAL_KEYS`
 *   に無い任意の名前（PR #825「任意の名前→任意の値」）のどちらも、正本に
 *   行が在ればそれを配る。器の env の値は無視する。
 * - **正本に行が無い非プールの回せる名前だけ、器の env を最後の土台として
 *   埋める。** これは今回の優先順位の変更とは別の、既存の仕組みである
 *   （`CredentialServiceOptions.env` の doc）——`GITHUB_CREDENTIAL_NAMES` に
 *   限らず `ROTATABLE_CREDENTIAL_KEYS` 全体に効く。
 *
 * **`GITHUB_CREDENTIAL_NAMES` は明示的な列挙であって、`ROTATABLE_CREDENTIAL_KEYS`
 * からプールを引いた集合の別名ではない。** 現状は値として一致するが、将来
 * `ROTATABLE_CREDENTIAL_KEYS` に GitHub 以外の非プールの名前が増えても、
 * ここで使っている優先順位はその名前へ自動では広がらない
 * （`credentials.ts` の `GITHUB_CREDENTIAL_NAMES` の doc）。
 *
 * ## 正本が器の生の環境変数である名前は、行が在っても配らない（2026-09-15）
 *
 * `ENV_FILE_OWNED_CREDENTIAL_NAMES` の名前は `assertEntries` が書き込みを拒むが、
 * **拒むようにする前に置かれた行は袋に残り続ける**（`credentials.ts` のその doc）。
 * 書き込みだけを塞ぐと、その行は以後も配られ——`applyAppScopedEnvVars` 経由で
 * デーモンの `process.env` を上書きし続ける。⟹ 配る側のここでも落とす。
 *
 * **`target` で分けない。** クローンにもマネージャーにも配らない——この一覧の
 * 名前を読むのは器自身のプロセス（デーモン / runner）であって、SDK 子プロセス
 * では誰も読まないからである（`credentials.ts` の群2の表）。
 */
export function resolveCredentialRows(
  authoritative: readonly StoredCredential[],
  cloneEnv: NodeJS.ProcessEnv,
  target: 'clone' | 'manager',
): StoredCredential[] {
  // **scope でまず絞る**（2026-09-14。人間の明示的な指示で
  // `packages/storage-pg/src/schema.ts` の「行ごとに層への効かせ分けを持たせない」
  // 方針を上書きしている——理由とその判断は {@link StoredCredential.scope} の doc）。
  // `scope` が無い行（この列より前に作られた行）は `'all'` と同じに扱う。
  //
  // **正本が器の生の環境変数である名前は、ここで落とす**（直上の doc）。scope の
  // 前後どちらでもよいが、**落とす理由が scope とは無関係**（層への効かせ分けでは
  // なく「そもそも袋の持ち物ではない」）なので、条件を分けて書いてある。
  const scoped = authoritative.filter(
    (row) =>
      !ENV_FILE_OWNED_CREDENTIAL_NAMES.includes(row.name) && scopeAppliesTo(row.scope, target),
  );
  const held = new Set(scoped.map((row) => row.name));

  const cloneEnvWins = (name: string): boolean => {
    if (!GITHUB_CREDENTIAL_NAMES.includes(name)) return false;
    const value = cloneEnv[name];
    return value !== undefined && value.length > 0;
  };

  const fromVault = scoped.map((row) =>
    cloneEnvWins(row.name)
      ? { name: row.name, value: cloneEnv[row.name]!, updatedAt: CLONE_ENV_UPDATED_AT }
      : row,
  );

  const fromEnvOnly = ROTATABLE_CREDENTIAL_KEYS.filter(
    (name) => !held.has(name) && !POOL_OWNED_CREDENTIAL_NAMES.includes(name),
  ).flatMap((name) => {
    const value = cloneEnv[name];
    // 空文字は「置かれていない」と同じに扱う（空の鍵は無い鍵より悪い）。
    if (value === undefined || value.length === 0) return [];
    return [{ name, value, updatedAt: CLONE_ENV_UPDATED_AT }];
  });

  return [...fromVault, ...fromEnvOnly];
}

/**
 * その行が `target`（`'clone'` = クローン自身の SDK 子プロセス env / `'manager'` =
 * runner へ配布する分）に届くべきか。**`scope` 未設定（`undefined`）は `'all'` と同じ**
 * ——この列が無かった頃に作られた行を「届かない」側へ倒さない。
 */
function scopeAppliesTo(scope: StoredCredential['scope'], target: 'clone' | 'manager'): boolean {
  const normalized = scope ?? 'all';
  if (normalized === 'all') return true;
  return normalized === 'app' ? target === 'clone' : target === 'manager';
}

/**
 * 1行を外向けの {@link CredentialFingerprint} へ写す。**`fingerprints()` と
 * `fingerprintsOf()` の両方がここを通る**——scope/secret/value の出し方を
 * 2箇所で書くと、片方だけ直し忘れる形になる。
 */
function fingerprintOfRow(row: StoredCredential, shadowsCloneEnv: boolean): CredentialFingerprint {
  const secret = row.secret ?? true;
  return {
    name: row.name,
    sha256: fingerprintOf(row.value),
    updatedAt: row.updatedAt,
    scope: row.scope ?? 'all',
    secret,
    // **`false` を敷き詰めない**（`CredentialFingerprint.shadowsCloneEnv` の doc と同じ形）。
    ...(shadowsCloneEnv ? { shadowsCloneEnv: true as const } : {}),
    // **secret === false の行だけ値を載せる。**
    ...(secret ? {} : { value: row.value }),
  };
}

/**
 * リクエストの1行に、省略された `scope`/`secret` を補って書き込み用の
 * {@link CredentialEntry} を作る。**「外す」行（空値）はそのまま通す**——
 * 消える行に scope/secret の意味は無い。
 */
function resolveEntryForWrite(
  entry: CredentialEntry,
  existingByName: ReadonlyMap<string, StoredCredential>,
): CredentialEntry {
  if (entry.value.length === 0) return entry;
  const existing = existingByName.get(entry.name);
  return {
    name: entry.name,
    value: entry.value,
    scope: entry.scope ?? existing?.scope ?? 'all',
    secret: entry.secret ?? existing?.secret ?? true,
  };
}

export function createCredentialService(options: CredentialServiceOptions): CredentialService {
  const { stores, runners, withheldEnvKeys, onCloneEnvShadowed } = options;
  const env = options.env ?? process.env;

  /**
   * 直前に知らせた食い違いの名前（ソート済み・カンマ結合）。**同じ集合を
   * 連続して知らせないための記憶**（`onCloneEnvShadowed` の doc）。`undefined`
   * は「まだ一度も測っていない」で、空集合とは区別する——区別しないと、
   * 「一度も食い違ったことが無い」状態と「測ったら食い違いが無かった」状態が
   * 同じ値になり、最初の食い違いが「変わっていない」と誤認されて出なくなる。
   */
  let lastShadowSignature: string | undefined;

  /**
   * `syncRunner()` の副作用として食い違いを知らせる。**ここでしか呼ばない**
   * ——`effective()` の呼び手は `syncRunner()` だけなので、行を読み直さずに
   * 済む場所がここしか無い（`apply()` は `effective()` を経由しない）。
   */
  function reportCloneEnvShadow(authoritative: readonly StoredCredential[]): void {
    if (onCloneEnvShadowed === undefined) return;
    const shadowed = cloneEnvShadowedNames(authoritative, env);
    const signature = [...shadowed].sort().join(',');
    if (signature === lastShadowSignature) return;
    lastShadowSignature = signature;
    if (shadowed.length > 0) onCloneEnvShadowed(shadowed);
  }

  /**
   * `vaultSnapshot()` の裏の可変値。**ここでしか代入しない**
   * （`noteVaultSnapshot` を経由する）。鮮度の契約は `CredentialService.vaultSnapshot`
   * の doc に書いてある——ここではその契約を成り立たせる配線だけを行う。
   */
  let cachedVaultRows: readonly StoredCredential[] = [];
  function noteVaultSnapshot(rows: readonly StoredCredential[]): void {
    cachedVaultRows = rows;
  }
  // **構築直後に1回、能動的に温める。** 呼び手（`apply` / `fingerprints` /
  // `syncRunner`）を待たずに読みに行くことで、最初の HTTP 呼び出しより前に
  // クローンが正本を覗ける窓を作る。**失敗してもここは止めない**——空のまま
  // 残っても `vaultSnapshot()` の doc が言うとおり退行ではなく、次にどれかが
  // 呼ばれれば追いつく。
  void stores.credentials
    .list()
    .then(noteVaultSnapshot)
    .catch(() => undefined);

  /**
   * 直列化の実体（`ProfileService` と同じ形）。**次の更新は前の更新の全段が
   * 終わってから始まる。**
   */
  let tail: Promise<unknown> = Promise.resolve();
  function serial<T>(work: () => Promise<T>): Promise<T> {
    const next = tail.then(work, work);
    tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  return {
    vaultSnapshot: () => cachedVaultRows,

    fingerprints: async () => {
      const rows = await stores.credentials.list();
      noteVaultSnapshot(rows);
      // **読むだけの口でも旗を立てる。** `GET /credentials` は人間が能動的に
      // 見に行く経路であり、`syncRunner` の側（runner が名乗るたびの契機）と
      // 独立して「いま食い違っているか」を確かめられる必要がある——だから
      // ここは `lastShadowSignature` を経由せず、呼ばれるたびに測り直す。
      const shadowed = new Set(cloneEnvShadowedNames(rows, env));
      return rows.map((row) => fingerprintOfRow(row, shadowed.has(row.name)));
    },

    apply: (entries: readonly CredentialEntry[]) =>
      serial(async () => {
        const existing = await stores.credentials.list();
        const existingByName = new Map(existing.map((row) => [row.name, row]));
        assertEntries(entries, withheldEnvKeys, existingByName);

        /**
         * **scope・secret を解決してから書く。** 省略された欄は「既存行の値を
         * 引き継ぐ」「新規行なら既定（`all` / `true`）」のどちらか——ここで
         * 解決しておけば、器（fs/pg）は渡された値をそのまま持つだけでよい。
         */
        const resolved = entries.map((entry) => resolveEntryForWrite(entry, existingByName));

        const rows = await stores.credentials.put(resolved);
        noteVaultSnapshot(rows);

        /**
         * **外した名前も配る。** 正本から消えた行は `rows` に無いので、そのまま
         * 配ると runner の器には古い鍵が残り続ける（「外したのに効いている」）。
         *
         * **正本に在る名前は正本の値で配る**（入力の値ではなく）。同じものになる
         * はずだが、正本を経由させておけば、器が正規化や検査で値を変えた場合にも
         * 「配った値＝正本の値」が崩れない。
         *
         * **scope が `manager` に届かない行（`app` 専用）は runner へ渡さない。**
         * 削除の合図（`removed`）は scope を問わず送る——無かった名前を消しても
         * 無害な no-op である。
         */
        const removed = entries
          .filter((entry) => entry.value.length === 0)
          .map((entry) => ({ name: entry.name, value: '' }));
        const upserted = rows.filter((row) => scopeAppliesTo(row.scope, 'manager'));
        const payload = [...upserted.map(({ name, value }) => ({ name, value })), ...removed];

        return { fingerprints: fingerprintsOf(rows), runners: await pushAll(payload) };
      }),

    syncRunner: (runner: RunnerClient) =>
      serial(async () => {
        /**
         * **降ろす対象は「正本 ∪ クローンの器の env」である**（2026-09-11）。
         *
         * 以前はここが「正本が空なら1文字も配らない」だった —— runner が自分の env
         * から種を拾う器だったので、空を配ると**その種を消して回る**形になるためで
         * ある。**その前提はもう無い**（runner は拾わない）。⟹ いまは逆で、
         * **配らなければ鍵はどこにも無い。**
         */
        const rows = await effective();
        // 配るものが無い（正本も器の env も空）。**「全部外せ」とは言わない** ——
        // 外す指示は `apply` が明示的に送る。
        if (rows.length === 0) return null;

        /**
         * **差があるものだけを降ろす。**
         *
         * 指紋が取れなかったときは「差がある」に倒す（降ろす）。取れないのは
         * 器が答えられない状態なので、降ろさないより降ろすほうが安全側である
         * ——同じ値を書き直すのは無害で、降ろし損なうと鍵が無いまま走る。
         */
        const current = await runner.credentials().catch(() => undefined);
        const held = new Map((current ?? []).map((entry) => [entry.name, entry.sha256]));
        const behind = rows.filter((row) => held.get(row.name) !== fingerprintOf(row.value));
        if (behind.length === 0) return null;

        return runner.setCredentials(behind.map(({ name, value }) => ({ name, value })));
      }),
  };

  /**
   * 降ろす対象を決める。**解決そのものは `resolveCredentialRows` を1本だけ
   * 通す**（`Clone#childEnv()` と同じ関数。2026-09-12「梯子を1本に統一する」）。
   *
   * **副作用として、ここでクローンとの食い違いも知らせ、写しも更新する。**
   * `syncRunner()` の呼び手はここだけで、正本の行はここで一度だけ読む——
   * `reportCloneEnvShadow` / `noteVaultSnapshot` のために
   * `stores.credentials.list()` を二重に呼び直さずに済む場所が、ここ以外に
   * 無い。
   */
  async function effective(): Promise<StoredCredential[]> {
    const rows = await stores.credentials.list();
    reportCloneEnvShadow(rows);
    noteVaultSnapshot(rows);
    return resolveCredentialRows(rows, env, 'manager');
  }

  function fingerprintsOf(rows: readonly StoredCredential[]): CredentialFingerprint[] {
    return rows.map((row) => fingerprintOfRow(row, false));
  }

  async function pushAll(
    payload: readonly CredentialEntry[],
  ): Promise<ApplyCredentialsResult['runners']> {
    if (runners === undefined) return [];
    return Promise.all(
      (await runners.list()).map(async (runner) => {
        try {
          return {
            runnerId: runner.runnerId,
            ok: true as const,
            credentials: await runner.setCredentials([...payload]),
          };
        } catch (error) {
          return { runnerId: runner.runnerId, ok: false as const, error: String(error) };
        }
      }),
    );
  }
}
