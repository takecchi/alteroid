import {
  CREDENTIAL_NAME,
  fingerprintOf,
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
   */
  env?: NodeJS.ProcessEnv;
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
function assertEntries(entries: readonly CredentialEntry[], withheld: readonly string[]): void {
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
    if (seen.has(entry.name)) {
      throw new Error(`${entry.name} が2回渡されている（どちらが残るかを決めない）`);
    }
    seen.add(entry.name);
  }
}

export function createCredentialService(options: CredentialServiceOptions): CredentialService {
  const { stores, runners, withheldEnvKeys } = options;
  const env = options.env ?? process.env;

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
    fingerprints: async () =>
      (await stores.credentials.list()).map((row) => ({
        name: row.name,
        sha256: fingerprintOf(row.value),
        updatedAt: row.updatedAt,
      })),

    apply: (entries: readonly CredentialEntry[]) =>
      serial(async () => {
        assertEntries(entries, withheldEnvKeys);

        const rows = await stores.credentials.put(entries);

        /**
         * **外した名前も配る。** 正本から消えた行は `rows` に無いので、そのまま
         * 配ると runner の器には古い鍵が残り続ける（「外したのに効いている」）。
         *
         * **正本に在る名前は正本の値で配る**（入力の値ではなく）。同じものになる
         * はずだが、正本を経由させておけば、器が正規化や検査で値を変えた場合にも
         * 「配った値＝正本の値」が崩れない。
         */
        const removed = entries
          .filter((entry) => entry.value.length === 0)
          .map((entry) => ({ name: entry.name, value: '' }));
        const payload = [...rows.map(({ name, value }) => ({ name, value })), ...removed];

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
   * 降ろす対象を決める。**正本が先、クローンの器の env が後（正本に無い名前だけ）。**
   *
   * **プールが正本を持つ名前は入れない**（`POOL_OWNED_CREDENTIAL_NAMES`）。
   * あちらは回し手が撒く（`token-spread.ts`）ので、ここが同じ名前を降ろすと
   * **撒き手が2つになり、名乗り直しのたびに回した鍵を巻き戻す。**
   */
  async function effective(): Promise<StoredCredential[]> {
    const rows = await stores.credentials.list();
    const held = new Set(rows.map((row) => row.name));
    const fromEnv = ROTATABLE_CREDENTIAL_KEYS.filter(
      (name) => !held.has(name) && !POOL_OWNED_CREDENTIAL_NAMES.includes(name),
    ).flatMap((name) => {
      const value = env[name];
      // 空文字は「置かれていない」と同じに扱う（空の鍵は無い鍵より悪い）。
      if (value === undefined || value.length === 0) return [];
      return [{ name, value, updatedAt: '(クローンの器の環境変数)' }];
    });
    return [...rows, ...fromEnv];
  }

  function fingerprintsOf(
    rows: readonly { name: string; value: string; updatedAt: string }[],
  ): CredentialFingerprint[] {
    return rows.map((row) => ({
      name: row.name,
      sha256: fingerprintOf(row.value),
      updatedAt: row.updatedAt,
    }));
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
