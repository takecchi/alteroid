import { randomUUID } from 'node:crypto';

import {
  markTokenUnusable,
  markTokenUsable,
  normalizeTokenPool,
  toAgentTokenView,
  type AgentToken,
  type AgentTokenInput,
  type AgentTokenView,
  type TokenFailureObservation,
  type TokenRotationPolicy,
  type TokenRotationSettings,
} from './token-pool.js';
import { reasonOf } from './dropped-record.js';
import type { UnreadableToken } from './schema.js';
import { UnreadableTokenSettingsError, type Stores } from './store.js';
import { createTokenPoolWriteLock, type TokenPoolWriteLock } from './token-pool-write-lock.js';

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
 * **⚠️ ただし、この `serial()` が直列化するのは「このサービスへの呼び出し
 * どうし」だけである。回し手（`token-rotator.ts`）は別インスタンスの別の
 * `serial()` を持つので、この列だけでは足りない**（Issue #2200）。
 * `replace()` / `noteUnusable()` / `noteUsable()` はどれも `stores.tokens
 * .replace()`（CAS の無い全文置換。`store.ts` の doc）で書くので、この列の
 * 外側で回し手が同時に書けば、後に書いたほうが前の変更を黙って消す——実測は
 * 「人間の `PUT /tokens` が3本目を足した直後、回し手の `observe()` が古い
 * 2本の一覧で書き戻し、3本目が消えた」。**それを防ぐのが
 * {@link TokenPoolServiceOptions.writeLock}**（`token-pool-write-lock.ts`。
 * `createTokenRotator` と共有する、書く区間だけを守る鍵）——下の `writeOne` /
 * `replace` の実装を見よ。
 *
 * **この PR で回す道具は無い。** ここにあるのは `list` / `replace` /
 * `setSettings` の3つだけで、検知や切替（PR3）はここには無い。
 */

/**
 * `list()` / `replace()` が返す形（issue #2095）。**`settings` /
 * `settingsUnreadable` はどちらか一方だけが在る。**
 *
 * `stores.tokens.readSettings()` が `UnreadableTokenSettingsError`
 * （`store.ts`）を投げたときは `settings` を省き、`settingsUnreadable.reason`
 * （エラーの `message`。どの欄が壊れているかだけで値は含まない）を代わりに
 * 置く。**既定値（`DEFAULT_TOKEN_ROTATION_SETTINGS`）で埋めない** ——
 * `readSettings()` の doc が言う「無い」と「読めない」の区別を、ここで
 * 潰すと `off` にしてあった回転を実装が黙って戻すことになる
 * （`AGENTS.md` の地雷「取れない軸に 0 の行を作る」と同じ形）。
 * それ以外のエラー（器そのものの異常）はここで飲み込まず、呼び出し側へ
 * そのまま投げる。
 *
 * **判別できる形にしてある。** `settings` と `settingsUnreadable` は
 * 両方の枝に存在する（片方は常に `undefined`）ので、読む側は
 * `result.settings === undefined` で分岐でき、strict null checks が
 * 「読める前提」の直接アクセスを型検査で落とす。
 *
 * **`rowsUnreadable` は設定の2枝とは独立の欄である**（issue #2346）。読めなかった
 * 行（`stores.tokens.listUnreadable()`）が**1件でも在るときだけ**載る（0件なら鍵ごと
 * 無い。`{ count: 0 }` を作ると「読めない行は無いと確かめた」と読めてしまう）。
 * **`tokens` が空のとき「登録されていない」と言ってよいのは、この欄が無いときだけ
 * である。** 載せるのは id・ラベル・不正な欄名だけで、トークンの値は載せない。
 */
export type TokenPoolView = (
  | { tokens: AgentTokenView[]; settings: TokenRotationSettings; settingsUnreadable?: undefined }
  | {
      tokens: AgentTokenView[];
      settings?: undefined;
      settingsUnreadable: { reason: string };
    }
) & { rowsUnreadable?: TokenRowsUnreadable };

/**
 * {@link TokenPoolView.rowsUnreadable}。`count` は `rows.length` と等しい。
 *
 * **`carriedOver` は全文置換（{@link TokenPoolService.replace}）の応答にだけ付く**
 * （issue #2354）。「この読めない行（`count` 行）は、置換で捨てずに持ち越した」の印で、
 * 読み取り（`list()`）には付かない。
 */
