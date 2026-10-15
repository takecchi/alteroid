import {
  credentialNamesShadowedByProfile,
  fingerprintOf,
  ROTATABLE_CREDENTIAL_KEYS,
  runnerDeclaredEnvNames,
  type RunnerRegistry,
  type Stores,
  type TokenCredential,
  type TokenSpreadPort,
  type TokenSpreadResult,
} from '@alteroid/core';

export interface AgentTokenHolder {
  values(): Record<string, string>;
  identity(): { tokenId: string; generation: number; fingerprint?: string } | undefined;
  set(value: string, identity?: { tokenId: string; generation: number }): void;
  // 空文字を `set` しない: 空文字は `#childEnv()` へ空の `CLAUDE_CODE_OAUTH_TOKEN` を重ね、資格が空文字で上書きされるため。
  clear(identity?: { tokenId: string; generation: number }): void;
}

export function createAgentTokenHolder(): AgentTokenHolder {
  let current: string | undefined;
  let currentIdentity: { tokenId: string; generation: number } | undefined;
  return {
    values: (): Record<string, string> =>
      current === undefined ? {} : { CLAUDE_CODE_OAUTH_TOKEN: current },
    identity: () =>
      currentIdentity === undefined || current === undefined
        ? currentIdentity
        : { ...currentIdentity, fingerprint: fingerprintOf(current) },
    clear: (identity?: { tokenId: string; generation: number }) => {
      current = undefined;
      if (identity !== undefined) currentIdentity = identity;
    },
    set: (value: string, identity?: { tokenId: string; generation: number }) => {
      current = value;
      // 身元は渡されたときだけ更新する: 消すと、値は新しいのに身元が無い、照合できない状態が作れてしまうため。
      if (identity !== undefined) currentIdentity = identity;
    },
  };
}

export interface TokenSpreadOptions {
  runners: RunnerRegistry;
  clone: AgentTokenHolder;
  /** runner へ渡るプロファイル（scope が `runner` / `all` の行）が宣言する名前。撒いた鍵が上書きされるかは、ここで決まる。 */
  profileEnvNames: () => Promise<readonly string[]>;
  /** クローンのプロファイル（`app` / `all`）が宣言する名前。runner とは別に言う: 影になる先が違い、直す行も違うため。 */
  cloneProfileEnvNames?: () => Promise<readonly string[]>;
  onShadowed?: (names: readonly string[], target?: 'runner' | 'clone') => void;
}

// 正本の行から静的に拾う: runner の評価結果はデーモンへ戻ってこず、戻す通信を足さないため。
export async function runnerProfileEnvNames(stores: Pick<Stores, 'profile'>): Promise<string[]> {
  return runnerDeclaredEnvNames(await stores.profile.list());
}

// 撒くのは runner が先、クローンが後: 逆順だと runner が落ちたときにクローンだけが新しいトークンを持つ層のずれが残るため。
// 畳んで1つの成否にしない: runner が2台で1台だけ落ちる場合があり、台ごとに返して呼ぶ側が日誌へ全部載せる。
export interface RunnerTokenPushResult {
  runnerId: string;
  ok: boolean;
  error?: string;
}

export interface TokenSpread extends TokenSpreadPort {
  /**
   * runner へ撒いた結果を受け取る（#4725）。デーモンはこれを `ManagerPool` の帳面へ渡し、落ちた runner へ撒き直させる。
   * 撒く先が1台も無かった回（`selfHealing`）は渡さない: 繋がってきた runner には繋ぎの時に降ろすため。
   */
  onPushed(listener: (results: readonly RunnerTokenPushResult[]) => void): () => void;
}

