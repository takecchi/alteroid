import {
  fingerprintOf,
  normalizeProfileScript,
  type PreparedProfile,
  type ProfileApplier,
  type ProfileApplyResult,
} from './profile.js';
import type { RunnerClient, RunnerProfileResult, RunnerRegistry } from './runner-protocol.js';
import type { EnvProfile, Stores } from './store.js';

/**
 * 実行環境プロファイルを**置いて配る**までの1本道。
 *
 * ## なぜ「1本道」でなければならないか
 *
 * 更新は3段ある（① クローンの器へ commit ② 記憶ストアへ保存 ③ 各 runner へ配布）。
 * これを直列化しないと、**同時に2つ更新が入ったときに層ごとに違う本文が残る**。
 *
 *     A が ① → B が ①②③ → A が ②③   ⇒ クローン=B、ストア/runner=A
 *
 * どちらの呼び出しも成功を返すのに、これから起こすクローンの子と runner の仕事で
 * 環境が違い、デーモンを再起動するとストアの A へ突然戻る。鍵の更新なら「同じ時点
 * から仕事ごとに違う資格情報を使う」状態になり、しかも指紋を見ても食い違いの理由が
 * 分からない（3つとも「置けた」と答える）。
 *
 * **人間の口（`PUT /profile`）とクローンの道具（`profile_write`）を同じ経路に
 * 寄せた結果、この同時更新は現実に起きる。** クローンは自律ターン（時間起点・発意）
 * からも動くので、人間が `alteroid profile edit` している最中にクローンが書くことは
 * 普通に起こりうる。
 *
 * ## 2人目の書き手も同じ列に入れる
 *
 * runner が名乗り直したときの降ろし直し（`ManagerPool` の再接続処理）も、runner へ
 * 書く操作である。更新の最中に走ると、**古い本文を読んで新しい本文を上書きする**。
 * だから `syncRunner` もこの列を通す。
 *
 * **後勝ちにするが、1更新の全段が終わってから次を始める。** 途中で混ざらないこと
 * だけを保証すればよく、順番を決める仕組みは要らない（人間が最後に書いたものが
 * 残る、が素直な意味である）。
 */
export interface ProfileService {
  /** いま保存されている本文。 */
  read(): Promise<EnvProfile | null>;
  /**
   * 差し替える。**評価 → 保存 → 配布までを1つの区間として直列に行う。**
   * 空文字は「プロファイルを外す」。
   */
  apply(script: string): Promise<ApplyProfileResult>;
  /**
   * 保存済みの本文を、クローンの器へ**効かせ直す**（デーモンの起動時）。
   *
   * **記憶ストアへは書かない。** 起動しただけで `updatedAt` が動くと、`profile
   * status` や `GET /profile` が見せる「更新」が「最後にデーモンを起こした時刻」に
   * なり、人間かクローンが最後に本文を変えた時刻という意味が失われる（本文を一度も
   * 変えていなくても監査情報が消える）。
   *
   * 置かれていなければ null。
   */
  restore(): Promise<ProfileApplyResult | null>;
  /**
   * 1台の runner へ、いま保存されている本文を降ろし直す。
   *
   * **runner は記憶ストアを読めない**ので、器が作り直されたときに降ろすのはこちら
   * の責任である。既に同じものが載っていれば何もしない（再接続のたびに人間の
   * 書いたスクリプトを評価し直さない）。
   */
  syncRunner(runner: RunnerClient): Promise<RunnerProfileResult | null>;
}

export interface ProfileServiceOptions {
  stores: Stores;
  /** クローン側の器。保存の前に「読めるか」を確かめる唯一の場所でもある。 */
  applier?: ProfileApplier;
  /** 委譲先。無ければ配布はしない（保存はする）。 */
  runners?: RunnerRegistry;
}

export interface ApplyProfileResult {
  /** 保存できたか。**読めなかったときは保存もしていない。** */
  stored: boolean;
  updatedAt?: string;
  sha256?: string;
  bytes?: number;
  /** クローン（デーモン自身）への反映結果。 */
  clone: ProfileApplyResult;
  /** 各 runner への配布結果。 */
  runners: (RunnerProfileResult & { runnerId: string })[];
}

