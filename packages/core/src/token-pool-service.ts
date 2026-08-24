import { randomUUID } from 'node:crypto';

import {
  normalizeTokenPool,
  toAgentTokenView,
  type AgentTokenInput,
  type AgentTokenView,
  type TokenRotationPolicy,
  type TokenRotationSettings,
} from './token-pool.js';
import type { Stores } from './store.js';

/**
 * 認証トークンのプールを**置いて読む**までの1本道（Issue #393「PR1 プールの器」）。
 *
 * `profile-service.ts` の {@link createProfileService} と**同じ形**——書く操作は
 * すべて直列化された1本の列（`serial()`）を通す。
 *
 * **なぜ直列化するか。** 人間の口（`PUT /tokens` / `PUT /tokens/policy`）・CLI・
 * （後で PR6 が足す）クローンの道具は、いずれ同じ記憶ストアの同じ行を書き換える。
 * 別々の経路のまま並行に書かせると、`profile-service.ts` の doc が書いている
 * のと同じ分裂が起きる——2つの更新が同時に入ったとき、後勝ちのつもりが
 * 「途中で混ざった版」を残してしまう。人間が `PUT /tokens` で並べ替えている
 * 最中にクローンが `token_add` を呼ぶことは自律ターンがある以上普通に起こりうる
 * ので、この列は理論上の心配ではない。
 *
 * **この PR で回す道具は無い。** ここにあるのは `list` / `replace` /
 * `setSettings` の3つだけで、検知や切替（PR3）はここには無い。
 */
export interface TokenPoolService {
  /** 現在のプール（外向きの顔）と設定。 */
  list(): Promise<{ tokens: AgentTokenView[]; settings: TokenRotationSettings }>;
  /**
   * 全文置換。`normalizeTokenPool` が投げたら、そのまま呼び出し側へ投げ返す
   * （保存はしていない——検証に落ちたものを記憶ストアへ書かない）。
   */
  replace(inputs: readonly AgentTokenInput[]): Promise<{
    tokens: AgentTokenView[];
    settings: TokenRotationSettings;
  }>;
  /** 回す契機・冷却の既定を部分更新する。 */
  setSettings(patch: {
    rotateOn?: TokenRotationPolicy;
    cooldownMs?: number;
  }): Promise<TokenRotationSettings>;
}

export interface TokenPoolServiceOptions {
  stores: Stores;
  /** 現在時刻。テストで固定するため。既定は `() => new Date()`。 */
  now?: () => Date;
  /** 新規行の id を作る。テストで固定するため。既定は `randomUUID()`。 */
  newId?: () => string;
}

export function createTokenPoolService(options: TokenPoolServiceOptions): TokenPoolService {
  const { stores } = options;
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? (() => randomUUID());

  /**
   * 直列化の実体。`profile-service.ts` の `serial()` と同じ形——次の更新は
   * 前の更新が終わってから始まる。前の失敗で列が止まらないよう、常に解決する
   * 形で繋ぐ（失敗は呼び出し側へ返る）。
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

  async function currentView(): Promise<{
    tokens: AgentTokenView[];
    settings: TokenRotationSettings;
  }> {
    const [tokens, settings] = await Promise.all([
      stores.tokens.list(),
      stores.tokens.readSettings(),
    ]);
    return { tokens: tokens.map(toAgentTokenView), settings };
  }

  return {
    // **読みは直列化の列を通さない。** 直列化が守るのは「書き込みが混ざらない
    // こと」であって、読みを待たせる理由は無い（`profile-service.ts` の `read`
    // と同じ判断）。
    list: () => currentView(),

    replace: (inputs: readonly AgentTokenInput[]) =>
      serial(async () => {
        const existing = await stores.tokens.list();
        // **検証に落ちたら保存しない。** `normalizeTokenPool` が投げた例外は
        // そのまま呼び出し側（HTTP 層）へ伝わり、そこで 400 として理由を返す。
        const normalized = normalizeTokenPool(inputs, existing, { now, newId });
        const stored = await stores.tokens.replace(normalized);
        const settings = await stores.tokens.readSettings();
        return { tokens: stored.map(toAgentTokenView), settings };
      }),

    setSettings: (patch: { rotateOn?: TokenRotationPolicy; cooldownMs?: number }) =>
      serial(async () => {
        const current = await stores.tokens.readSettings();
        const next: TokenRotationSettings = {
          rotateOn: patch.rotateOn ?? current.rotateOn,
          cooldownMs: patch.cooldownMs ?? current.cooldownMs,
          updatedAt: now().toISOString(),
        };
        return stores.tokens.writeSettings(next);
      }),
  };
}
