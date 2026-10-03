import { mkdir, rm, stat, readFile, utimes } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { EnvProfile, EnvProfileScope, ProfileStore } from '@alteroid/core';

import { writeFileAtomic } from './atomic.js';

/**
 * 実行環境プロファイルの置き場（既定 `~/.alteroid/profile.sh`）。
 *
 * **素のシェルスクリプト1本にしてある。** 記憶が素の Markdown なのと同じ理由で、
 * 人間がいつでも `vi` で開いて直せることが最短の実装だからである。JSON に
 * 包むと「読める」が「直せる」でなくなる。
 *
 * `memory/` には置かない。記憶は人格であり、こちらは鍵と `PATH` の話である。
 * 混ぜるとクローンのシステムプロンプトへ鍵が載る。
 *
 * 0600 で持つ。中身は人間が置いた鍵そのものになりうる。
 *
 * ## 撒く先（`scope`）は隣のファイルに置く（2026-10-03）
 *
 * **`profile.sh` は素のシェルスクリプトのまま保つ**（上の「`vi` で直せる」約束）。
 * JSON に包む・先頭に印を足す、はこの約束を壊すので、撒く先は `<path>.scope`
 * （既定なら `profile.sh.scope`。中身は `all` / `app` / `runner` の1語）へ分ける。
 *
 * - **無ければ `all`**（この欄が無かった頃に置かれたものは実際に両方へ撒かれていた）。
 * - **読めない・3語のどれでもない中身も `all` として読む**（手で書き換えた
 *   綴り違いで `read()` ごと失敗すると、直すための `profile set` も前の版を読めずに
 *   止まる。pg 版が列の既定で `all` に落ちるのと同じ向き。**狭めた意図が広がる向きに
 *   倒れうる**のは承知のうえで、次の `write` が必ず正しい1語で書き直すので居座らない）。
 * - **外す（空の write / `clear` / `revert(null)`）ときは隣のファイルも消す。**
 *   残すと、次に別の本文を置いたとき古い撒く先が黙って効く。
 * - **2ファイルは同時には書けない**ので、scope を先に書いてから本文を書く
 *   （本文が先だと、巻き戻しの途中で「新しい本文が前の撒く先で」届く窓が開く）。
 */
export class FsProfileStore implements ProfileStore {
  readonly #path: string;
  readonly #scopePath: string;

  constructor(path: string) {
    this.#path = path;
    this.#scopePath = `${path}.scope`;
  }

  async read(): Promise<EnvProfile | null> {
    try {
      const [script, info] = await Promise.all([readFile(this.#path, 'utf8'), stat(this.#path)]);
      if (script.trim().length === 0) return null;
      return { script, updatedAt: info.mtime.toISOString(), scope: await this.#readScope() };
    } catch {
      return null;
    }
  }

  async #readScope(): Promise<EnvProfileScope> {
    try {
      const raw = (await readFile(this.#scopePath, 'utf8')).trim();
      return raw === 'app' || raw === 'runner' ? raw : 'all';
    } catch {
      return 'all';
    }
  }

  async write(script: string, scope: EnvProfileScope = 'all'): Promise<EnvProfile> {
    const at = new Date().toISOString();
    if (script.trim().length === 0) {
      await rm(this.#path, { force: true });
      await rm(this.#scopePath, { force: true });
      return { script: '', updatedAt: at, scope: 'all' };
    }

    await mkdir(dirname(this.#path), { recursive: true });
    // **`writeFileAtomic`（`atomic.ts`）に括り出した。** ここが先例だった
    // （呼び出しごとに一意な staging 名、rename 失敗時の `rm` 後始末）——
    // 同じ形が `commitments.ts` 等9箇所に散っていたので共有関数へ寄せた
    // （issue #1050）。**受け取ったものをそのまま書く約束は変わらない。**
    // ここで改行を足すと、読み直したときの指紋が書いたときの指紋と変わり、
    // 「届いているか」を見る道具が嘘をつく（形を決めるのは入口の
    // `normalizeProfileScript` ただ1か所）。**mode 0600 も変わらない。**
    // 撒く先を先に書く（クラスの doc）。`all` は「無い」と同じなので置かない。
    if (scope === 'all') await rm(this.#scopePath, { force: true });
    else await writeFileAtomic(this.#scopePath, `${scope}\n`, { mode: 0o600 });
    await writeFileAtomic(this.#path, script, { mode: 0o600 });
    return { script, updatedAt: at, scope };
  }

  /**
   * 取り消した更新をなかったことにする。
   *
   * **mtime も戻す。** ここは `read()` が `updatedAt` として返す値であり、
   * 人間が `profile status` で見る「最後に本文を変えた時刻」である。本文だけ戻して
   * 時刻を進めると、成功していない更新が最後の変更として表示される。
   */
  async revert(previous: EnvProfile | null): Promise<void> {
    if (previous === null) {
      await rm(this.#path, { force: true });
      await rm(this.#scopePath, { force: true });
      return;
    }
    await this.write(previous.script, previous.scope);
    const at = new Date(previous.updatedAt);
    await utimes(this.#path, at, at);
  }

  /** 外す（`ProfileStore.clear` の doc）。 */
  async clear(): Promise<number> {
    const existed = (await this.read()) !== null;
    await rm(this.#path, { force: true });
    await rm(this.#scopePath, { force: true });
    return existed ? 1 : 0;
  }
}