export interface TokenRowsUnreadable {
  count: number;
  rows: UnreadableToken[];
  carriedOver?: true;
}

/** {@link TokenPoolService.removeUnreadable} の追加の引数。 */
export interface RemoveUnreadableOptions {
  /**
   * 消すと決まった id（読めない行に実在するものだけ）を、**消す前に**渡して呼ぶ。
   * 書き込みの鍵の中で呼ぶ。**投げたら何も消さない。**
   */
  beforeRemove?: (ids: readonly string[]) => Promise<void>;
}

export type RemoveUnreadableResult =
  /** 消した。`ids` は消した id（重複なし）、`view` は消した後のプール。 */
  | { kind: 'removed'; ids: string[]; view: TokenPoolView }
  /**
   * 消した。**ただし、表示のための読み直しに失敗した**（issue #2390）。`ids` は消した id。
   * **消したことは確かなので、「消せなかった」として扱ってはならない**（呼び出し側が
   * 打ち消しの日誌を書いたり、失敗を返したりしない）。`cause` は読み直しが投げたもの
   * （**メッセージに行の中身が載りうるので、そのまま外へ出さない**。種類だけ言う）。
   */
  | { kind: 'removedViewFailed'; ids: string[]; cause: unknown }
  /** 指された id のうち `count` 件が読めない行に無かった。何も消していない。 */
  | { kind: 'unknown'; count: number };

/**
 * {@link TokenPoolService.replace} の結果（issue #2396）。
 *
 * **検証に落ちたとき・保存そのものが失敗したときは、今までどおり投げる**（保存していない）。
 * ここに載るのは、保存した後の話だけである。
 */
export type ReplaceResult =
  /** 保存した。`view` は保存後のプール。 */
  | { kind: 'replaced'; view: TokenPoolView }
  /**
   * 保存した。**ただし、表示のための読み直しに失敗した。** 保存したことは確かなので、
   * 「保存できなかった」として扱ってはならない（呼び出し側が失敗を返すと、呼んだ人は
   * 同じ操作を撃ち直す）。`cause` は読み直しが投げたもの（**メッセージに行の中身が載りうる
   * ので、そのまま外へ出さない**。種類だけ言う）。
   */
  | { kind: 'replacedViewFailed'; cause: unknown };

