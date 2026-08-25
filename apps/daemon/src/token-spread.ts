import {
  credentialNamesShadowedByProfile,
  ROTATABLE_CREDENTIAL_KEYS,
  type RunnerRegistry,
  type TokenSpreadPort,
  type TokenSpreadResult,
} from '@alteroid/core';

/**
 * 認証トークンのプールの現役を、**2か所へ撒く**（Issue #393 PR3 の6段目）。
 *
 * | 撒く先 | 経路 | いつ効くか |
 * | --- | --- | --- |
 * | runner（マネージャー・作業者） | `RunnerClient#setCredentials`（既存 RPC） | **これから起こす**マネージャーに即座 |
 * | クローン | {@link AgentTokenHolder} → `Clone` の `credentials` | **次に SDK セッションを起こすとき** |
 *
 * **⚠️ どちらも走行中のセッションには届かない。** env はプロセス起動時に凍る
 * （`credentials.ts` / `profile.ts` の doc が同じ境界を何度も書いている）。
 * ⟹ ここが `ok` を返すのは「置いた」までであって、「回った」ではない。
 */

/** クローンへ届ける現役の置き場。**値ではなく箱を渡す。** */
export interface AgentTokenHolder {
  /**
   * いまの値（`CloneOptions.credentials` へそのまま渡せる形）。
   *
   * **まだ何も置いていなければ空を返す。** 空を返すことで、`#childEnv()` は
   * 器の環境変数だけの既定の構成と1文字も変わらない（受け入れ基準7）。
   */
  values(): Record<string, string>;
  /**
   * いま撒いてあるものの身元。**まだ撒いていなければ `undefined`。**
   *
   * クローンがセッションを起こす瞬間にこれを捕まえ、そのセッションの観測へ添える
   * （世代の照合。`observationFreshness`）。
   */
  identity(): { tokenId: string; generation: number } | undefined;
  set(value: string, identity?: { tokenId: string; generation: number }): void;
}

export function createAgentTokenHolder(): AgentTokenHolder {
  let current: string | undefined;
  let currentIdentity: { tokenId: string; generation: number } | undefined;
  return {
    values: (): Record<string, string> =>
      current === undefined ? {} : { CLAUDE_CODE_OAUTH_TOKEN: current },
    identity: () => currentIdentity,
    set: (value: string, identity?: { tokenId: string; generation: number }) => {
      current = value;
      // **身元は渡されたときだけ更新する。** 渡されなかったからといって消すと、
      // 「値は新しいのに身元は無い」という、照合できない状態が作れてしまう。
      if (identity !== undefined) currentIdentity = identity;
    },
  };
}

export interface TokenSpreadOptions {
  runners: RunnerRegistry;
  clone: AgentTokenHolder;
  /**
   * 実行環境プロファイルが宣言している env の名前。**影の検出に使う。**
   *
   * 取れなければ空を返してよい——**その場合は検出できないので、影が在っても
   * 気づけない。** 取れなかったことを「影が無い」と読ませないため、下では
   * 検出できたときだけ印を出す。
   */
  profileEnvNames: () => Promise<readonly string[]>;
  /** 影を見つけたときに出す先（日誌・stderr）。 */
  onShadowed?: (names: readonly string[]) => void;
}

/**
 * **撒くのは runner が先、クローンが後。** 順序に意味がある——runner は
 * ネットワーク越し（落ちうる）で、クローンは同じプロセス内（落ちない）である。
 * 逆順にすると、runner が落ちたときに**クローンだけが新しいトークンを持つ**という
 * 層のずれが残る。先に落ちうる側をやれば、失敗したことが `ok: false` として出る。
 *
 * **⚠️ それでも「片方だけ撒けた」は起きる。** runner が2台あって1台だけ落ちた
 * 場合である。**畳んで1つの成否にしないこと** — 台ごとに返して、呼ぶ側（回し手）が
 * 日誌へ全部載せる。
 */