export function createTokenSpread(options: TokenSpreadOptions): TokenSpread {
  const { runners, clone, profileEnvNames, cloneProfileEnvNames, onShadowed } = options;
  const listeners = new Set<(results: readonly RunnerTokenPushResult[]) => void>();

  return {
    onPushed(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async spread(
      token: { id: string; generation: number } & TokenCredential,
    ): Promise<TokenSpreadResult[]> {
      const results: TokenSpreadResult[] = [];

      // 影があっても撒くのはやめない（追加制限にしない）が、黙って効かない形にはしない。runner は渡る行の名前で、クローンは自分の評価結果で、別々に見る。
      const shadowed = await profileEnvNames()
        .then((names) => credentialNamesShadowedByProfile(ROTATABLE_CREDENTIAL_KEYS, names))
        .catch(() => [] as string[]);
      if (shadowed.length > 0) onShadowed?.(shadowed, 'runner');
      const cloneShadowed =
        cloneProfileEnvNames === undefined
          ? []
          : await cloneProfileEnvNames()
              .then((names) => credentialNamesShadowedByProfile(ROTATABLE_CREDENTIAL_KEYS, names))
              .catch(() => [] as string[]);
      if (cloneShadowed.length > 0) onShadowed?.(cloneShadowed, 'clone');

      const clients = await runners.list().catch(() => []);
      const pushed: RunnerTokenPushResult[] = [];
      for (const client of clients) {
        try {
          await client.setCredentials([{ name: 'CLAUDE_CODE_OAUTH_TOKEN', value: token.value }]);
          results.push({ target: client.runnerId, ok: true });
          pushed.push({ runnerId: client.runnerId, ok: true });
        } catch (error) {
          // 理由は1行目だけ採る: ドライバやネットワークの例外の本文に値が混ざる形が実在するため。
          const reason = firstLine(error);
          results.push({ target: client.runnerId, ok: false, error: reason });
          pushed.push({ runnerId: client.runnerId, ok: false, error: reason });
        }
      }

      if (clients.length === 0) {
        // 「撒く先が無い」を成功に畳まない: 畳むと、runner が1台も繋がっていない状態で「回した」だけが日誌に残るため。
        // `selfHealing: true` を添える: 添えないと、配布を試みて実際に落ちた失敗と日誌上で同じ「置けなかった」を名乗るため。
        results.push({
          target: 'runner',
          ok: false,
          error: '繋がっている runner が1台も無い（これから起こすマネージャーには届かない）',
          selfHealing: true,
        });
      }

      // 身元も一緒に置く: 置かないと、クローンの観測が身元を名乗れず世代の照合が素通しになるため。
      const identity = { tokenId: token.id, generation: token.generation };
      clone.set(token.value, identity);
      // クローンへ置いた後に知らせる: 撒き直しはクローンの箱の値（`createRunnerTokenSync`）を降ろすので、置く前だと古い鍵を撒き直すため
      if (pushed.length > 0) {
        for (const listener of listeners) {
          try {
            listener(pushed);
          } catch {
            // 受け手の不調で撒く処理を止めない
          }
        }
      }
      results.push({ target: 'clone', ok: true });

      if (shadowed.length > 0) {
        // 影を結果にも載せる: `onShadowed` だけに任せると、日誌へ落とす経路を1つ忘れた瞬間に見えなくなるため。
        results.push({
          target: 'profile-shadow',
          ok: false,
          error: `runner へ渡る実行環境プロファイルが同じ名前を宣言しているので、runner では撒いた鍵が上書きされる: ${shadowed.join(', ')}`,
        });
      }
      if (cloneShadowed.length > 0) {
        results.push({
          target: 'profile-shadow-clone',
          ok: false,
          error: `クローンの実行環境プロファイルが同じ名前を宣言しているので、クローンでは撒いた鍵が上書きされる: ${cloneShadowed.join(', ')}`,
        });
      }

      return results;
    },
  };
}

function firstLine(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.split('\n')[0] ?? '理由不明';
}

// 箱がまだ何も撒いていなければ何もしない: 器の環境変数へのフォールバックはどの経路にも残さないため。
export function createRunnerTokenSync(
  holder: AgentTokenHolder,
): (runner: { setCredentials: RunnerLike['setCredentials'] }) => Promise<void> {
  return async (runner) => {
    if (holder.identity() === undefined) return;
    const value = holder.values().CLAUDE_CODE_OAUTH_TOKEN ?? '';
    await runner.setCredentials([{ name: 'CLAUDE_CODE_OAUTH_TOKEN', value }]);
  };
}

interface RunnerLike {
  setCredentials(
    credentials: { name: string; value: string }[],
  ): Promise<{ name: string; sha256: string; updatedAt: string }[]>;
}
