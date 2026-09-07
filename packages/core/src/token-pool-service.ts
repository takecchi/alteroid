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
  /**
   * **プールか設定が変わったことを知らせる口**（人間の決定 2026-09-07）。
   *
   * ## なぜ要るか —— 「鍵を足したのに何も起きない」を塞ぐ
   *
   * ここは記憶ストアを書くだけで、回し手（`token-rotator.ts`）を呼んでいなかった。
   * ⟹ **全層が枠で止まっている器へ人間が新しい鍵を1本足しても、何も起きなかった。**
   * 回すには誰かが**もう一度本番で失敗して観測を上げる**必要があり、そのとき全層は
   * 止まっているので、観測を上げる主体が1つも居ない。
   *
   * **ここは `PUT /tokens` / `PUT /tokens/policy` の唯一の合流点である**（CLI の
   * `alteroid token add` / `enable` / `policy` も HTTP を通ってここへ来る）⟹
   * 契機を1つ置けば、人間のどの口からでも届く。
   *
   * **知らせるだけで、判断はしない。** 回すかどうかは回し手が決める
   * （`TokenRotator.reconsider`）——ここが「回せ」と言う形にすると、**設定が
   * `off` でも回る**経路が生まれる。
   *
   * **失敗させない・待たせない。** 呼び出しは同期で、投げても保存の結果を
   * 巻き添えにしない（下の実装が `try` で包む）——鍵は保存できているのに
   * 「保存できなかった」と返すのは、いちばん誤解を招く倒れ方である。
   */
  onChanged?: (change: 'pool' | 'settings') => void;
}

export function createTokenPoolService(options: TokenPoolServiceOptions): TokenPoolService {
  const { stores } = options;
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? (() => randomUUID());

  /**
   * 変わったことを知らせる。**保存の成否を巻き添えにしない。**
   *
   * 呼ぶのは**保存が成功した後**だけである（前に呼ぶと、検証で落ちた入力でも
   * 「変わった」が飛ぶ）。跡は残す —— 黙って握り潰すと、契機が届いていない
   * ことが誰からも見えない（`dropped-record.ts` の作法）。
   */
  function announceChange(change: 'pool' | 'settings'): void {
    if (options.onChanged === undefined) return;
    try {
      options.onChanged(change);
    } catch (error) {
      // **本文を出さない。** ここへ来る例外は見張りの側のもので、トークンの値は
      // 通っていないが、この関数は値を扱う経路の中に居る。
      process.stderr.write(
        `alteroidd: 認証トークンのプールの変更（${change}）を見張りへ知らせられなかった: ` +
          `${error instanceof Error ? (error.message.split('\n')[0] ?? '理由不明') : '理由不明'}\n`,
      );
    }
  }

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
        // **保存できた後に知らせる**（`announceChange` の doc）。
        announceChange('pool');
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
        const written = await stores.tokens.writeSettings(next);
        // **設定も契機である。** `off` → `free_exhausted` へ戻した瞬間に、
        // 止まったまま溜まっていた状態を見直せなければ、人間は**設定を戻した後
        // さらに待たされる**（次の観測が上がるまで）。
        announceChange('settings');
        return written;
      }),
  };
}