export interface TokenPoolService {
  /** 現在のプール（外向きの顔）と設定。設定が読めないときは {@link TokenPoolView} を見よ。 */
  list(): Promise<TokenPoolView>;
  /**
   * 全文置換。`normalizeTokenPool` が投げたら、そのまま呼び出し側へ投げ返す
   * （保存はしていない——検証に落ちたものを記憶ストアへ書かない）。
   *
   * **`tokens` の保存は設定が読めるかどうかに関係なく行う**（issue #2095）
   * ——置換そのものは `settings` に触れないので、設定が壊れていることを
   * 理由にプールの置換まで止めない。
   */
  replace(inputs: readonly AgentTokenInput[]): Promise<ReplaceResult>;
  /**
   * **読めない行を、id で指して消す**（issue #2354）。全文置換（{@link replace}）は
   * 読めない行を持ち越すので、読めない行を消す口はこれだけである。
   *
   * - `ids` のどれかが読めない行に無ければ、**何も消さずに** `{ kind: 'unknown' }` を返す
   *   （全部か無か。打ち間違いで別の行を消さない）。**件数だけ返し、指された文字列は
   *   返さない**（取り違えて貼ったトークンの値を応答へ映さない）。
   * - 消すと決まったら、{@link RemoveUnreadableOptions.beforeRemove} を**書き込みの鍵の中で
   *   先に**呼ぶ。**投げたら何も消さずに投げ直す**（日誌を先に書き、書けなければ状態を変えない
   *   作法のための口）。
   * - **id が取れない読めない行は、この口では消せない**（指す名前が無い）。
   */
  removeUnreadable(
    ids: readonly string[],
    options?: RemoveUnreadableOptions,
  ): Promise<RemoveUnreadableResult>;
  /**
   * 回す契機・冷却の既定を部分更新する。
   *
   * **現在値が壊れていて読めない（`UnreadableTokenSettingsError`）ときも、
   * `patch` が `rotateOn` と `cooldownMs` の両方を持っていれば書ける**
   * （issue #2053）——読めない現在値を読まずに、新しい値だけで書き直す。
   * **片方しか無ければ埋める元が無いので、そのまま投げる**（呼び出し側
   * ——`PUT /tokens/policy`——へエラーが届く）。
   */
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
   * 冷却の期限は `resets`（権威ある値。#683 で出所と組にした）、取れなければ
   * **この列の中で読んだ設定の `cooldownMs`**。⚠️ 呼び出し側で設定を読んで渡す
   * 形にしないこと——読んでから渡すまでの隙間に設定が変わると、古い既定で
   * 冷やすことになる。
   *
   * **⚠️ 引数の形を書き写さないこと**（#683 で踏んだ）。ここはかつて
   * `resetsAt?: number` を自前で宣言していて、`TokenFailureObservation` 側を
   * `resets: { at, source }` へ変えたときに**型検査を1つも落とさずに素通り
   * した** —— 実装は `...(input.resetsAt === undefined ? {} : { resetsAt: … })`
   * の形で渡していて、**オブジェクトリテラルへの spread は余分な欄を弾かない。**
   * ⟹ 期限が黙って捨てられ、**歯が1本落ちるまで誰も気づかなかった。**
   * だから {@link TokenFailureObservation} から `Pick` する形にしてある。
   *
   * **見つからなければ `undefined` を返す（投げない）。** 止まった通知が届く
   * までの間に人間がその行を消していることは普通に起こりうるので、これは
   * 異常系ではない。
   */
  noteUnusable(
    input: { id: string } & Pick<TokenFailureObservation, 'message' | 'resets'>,
  ): Promise<AgentTokenView | undefined>;
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
  /**
   * **`TokenPoolStore` への書き込みを `TokenRotator` と共有する鍵**
   * （Issue #2200。`token-pool-write-lock.ts`）。
   *
   * **省略すると自分専用の鍵を作る**（テストや、この鍵をまだ配線していない
   * 呼び手との互換のため）。本番（`apps/daemon/src/index.ts`）は
   * `createTokenPoolWriteLock()` を1つ作って `createTokenRotator` とここへ
   * 同じインスタンスを渡す——別々のインスタンスを渡すと Issue #2200 の状態
   * （別々の直列の列が互いを待たない）に戻る。
   *
   * **握るのは「最新の一覧を読み直す → 変えた行を id で当てる → 書き戻す」
   * の短い区間だけ**（`token-pool-write-lock.ts` の doc）。`writeOne` /
   * `replace` の内側がそのまま出している。
   */
  writeLock?: TokenPoolWriteLock;
}

