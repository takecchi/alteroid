import {
  fingerprintOf,
  normalizeProfileScript,
  type ProfileApplier,
  type ProfileApplyResult,
} from './profile.js';
import type { RunnerProfileResult } from './runner-protocol.js';
import type { RunnerRegistry } from './runner-protocol.js';
import type { Stores } from './store.js';

/**
 * 実行環境プロファイルを**置いて配る**までの1本道。
 *
 * **人間の口（`PUT /profile`）とクローンの道具（`profile_write`）で同じものを通す。**
 * 別々に書くと、片方だけに検査が入って「人間が置くと弾かれるのにクローンが置くと
 * 通る」が生まれる。ここは境界（伏せる鍵が残っていないか）を確かめる場所なので、
 * 経路が2本あること自体が穴になる。
 *
 * 順序には理由がある:
 *
 * 1. **先に評価する。** 読めないものを記憶ストアへ残すと、以後の再接続のたびに
 *    配布が失敗し続け、器を作り直した瞬間に環境が黙って痩せる
 * 2. **次に保存する。** ここまで来たものは「読める」と分かっている
 * 3. **最後に配る。** runner は記憶ストアを読めないので、降ろすのはこちらの責任
 */
export interface ApplyProfileInput {
  stores: Stores;
  /** クローン側の器。保存の前に「読めるか」を確かめる唯一の場所でもある。 */
  profile?: ProfileApplier;
  /** 委譲先。無ければ配布はしない（保存はする）。 */
  runners?: RunnerRegistry;
  /** 人間が書いたシェルスクリプト。空文字は「プロファイルを外す」。 */
  script: string;
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

export async function applyEnvProfile(input: ApplyProfileInput): Promise<ApplyProfileResult> {
  const { stores, profile, runners } = input;
  // **入口で形を決める。** 保存・配布・指紋が同じ文字列を見ないと、置いた指紋と
  // 読んだ指紋が食い違い、届いているかを見る道具が嘘をつく。
  const script = normalizeProfileScript(input.script);

  const clone: ProfileApplyResult =
    profile === undefined
      ? { ok: true }
      : await profile.apply(script).catch((error: unknown) => ({
          ok: false,
          error: String(error),
        }));

  // 読めないものは保存も配布もしない（前のものが残る）。
  if (!clone.ok) return { stored: false, clone, runners: [] };

  const stored = await stores.profile.write(script);

  const results =
    runners === undefined
      ? []
      : await Promise.all(
          (await runners.list()).map(async (runner) => {
            try {
              return { runnerId: runner.runnerId, ...(await runner.setProfile(script)) };
            } catch (error) {
              return { runnerId: runner.runnerId, ok: false, error: String(error) };
            }
          }),
        );

  return {
    stored: true,
    updatedAt: stored.updatedAt,
    // **指紋は本文から直に取る。** 器の有無で出たり出なかったりすると、
    // 「届いているか」を突き合わせる手段が構成によって消える。
    ...(script.length === 0
      ? {}
      : { sha256: fingerprintOf(script), bytes: Buffer.byteLength(script) }),
    clone,
    runners: results,
  };
}