export function createProfileService(options: ProfileServiceOptions): ProfileService {
  const { stores, applier, runners } = options;

  /**
   * 直列化の実体。**次の更新は前の更新の全段が終わってから始まる。**
   *
   * 前の失敗で列が止まらないように、常に解決する形で繋ぐ（失敗は呼び出し側へ
   * 返るので、列に残す必要は無い）。
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
    read: () => stores.profile.read(),

    apply: (script: string) =>
      serial(async () => {
        // **入口で形を決める。** 保存・配布・指紋が同じ文字列を見ないと、置いた
        // 指紋と読んだ指紋が食い違い、届いているかを見る道具が嘘をつく。
        const normalized = normalizeProfileScript(script);
        // 途中で落ちたときに戻す先。**この列の中でしか更新は起きない**ので、
        // ここで読んだものが「直前の版」であることが保証されている。
        const previous = await stores.profile.read();

        /**
         * **評価 → 正本へ保存 → 反映、の順に分ける。**
         *
         * 評価と反映を1つにしていた頃は、記憶ストアへの保存が落ちると
         * 「クローンだけが新しい本文を持つ」状態が残った。保存できていない ＝
         * 誰も成功と言っていない更新を、これから起こすクローンの子だけが使う、
         * という一番たちの悪い分裂である（しかも再起動するとストアの古い値へ戻る）。
         *
         * 正本は記憶ストアで、クローンの器はそこから導かれるもの、という向きに
         * 揃える。そのうえで、**どの段で落ちても最後には旧版で揃える**:
         *
         * - 評価で落ちた: 保存も反映もしない
         * - 保存で落ちた: 用意したものを捨てる
         * - 反映で落ちた: 正本を書き戻す（戻せなければ、その事実を理由つきで投げる）
         *
         * 「失敗を返したのに、どこか1層だけ新版」を残さないことが要点である。
         * 残すと、次に runner が名乗った時点で `syncRunner` がそれを配り、
         * 分裂が黙って広がる。
         */
        const prepared: PreparedProfile | null =
          applier === undefined
            ? null
            : await applier.prepare(normalized).catch((error: unknown): PreparedProfile => ({
                ok: false,
                error: String(error),
                commit: async () => undefined,
                discard: async () => undefined,
              }));

        // 呼び出し側へ返すのは「結果」だけ（`commit` / `discard` は器の都合）。
        const clone: ProfileApplyResult =
          prepared === null
            ? { ok: true }
            : {
                ok: prepared.ok,
                ...(prepared.profile === undefined ? {} : { profile: prepared.profile }),
                ...(prepared.error === undefined ? {} : { error: prepared.error }),
                ...(prepared.output === undefined ? {} : { output: prepared.output }),
                ...(prepared.names === undefined ? {} : { names: prepared.names }),
              };

        // 読めないものは保存も配布もしない（前のものが残る）。
        if (prepared !== null && !prepared.ok) {
          await prepared.discard();
          return { stored: false, clone, runners: [] };
        }

        let stored;
        try {
          stored = await stores.profile.write(normalized);
        } catch (error) {
          // **正本へ書けなかったものは、クローンにも効かせない。** ここで捨てないと、
          // 呼び出し側が失敗を受け取ったのにクローンだけが新しい本文で走る。
          await prepared?.discard();
          throw error;
        }

        // ここから先は「保存できた」が確定している。器へ移す。
        try {
          await prepared?.commit();
        } catch (error) {
          /**
           * **正本を書き戻す。**
           *
           * ここで戻さないと、失敗を返したのに正本だけが新版という状態が残る。
           * しかもそれは黙って広がる — 次に runner が名乗れば `syncRunner` が
           * 正本を読んで新版を配るので、今度は「クローンだけ旧版」という別の
           * 分裂になる。デーモンを起こし直しても、器の不調が続いていれば収束しない。
           *
           * **戻す先は確定している。** 更新はこの列の中でしか起きないので、
           * 読んだときの本文が「直前の版」であることが保証されている。
           */
          await prepared?.discard();
          try {
            // **本文と更新日時を組で戻す。** `write` で戻すと本文は元に戻っても
            // `updatedAt` が失敗した時刻へ進み、成功していない更新が「最後の変更」
            // として `profile status` に出る（起動のたびに動いていたのと同じ壊れ方）。
            await stores.profile.revert(previous);
          } catch (rollbackError) {
            // **黙って握り潰さない。** ここまで来ると正本＝新版・クローン＝旧版が
            // 残るので、人間が手で直せるように両方の理由を出す。
            // `cause` は直近で捕まえたもの（書き戻しの失敗）。反映の失敗は本文に
            // 残してあるので、どちらも失われない。
            throw new Error(
              'プロファイルをクローンへ反映できず、正本を書き戻すこともできなかった' +
                `（正本だけ新版のまま残っている）: 反映=${String(error)} / 書き戻し=${String(rollbackError)}`,
              { cause: rollbackError },
            );
          }
          throw new Error(
            `プロファイルをクローンへ反映できなかったので、正本も元へ戻した: ${String(error)}`,
            { cause: error },
          );
        }

        const results = await pushAll(normalized);

        return {
          stored: true,
          updatedAt: stored.updatedAt,
          // **指紋は本文から直に取る。** 器の有無で出たり出なかったりすると、
          // 「届いているか」を突き合わせる手段が構成によって消える。
          ...(normalized.length === 0
            ? {}
            : { sha256: fingerprintOf(normalized), bytes: Buffer.byteLength(normalized) }),
          clone,
          runners: results,
        };
      }),

    restore: () =>
      serial(async () => {
        const stored = await stores.profile.read();
        if (stored === null || applier === undefined) return null;
        // 記憶ストアには書かない（`updatedAt` は本文を変えた人のものである）。
        return applier.apply(normalizeProfileScript(stored.script));
      }),

    syncRunner: (runner: RunnerClient) =>
      serial(async () => {
        const stored = await stores.profile.read();
        const script = stored?.script ?? '';

        // 既に同じものが載っていれば触らない。
        const current = await runner.profile().catch(() => undefined);
        const same =
          script.length === 0 ? current === undefined : current?.sha256 === fingerprintOf(script);
        if (same) return null;

        return runner.setProfile(script);
      }),
  };

  async function pushAll(script: string): Promise<(RunnerProfileResult & { runnerId: string })[]> {
    if (runners === undefined) return [];
    return Promise.all(
      (await runners.list()).map(async (runner) => {
        try {
          return { runnerId: runner.runnerId, ...(await runner.setProfile(script)) };
        } catch (error) {
          return { runnerId: runner.runnerId, ok: false, error: String(error) };
        }
      }),
    );
  }
}