export function createTokenPoolService(options: TokenPoolServiceOptions): TokenPoolService {
  const { stores } = options;
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? (() => randomUUID());
  const writeLock = options.writeLock ?? createTokenPoolWriteLock();

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
          `${reasonOf(error)}\n`,
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

  /**
   * `stores.tokens.readSettings()` を読み、`UnreadableTokenSettingsError`
   * だけを3値目として畳む（issue #2095。`tools.ts` の `token_list` や
   * `store.ts` の他の `Unreadable*Error` と同じ「投げっぱなしにしない」
   * 作法）。**それ以外のエラーは飲み込まずそのまま投げる** —— 器そのものの
   * 異常（DB 接続断など）まで「設定が壊れている」に化けさせない。
   */
  async function readSettingsOrUnreadable(): Promise<
    { ok: true; settings: TokenRotationSettings } | { ok: false; reason: string }
  > {
    try {
      const settings = await stores.tokens.readSettings();
      return { ok: true, settings };
    } catch (error) {
      if (!(error instanceof UnreadableTokenSettingsError)) throw error;
      return { ok: false, reason: error.message };
    }
  }

  /** {@link readSettingsOrUnreadable} の結果を {@link TokenPoolView} の形へ組む。 */
  function viewOf(
    tokens: AgentTokenView[],
    settingsResult: Awaited<ReturnType<typeof readSettingsOrUnreadable>>,
    unreadableRows: readonly UnreadableToken[],
    options: { carriedOver?: boolean } = {},
  ): TokenPoolView {
    const base = settingsResult.ok
      ? { tokens, settings: settingsResult.settings }
      : { tokens, settingsUnreadable: { reason: settingsResult.reason } };
    // **1件でも在るときだけ鍵を載せる**（{@link TokenPoolView} の doc）。
    return unreadableRows.length === 0
      ? base
      : {
          ...base,
          rowsUnreadable: {
            count: unreadableRows.length,
            rows: [...unreadableRows],
            ...(options.carriedOver === true ? { carriedOver: true as const } : {}),
          },
        };
  }

  async function currentView(): Promise<TokenPoolView> {
    const [tokens, settingsResult, unreadableRows] = await Promise.all([
      stores.tokens.list(),
      readSettingsOrUnreadable(),
      stores.tokens.listUnreadable(),
    ]);
    return viewOf(tokens.map(toAgentTokenView), settingsResult, unreadableRows);
  }

  /**
   * 1行だけ差し替えて全文で書き戻す。**呼ぶのは直列化された列（`serial()`）
   * の中からだけ**——同じサービスの中の呼び出しどうしが混ざらないのは、
   * いまもここが守る。
   *
   * **器（fs / pg）に「1行だけ更新する」口を足さないためにこの形にしてある。**
   * 足せば read-modify-write の原子性を fs と pg の両方へもう1つ実装することに
   * なり、既にある `replace`（pg は1トランザクションの delete → insert、fs は
   * 一時ファイルを rename する1回の書き込み）と二重になる。
   *
   * **⚠️ ここはかつて「`serial()` の中なので、読んでから書くまでに別の
   * 書き込みが割り込まない」と書いていたが、それは誤りだった**
   * （Issue #2200）。`token-rotator.ts` は**別インスタンスの別の `serial()`**
   * を持つので、この列はあちらの書き込みを待たない——実測で、人間の
   * `PUT /tokens` の直後に回し手の `observe()` が古い一覧で書き戻し、足した
   * 3本目を黙って消した。
   *
   * **いまはここで最新の一覧を読み直す。** `existing` を呼び出し側から受け
   * 取らないのはそのためである——受け取ると、呼び出し側が読んだ時点で
   * 古くなりうる。読み直しから書き戻しまでを {@link TokenPoolServiceOptions.writeLock}
   * （回し手と共有する鍵）の中に収め、回し手の書き込みと排他にする。
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
    id: string,
    mutate: (token: AgentToken) => AgentToken,
  ): Promise<AgentTokenView | undefined> {
    const stored = await writeLock.run(async () => {
      const existing = await stores.tokens.list();
      if (!existing.some((token) => token.id === id)) return undefined;
      return stores.tokens.replace(
        existing.map((token) => (token.id === id ? mutate(token) : token)),
      );
    });
    if (stored === undefined) return undefined;
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
        // **読み直し（`value` を省略した行の既存値を埋める元）から書き戻し
        // までを {@link writeLock} の中に収める**（Issue #2200）。ここは
        // 人間が渡した全体が正本なので全文置換のままでよいが、回し手の
        // `coolDown` / `finishSweep` と同じ鍵を通さないと、読んでから書く
        // 間に回し手の冷却が割り込んで黙って消える。
        const stored = await writeLock.run(async () => {
          const existing = await stores.tokens.list();
          // **検証に落ちたら保存しない。** `normalizeTokenPool` が投げた例外は
          // そのまま呼び出し側（HTTP 層）へ伝わり、そこで 400 として理由を返す。
          const normalized = normalizeTokenPool(inputs, existing, { now, newId });
          return stores.tokens.replace(normalized);
        });
        // **ここから先は、保存した後である**（issue #2396）。読み直しの失敗を投げると、
        // 呼び出し側は「保存できなかった」と読む。保存したことは変わらないので、
        // 失敗は値で返す。
        let view: TokenPoolView;
        try {
          const settingsResult = await readSettingsOrUnreadable();
          const unreadableRows = await stores.tokens.listUnreadable();
          // **読めない行は持ち越した**と応答で言う（issue #2354。ストアの `replace` は
          // 読めない行を捨てない）。
          view = viewOf(stored.map(toAgentTokenView), settingsResult, unreadableRows, {
            carriedOver: true,
          });
        } catch (cause) {
          announceChange('pool');
          return { kind: 'replacedViewFailed', cause } satisfies ReplaceResult;
        }
        // **保存できた後に知らせる**（`announceChange` の doc）。
        announceChange('pool');
        return { kind: 'replaced', view } satisfies ReplaceResult;
      }),

    removeUnreadable: (ids: readonly string[], options: RemoveUnreadableOptions = {}) =>
      serial(async () => {
        const wanted = [...new Set(ids)];
        const removed = await writeLock.run(
          async (): Promise<RemoveUnreadableResult | string[]> => {
            const present = new Set(
              (await stores.tokens.listUnreadable()).flatMap((row) =>
                row.id === undefined ? [] : [row.id],
              ),
            );
            const unknown = wanted.filter((id) => !present.has(id));
            if (unknown.length > 0 || wanted.length === 0) {
              return { kind: 'unknown', count: unknown.length };
            }
            // **日誌などを先に。投げたら、ここで止まり、何も消さない。**
            await options.beforeRemove?.(wanted);
            return stores.tokens.removeUnreadable(wanted);
          },
        );
        if (!Array.isArray(removed)) return removed;
        // **ここから先は、行を消した後である**（issue #2390）。読み直しの失敗を投げ直すと、
        // 呼び出し側は「消せなかった」と読む。消したことは変わらないので、失敗は値で返す。
        let view: TokenPoolView;
        try {
          const [tokens, settingsResult, unreadableRows] = await Promise.all([
            stores.tokens.list(),
            readSettingsOrUnreadable(),
            stores.tokens.listUnreadable(),
          ]);
          view = viewOf(tokens.map(toAgentTokenView), settingsResult, unreadableRows);
        } catch (cause) {
          announceChange('pool');
          return { kind: 'removedViewFailed', ids: removed, cause };
        }
        announceChange('pool');
        return { kind: 'removed', ids: removed, view };
      }),

    noteUnusable: (input: { id: string } & Pick<TokenFailureObservation, 'message' | 'resets'>) =>
      serial(async () => {
        // **一覧はもう先読みしない。** `writeOne` が {@link writeLock} の中で
        // 読み直す（あちらの doc）——ここで読むと、その時点で古くなりうる。
        const settings = await stores.tokens.readSettings();
        return writeOne(input.id, (token) =>
          markTokenUnusable(token, {
            at: now().toISOString(),
            message: input.message,
            ...(input.resets === undefined ? {} : { resets: input.resets }),
            fallbackCooldownMs: settings.cooldownMs,
          }),
        );
      }),

    noteUsable: (id: string) =>
      serial(async () => writeOne(id, (token) => markTokenUsable(token, now().toISOString()))),

    setSettings: (patch: { rotateOn?: TokenRotationPolicy; cooldownMs?: number }) =>
      serial(async () => {
        const updatedAt = now().toISOString();
        let next: TokenRotationSettings;
        try {
          const current = await stores.tokens.readSettings();
          next = {
            rotateOn: patch.rotateOn ?? current.rotateOn,
            cooldownMs: patch.cooldownMs ?? current.cooldownMs,
            updatedAt,
          };
        } catch (error) {
          // **読めない現在値は、両方が揃った patch でしか埋められない**
          // （issue #2053）。`rotateOn` か `cooldownMs` の片方だけの patch では
          // 埋める元（現在値）が読めないので、投げたまま呼び出し側へ返す——
          // 呼び出し側（`PUT /tokens/policy`）は 500 として理由を返す。
          if (
            !(error instanceof UnreadableTokenSettingsError) ||
            patch.rotateOn === undefined ||
            patch.cooldownMs === undefined
          ) {
            throw error;
          }
          next = { rotateOn: patch.rotateOn, cooldownMs: patch.cooldownMs, updatedAt };
        }
        const written = await stores.tokens.writeSettings(next);
        // **設定も契機である。** `off` → `free_exhausted` へ戻した瞬間に、
        // 止まったまま溜まっていた状態を見直せなければ、人間は**設定を戻した後
        // さらに待たされる**（次の観測が上がるまで）。
        announceChange('settings');
        return written;
      }),
  };
}
