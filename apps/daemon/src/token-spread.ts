import {
  credentialNamesShadowedByProfile,
  fingerprintOf,
  ROTATABLE_CREDENTIAL_KEYS,
  type RunnerRegistry,
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
  profileEnvNames: () => Promise<readonly string[]>;
  onShadowed?: (names: readonly string[]) => void;
}

// 撒くのは runner が先、クローンが後: 逆順だと runner が落ちたときにクローンだけが新しいトークンを持つ層のずれが残るため。
// 畳んで1つの成否にしない: runner が2台で1台だけ落ちる場合があり、台ごとに返して呼ぶ側が日誌へ全部載せる。
export function createTokenSpread(options: TokenSpreadOptions): TokenSpreadPort {
  const { runners, clone, profileEnvNames, onShadowed } = options;

  return {
    async spread(
      token: { id: string; generation: number } & TokenCredential,
    ): Promise<TokenSpreadResult[]> {
      const results: TokenSpreadResult[] = [];

      // 影があっても撒くのはやめない（追加制限にしない）が、黙って効かない形にはしない。
      const shadowed = await profileEnvNames()
        .then((names) => credentialNamesShadowedByProfile(ROTATABLE_CREDENTIAL_KEYS, names))
        .catch(() => [] as string[]);
      if (shadowed.length > 0) onShadowed?.(shadowed);

      const clients = await runners.list().catch(() => []);
      for (const client of clients) {
        try {
          await client.setCredentials([{ name: 'CLAUDE_CODE_OAUTH_TOKEN', value: token.value }]);
          results.push({ target: client.runnerId, ok: true });
        } catch (error) {
          // 理由は1行目だけ採る: ドライバやネットワークの例外の本文に値が混ざる形が実在するため。
          results.push({
            target: client.runnerId,
            ok: false,
            error: firstLine(error),
          });
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
      results.push({ target: 'clone', ok: true });

      if (shadowed.length > 0) {
        // 影を結果にも載せる: `onShadowed` だけに任せると、日誌へ落とす経路を1つ忘れた瞬間に見えなくなるため。
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
