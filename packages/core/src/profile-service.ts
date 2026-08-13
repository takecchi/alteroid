import {
  fingerprintOf,
  normalizeProfileScript,
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

        const clone: ProfileApplyResult =
          applier === undefined
            ? { ok: true }
            : await applier.apply(normalized).catch((error: unknown) => ({
                ok: false,
                error: String(error),
              }));

        // 読めないものは保存も配布もしない（前のものが残る）。
        if (!clone.ok) return { stored: false, clone, runners: [] };

        const stored = await stores.profile.write(normalized);
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
