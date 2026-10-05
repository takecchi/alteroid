import { reasonOf } from './dropped-record.js';
import {
  CREDENTIAL_NAME,
  CREDENTIAL_NAME_MAX_LENGTH,
  ENV_FILE_OWNED_CREDENTIAL_NAMES,
  fingerprintOf,
  isWithheldCredentialName,
  POOL_OWNED_CREDENTIAL_NAMES,
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
   * **`apply()` の即時の配布の結果を知らせる（Issue #1699 の隣、#1717）。** 返り値は購読を外す関数。
   *
   * `apply()` は保存の直後に、繋がっている runner へその場で直接配る
   * （`pushAll`）。この経路は `ManagerPool` の押し込みの帳面（`#pushHealth`）と
   * 挑み直し（`#schedulePushRetry`）を通らなかったので、一時的な障害で配り
   * 損ねても `runner_list` は前の「ok」のままで、挑み直しも予約されなかった
   * （`McpServerService` / `ProfileService` は #1704 で同じ形の口を足している。
   * `CredentialService` だけ足し忘れていたのが #1717）。`ManagerPool` がここを
   * 購読し、同じ帳面に積む——約束を1つにする。
   *
   * **任意の口である。** 偽物（テスト）は持たなくてよい。
   */
  onPushed?(listener: (results: ApplyCredentialsResult['runners']) => void): () => void;
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
   * 空配列。**正本に無い名前は誰にも配らない**（`resolveCredentialRows`）ので、
   * 空の写しで解決した結果は「正本に何も無い」と同じ集合になる。起動直後の
   * ごく短い窓だけ、正本にしか無い名前が届かない（次に写しが温まれば追いつく）。
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
   * 正本の更新（`apply`）が成功し、**クローンから見える解決結果**
   * （`resolveCredentialRows(rows, 'clone')` の名前→指紋）が変わったときに呼ぶ
   * （2026-10-06 のオーナー決定「環境変数を即時反映にしてほしい」）。
   *
   * 呼び手（デーモン）はここでクローンのセッションをターンの境界で畳んで
   * `resume` で開き直させる（`Clone#recycleSessionForToken`）。SDK 子プロセスの
   * env は起動時に凍るので、これが無いと更新は「次にセッションが作り直される
   * まで」クローンに届かない。**渡すのは名前だけで、値も指紋も渡さない。**
   * 削除（空値）も変更である。購読者の例外は応答を落とさない。
   */
  onApplied?: (changedNames: readonly string[]) => void;
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
 * `apply()` が**入力の形を検めて断った**ときに投げる（issue #2415）。
 *
 * **文言では見分けないこと。** 呼び出し側（`PUT /credentials` の `app.ts`）は
 * これを `instanceof` で見分け、`message`（人が入力を直すための文。鍵の名前と
 * 理由だけで、**値は1文字も載せない**）を応答へ返す。これ以外の例外（ストアの
 * 書き込みの失敗・配布の失敗など）は `message` に値が載りうる（drizzle は
 * `Failed query: … params: <値>` を添える）ので、応答にも日誌にも `name` しか
 * 載せない。⟹ **この型を投げる文には、値を載せないこと。**
 */
export class CredentialEntryRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CredentialEntryRejectedError';
  }
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
    throw new CredentialEntryRejectedError('鍵が1つも渡されていない（置くものが無い）');
  }
  const seen = new Set<string>();
  for (const entry of entries) {
    /**
     * **runner の受け口（`runnerCredentialSchema.name`）と同じ上限をここでも
     * 課す。** ここで拒まずに `stores.credentials.put()` まで通してしまうと、
     * 正本には書けたのに runner の wire schema がその上限で必ず弾く行が生まれる
     * ——`apply()` 自体は成功を返し、`pushAll` は runner ごとの失敗を
     * `{ ok: false }` として飲み込むだけなので、正本と runner が永久に食い違って
     * いることに誰も気づけない（#1790）。**長さだけを言い、名前そのものは
     * メッセージに含めない**——上限超えの名前は任意の長さになりうるので、
     * エラーメッセージ自身が際限なく伸びるのを避ける。
     *
     * **拒むのは置く操作（空でない値）だけ。外す（空文字）のは通す**（#2445）。
     * vault の行の形には長さの上限が無く（`credentials.ts` / pg）、#1790 より前に
     * 保存された上限超えの名前の行が残りうる。消し口は `PUT /credentials` の空文字
     * だけなので、ここで空文字まで拒むと、その行を二度と消せなくなる
     * （直下の `ENV_FILE_OWNED_CREDENTIAL_NAMES` の検査と同じ理由）。
     */
    if (entry.value.length > 0 && entry.name.length > CREDENTIAL_NAME_MAX_LENGTH) {
      throw new CredentialEntryRejectedError(
        `鍵の名前が長すぎる（${entry.name.length} 文字。上限は ${CREDENTIAL_NAME_MAX_LENGTH} ` +
          '文字——runner の受け口と同じ上限）',
      );
    }
    if (!CREDENTIAL_NAME.test(entry.name)) {
      throw new CredentialEntryRejectedError(
        `鍵の名前として認められない: ${JSON.stringify(entry.name)}（英大文字・数字・_ のみ）`,
      );
    }
    if (isWithheldCredentialName(entry.name, withheld)) {
      throw new CredentialEntryRejectedError(
        `${entry.name} は子プロセスへ伏せる鍵なので、鍵として配れない` +
          '（伏せる仕組みを鍵の仕組みで越えさせない）',
      );
    }
    if (POOL_OWNED_CREDENTIAL_NAMES.includes(entry.name)) {
      throw new CredentialEntryRejectedError(
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
      throw new CredentialEntryRejectedError(
        `${entry.name} の正本は器の生の環境変数（.env / Railway の Service 変数）である。` +
          'ここへ置いても誰にも配られない（正本を2つにしないため、読み出しでも落とす）' +
          '（直すのは railway/setup.sh が置く側、または器の .env）',
      );
    }
    if (seen.has(entry.name)) {
      throw new CredentialEntryRejectedError(
        `${entry.name} が2回渡されている（どちらが残るかを決めない）`,
      );
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
          throw new CredentialEntryRejectedError(
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
 * 正本の行から、**配る名前→値を1本で決める。**
 *
 * マネージャー（`effective()`）とクローン（`Clone#childEnv()`）の両方が
 * この同じ関数を同じ入力（正本の行）で呼ぶことで、**梯子を1本に統一する**
 * （人間の決定 2026-09-12、Issue #865 の恒久策）。
 *
 * ## 出所は正本だけである（2026-10-06 のオーナー決定）
 *
 * **GitHub の名前も、他の普通の名前と同じ扱いにした。** 以前は
 * `GITHUB_CREDENTIAL_NAMES`（`GH_TOKEN` / `GITHUB_TOKEN`）だけ、クローンの器の
 * env が正本に勝ち、**正本に行が無い回せる名前（`GH_TOKEN` / `GITHUB_TOKEN` /
 * `CODEX_API_KEY`）は器の env を最後の土台として埋めていた。** どちらも撤去した。
 * 理由は、その「器の env」が実は**起動時に `applyAppScopedEnvVars` が正本から
 * `process.env` へ書き写した値**だったこと——正本を更新しても古い値が勝ち、
 * 正本から消しても書き写された値が配られ続けた（実測 2026-10-05）。
 *
 * ⟹ **正本に無い名前は、誰にも配らない。** 既存の器（Railway の変数にだけ
 * `GH_TOKEN` を置いている構成）を黙って壊さないため、起動時に1度だけ正本へ移す
 * （`env-vars-boot.ts` の `migrateEnvBaseCredentialsOnce`）。
 *
 * ## 正本が器の生の環境変数である名前は、行が在っても配らない（2026-09-15）
 *
 * `ENV_FILE_OWNED_CREDENTIAL_NAMES` の名前は `assertEntries` が書き込みを拒むが、
 * **拒むようにする前に置かれた行は袋に残り続ける**（`credentials.ts` のその doc）。
 * 書き込みだけを塞ぐと、その行は以後も配られ——`applyAppScopedEnvVars` 経由で
 * デーモンの `process.env` を上書きし続ける。⟹ 配る側のここでも落とす。
 *
 * **`target` で分けない。** クローンにもマネージャーにも配らない——この一覧の
 * 名前を読むのは器自身のプロセス（デーモン / runner）であって、SDK 子プロセスで
 * は誰も読まないからである（`credentials.ts` の群2の表）。
 */
export function resolveCredentialRows(
  authoritative: readonly StoredCredential[],
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
  //
  // **名前が上限（`CREDENTIAL_NAME_MAX_LENGTH`）を超える行も落とす**（#2445）。#1790 より
  // 前に保存された行が残りうるが、runner の受け口（`runnerSetCredentialsCommandSchema`）は
  // 1行でも上限超えがあると配列全体を 400 で弾き、ほかの鍵の配布まで止まる。
  // 落としたことの通知は呼び手の役目（`overlongCredentialNames`）。
  return authoritative.filter(
    (row) =>
      !ENV_FILE_OWNED_CREDENTIAL_NAMES.includes(row.name) &&
      row.name.length <= CREDENTIAL_NAME_MAX_LENGTH &&
      scopeAppliesTo(row.scope, target),
  );
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
function fingerprintOfRow(row: StoredCredential): CredentialFingerprint {
  const secret = row.secret ?? true;
  return {
    name: row.name,
    sha256: fingerprintOf(row.value),
    updatedAt: row.updatedAt,
    scope: row.scope ?? 'all',
    secret,
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

/**
 * 更新の前後で、**クローンから見える解決結果**（`resolveCredentialRows(_, 'clone')`）の
 * 名前→指紋が変わった名前。**増えた・値が変わった・消えた（削除）のどれも変更である**
 * （`apply` の `onApplied` の doc）。値は返さない。
 */
function changedCloneNames(
  before: readonly StoredCredential[],
  after: readonly StoredCredential[],
): string[] {
  const view = (rows: readonly StoredCredential[]): Map<string, string> =>
    new Map(resolveCredentialRows(rows, 'clone').map((row) => [row.name, fingerprintOf(row.value)]));
  const was = view(before);
  const now = view(after);
  const names = new Set([...was.keys(), ...now.keys()]);
  return [...names].filter((name) => was.get(name) !== now.get(name)).sort();
}

/** 名前が上限を超えていて、配らずに落とす行の名前（{@link resolveCredentialRows}）。 */
export function overlongCredentialNames(rows: readonly StoredCredential[]): string[] {
  return rows.map((row) => row.name).filter((name) => name.length > CREDENTIAL_NAME_MAX_LENGTH);
}

export function createCredentialService(options: CredentialServiceOptions): CredentialService {
  const { stores, runners, withheldEnvKeys, onApplied } = options;

  /**
   * **配らずに落とした上限超えの名前の行を、黙らせない**（#2445。`env-vars-boot.ts` の
   * 「配らなかった行を黙らせない」と同じく stderr。新しい口は作らない）。同じ集合は
   * 続けて出さない。**名前は頭と長さだけ出す**（任意の長さになりうる。値は出さない）。
   */
  let lastOverlongSignature = '';
  function reportOverlong(rows: readonly StoredCredential[]): void {
    const names = overlongCredentialNames(rows);
    const signature = names.join('\n');
    if (signature === lastOverlongSignature) return;
    lastOverlongSignature = signature;
    if (names.length === 0) return;
    process.stderr.write(
      `alteroidd: 名前が ${CREDENTIAL_NAME_MAX_LENGTH} 文字を超える鍵の行が正本に残っており、` +
        `**配っていません**（runner の受け口が配列ごと弾くため）。` +
        `消すには PUT /credentials に { name, value: "" } を送る: ` +
        `${names.map((name) => `${name.slice(0, 32)}…（${name.length} 文字）`).join(', ')}\n`,
    );
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

  const pushListeners = new Set<(results: ApplyCredentialsResult['runners']) => void>();

  return {
    vaultSnapshot: () => cachedVaultRows,

    fingerprints: async () => {
      const rows = await stores.credentials.list();
      noteVaultSnapshot(rows);
      return rows.map((row) => fingerprintOfRow(row));
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
        const changedForClone = changedCloneNames(existing, rows);

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
          // 上限超えの名前は runner の受け口が配列ごと弾くので、外す合図にも載せない（#2445）。
          .filter(
            (entry) => entry.value.length === 0 && entry.name.length <= CREDENTIAL_NAME_MAX_LENGTH,
          )
          .map((entry) => ({ name: entry.name, value: '' }));
        reportOverlong(rows);
        const upserted = rows.filter(
          (row) =>
            row.name.length <= CREDENTIAL_NAME_MAX_LENGTH && scopeAppliesTo(row.scope, 'manager'),
        );
        const payload = [...upserted.map(({ name, value }) => ({ name, value })), ...removed];

        const pushed = await pushAll(payload);
        // 購読者（`ManagerPool`）の例外で、人間への応答を落とさない
        // （`mcp-server-service.ts` の同じ形と同じ理由）。
        for (const listener of pushListeners) {
          try {
            listener(pushed);
          } catch {
            // 帳面に積めなかっただけで、配布の結果そのものは下で返す。
          }
        }

        // **配布が失敗しても、正本は書けているのでクローンへは知らせる**（クローンの
        // `#childEnv()` は正本の写しを直に読む。runner への配布の成否とは独立）。
        // 購読者の例外で応答を落とさない（上の `pushListeners` と同じ理由）。
        if (changedForClone.length > 0) {
          try {
            onApplied?.(changedForClone);
          } catch {
            // 畳み直しの印を立てられなかっただけで、正本の更新そのものは成功している。
          }
        }

        return { fingerprints: fingerprintsOf(rows), runners: pushed };
      }),

    onPushed: (listener) => {
      pushListeners.add(listener);
      return () => pushListeners.delete(listener);
    },

    syncRunner: (runner: RunnerClient) =>
      serial(async () => {
        /**
         * **降ろす対象は正本だけである**（2026-10-06。以前は「正本 ∪ クローンの器の
         * env」だったが、器の env を土台にする経路は撤去した）。
         *
         * 以前はここが「正本が空なら1文字も配らない」だった —— runner が自分の env
         * から種を拾う器だったので、空を配ると**その種を消して回る**形になるためで
         * ある。**その前提はもう無い**（runner は拾わない）。⟹ いまは逆で、
         * **配らなければ鍵はどこにも無い。**
         */
        const rows = await effective();
        // 配るものが無い（正本が空）。**「全部外せ」とは言わない** ——
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
   * **副作用として、ここで写しも更新する。** `syncRunner()` の呼び手はここだけで、
   * 正本の行はここで一度だけ読む——`noteVaultSnapshot` のために
   * `stores.credentials.list()` を二重に呼び直さずに済む場所が、ここ以外に無い。
   */
  async function effective(): Promise<StoredCredential[]> {
    const rows = await stores.credentials.list();
    noteVaultSnapshot(rows);
    reportOverlong(rows);
    return resolveCredentialRows(rows, 'manager');
  }

  function fingerprintsOf(rows: readonly StoredCredential[]): CredentialFingerprint[] {
    return rows.map((row) => fingerprintOfRow(row));
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
          return { runnerId: runner.runnerId, ok: false as const, error: reasonOf(error) };
        }
      }),
    );
  }
}
