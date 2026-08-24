import { randomUUID } from 'node:crypto';

import {
  markTokenUnusable,
  markTokenUsable,
  normalizeTokenPool,
  toAgentTokenView,
  type AgentToken,
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
  /**
   * 「このトークンで止まった」を1行へ記録する（Issue #393）。
   *
   * **回さない。** 記録するだけで、次の候補を選ぶことも撒くこともしない——
   * それは回し手（PR3）の領域である。
   *
   * 冷却の期限は `resetsAt`（権威ある値）、取れなければ**この列の中で読んだ
   * 設定の `cooldownMs`**。⚠️ 呼び出し側で設定を読んで渡す形にしないこと——
   * 読んでから渡すまでの隙間に設定が変わると、古い既定で冷やすことになる。
   *
   * **見つからなければ `undefined` を返す（投げない）。** 止まった通知が届く
   * までの間に人間がその行を消していることは普通に起こりうるので、これは
   * 異常系ではない。
   */
  noteUnusable(input: {
    id: string;
    /**
     * 止まったときの文言。**SDK が出したものをそのまま渡す**
     * （`TokenFailureObservation.message` の doc）。
     */
    message: string;
    /** 権威ある復帰時刻（epoch ミリ秒）。取れなければ省略——`0` で埋めない。 */
    resetsAt?: number;
  }): Promise<AgentTokenView | undefined>;
  /**
   * 使えることを確かめられたので、止まっていた記録を消す（Issue #393）。
   *
   * **呼んでよいのは実際に通ったことを観測したときだけである**
   * （`markTokenUsable` の doc）。冷却が明けただけでは呼ばない。
   *
   * 見つからなければ `undefined`（`noteUnusable` と同じ理由）。
   */
  noteUsable(id: string): Promise<AgentTokenView | undefined>;
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

  /**
   * 1行だけ差し替えて全文で書き戻す。**直列化された列の中からだけ呼ぶ。**
   *
   * **器（fs / pg）に「1行だけ更新する」口を足さないためにこの形にしてある。**
   * 足せば read-modify-write の原子性を fs と pg の両方へもう1つ実装することに
   * なり、既にある `replace`（pg は1トランザクションの delete → insert、fs は
   * 一時ファイルを rename する1回の書き込み）と二重になる。ここは `serial()` の
   * 中なので、読んでから書くまでに別の書き込みが割り込まない。
   *
   * **返り値は3つの状態を区別する。**
   *
   * - 書く前に居ない → `undefined`（**異常ではない。** 通知が届くまでの間に
   *   人間がその行を消していることは普通に起こる）
   * - 書いた後に読み直せない → **投げる**（器の側の異常。`undefined` へ潰すと
   *   「元から無かった」と見分けが付かなくなる）
   * - 正常 → 器が返した行から作った外向きの顔
   */
  async function writeOne(
    existing: readonly AgentToken[],
    id: string,
    mutate: (token: AgentToken) => AgentToken,
  ): Promise<AgentTokenView | undefined> {
    if (!existing.some((token) => token.id === id)) return undefined;
    const stored = await stores.tokens.replace(
      existing.map((token) => (token.id === id ? mutate(token) : token)),
    );
    const written = stored.find((token) => token.id === id);
    if (written === undefined) {
      // **id だけを含める。** 値も文言もここへ載せない（この例外は上の層で
      // ログに出る）。
      throw new Error(`トークン（id ${id}）を書いた直後に読み直せなかった`);
    }
    return toAgentTokenView(written);
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

    noteUnusable: (input: { id: string; message: string; resetsAt?: number }) =>
      serial(async () => {
        const [existing, settings] = await Promise.all([
          stores.tokens.list(),
          stores.tokens.readSettings(),
        ]);
        return writeOne(existing, input.id, (token) =>
          markTokenUnusable(token, {
            at: now().toISOString(),
            message: input.message,
            ...(input.resetsAt === undefined ? {} : { resetsAt: input.resetsAt }),
            fallbackCooldownMs: settings.cooldownMs,
          }),
        );
      }),

    noteUsable: (id: string) =>
      serial(async () => {
        const existing = await stores.tokens.list();
        return writeOne(existing, id, (token) => markTokenUsable(token, now().toISOString()));
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