export function createTokenSpread(options: TokenSpreadOptions): TokenSpreadPort {
  const { runners, clone, profileEnvNames, onShadowed } = options;

  return {
    async spread(token: {
      id: string;
      value: string;
      generation: number;
    }): Promise<TokenSpreadResult[]> {
      const results: TokenSpreadResult[] = [];

      // **プロファイルが同じ名前を宣言していたら、撒く前に出す。**
      // 撒くのをやめはしない（追加制限にしない）が、黙って効かない形にはしない
      // （`credentialNamesShadowedByProfile` の doc）。
      const shadowed = await profileEnvNames()
        .then((names) => credentialNamesShadowedByProfile(ROTATABLE_CREDENTIAL_KEYS, names))
        .catch(() => [] as string[]);
      if (shadowed.length > 0) onShadowed?.(shadowed);

      const clients = await runners.list().catch(() => []);
      for (const client of clients) {
        // **`runnerId` をそのまま名札にしている。** 既定値（`'runner-primary'`）が
        // 入っていることがあるので「聞けた id」ではないが、ここが要るのは
        // **どの宛先の話かを人間が見分けられること**までで、識別子としての
        // 権威は要らない（`RunnerClient.runnerId` の注意書き）。
        try {
          await client.setCredentials([{ name: 'CLAUDE_CODE_OAUTH_TOKEN', value: token.value }]);
          results.push({ target: client.runnerId, ok: true });
        } catch (error) {
          // **理由は1行目だけ採る。** ドライバやネットワークの例外は本文へ
          // 余計なものを添えてくることがあり、**そこに値が混ざる形が実在する**
          // （`token-pool.ts` の `TokenPoolInputError` の doc）。
          results.push({
            target: client.runnerId,
            ok: false,
            error: firstLine(error),
          });
        }
      }

      if (clients.length === 0) {
        // **「撒く先が無い」を成功に畳まない。** 畳むと、runner が1台も繋がって
        // いない状態で「回した」だけが日誌に残る。
        results.push({
          target: 'runner',
          ok: false,
          error: '繋がっている runner が1台も無い（これから起こすマネージャーには届かない）',
        });
      }

      // クローン側は同じプロセス内なので落ちない。**身元も一緒に置く** —
      // 置かないと、クローンの観測が身元を名乗れず世代の照合が素通しになる。
      clone.set(token.value, { tokenId: token.id, generation: token.generation });
      results.push({ target: 'clone', ok: true });

      if (shadowed.length > 0) {
        // **影を結果にも載せる。** 呼び出し側の `onShadowed` だけに任せると、
        // 日誌へ落とす経路を1つ忘れた瞬間に見えなくなる。
        results.push({
          target: 'profile-shadow',
          ok: false,
          error: `実行環境プロファイルが同じ名前を宣言しているので、撒いた鍵が上書きされる: ${shadowed.join(', ')}`,
        });
      }

      return results;
    },
  };
}

/**
 * 例外から1行目だけを採る。**トークンの値が本文へ混ざる形を減らすためである。**
 *
 * **⚠️ これは保証ではない。** ドライバがメッセージのどこで改行するかはこちらが
 * 制御していない（`token-pool.ts` の doc が同じ危うさを名指ししている）。値を
 * 出さない本体の保証は、**`setCredentials` が値を投げ返さないこと**の側にある。
 */
function firstLine(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.split('\n')[0] ?? '理由不明';
}

/**
 * 名乗ってきた runner 1台へ、いま撒いてある認証トークンを降ろす（Issue #393 PR3）。
 *
 * **`createTokenSpread` の1台版ではない。** あちらは「回した / 引き取った」ときに
 * 全台と クローンへ撒くもので、こちらは**後から上がってきた1台に追いつかせる**
 * ものである。`ManagerPool` の `#connectTo` から呼ばれる（プロファイルの
 * `syncRunner` と同じ位置）。
 *
 * **箱が空なら何もしない。** 器の環境変数だけで走っている既定の構成では、
 * 降ろすものが無い（受け入れ基準7）。
 */
export function createRunnerTokenSync(
  holder: AgentTokenHolder,
): (runner: { setCredentials: RunnerLike['setCredentials'] }) => Promise<void> {
  return async (runner) => {
    const value = holder.values().CLAUDE_CODE_OAUTH_TOKEN;
    if (value === undefined) return;
    await runner.setCredentials([{ name: 'CLAUDE_CODE_OAUTH_TOKEN', value }]);
  };
}

/** `setCredentials` だけを要求する最小の形（テストで偽物を渡せるようにするため）。 */
interface RunnerLike {
  setCredentials(
    credentials: { name: string; value: string }[],
  ): Promise<{ name: string; sha256: string; updatedAt: string }[]>;
}
