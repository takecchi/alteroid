import { mkdir, readdir, readFile, rm, stat, utimes } from 'node:fs/promises';
import { join } from 'node:path';

import {
  assertProfileRowWritable,
  compareProfileEntryNames,
  PROFILE_ENTRY_NAME,
  type EnvProfileEntry,
  type EnvProfileScope,
  type ProfileStore,
} from '@alteroid/core';

import { writeFileAtomic } from './atomic.js';

/**
 * 実行環境プロファイルの置き場（既定 `~/.alteroid/profile.d/`）。
 *
 * **`/etc/profile.d` と同じ形にしてある。** 1行 ＝ 1ファイル `<name>.sh`（0600、**素の
 * シェルスクリプトのまま**）。記憶が素の Markdown なのと同じ理由で、人間がいつでも
 * `vi` で開いて直せることが最短の実装だからである。JSON に包むと「読める」が
 * 「直せる」でなくなる。つなげる順番は名前のコード単位順（`core` の
 * `composeProfileScript`）。
 *
 * `memory/` には置かない。記憶は人格であり、こちらは鍵と `PATH` の話である。
 * 混ぜるとクローンのシステムプロンプトへ鍵が載る。
 *
 * ## 撒く先（`scope`）は隣のファイルに置く
 *
 * 撒く先は `<name>.scope`（中身は `all` / `app` / `runner` の1語）へ分ける。
 * 先頭に印を足す・JSON に包む、は「`vi` で直せる」約束を壊す。
 *
 * - **無ければ `all`**。
 * - **読めない・3語のどれでもない中身も `all` として読む**（手で書き換えた綴り違いで
 *   一覧ごと失敗すると、直すための書き込みも前の版を読めずに止まる。pg 版が列の
 *   既定で `all` に落ちるのと同じ向き。**狭めた意図が広がる向きに倒れうる**のは
 *   承知のうえで、次の `set` が必ず正しい1語で書き直すので居座らない）。
 * - **行を外すときは隣のファイルも消す。** 残すと、同じ名前で別の本文を置いたとき
 *   古い撒く先が黙って効く。
 * - **2ファイルは同時には書けない**ので、撒く先を先に書いてから本文を書く
 *   （本文が先だと、巻き戻しの途中で「新しい本文が前の撒く先で」届く窓が開く）。
 *
 * ## 旧 `profile.sh`（1本の時代）の扱い
 *
 * 旧形式の `profile.sh` があれば、**読み出し（`list`）のときに `default` 行へ移す**
 * （本文と mtime をそのまま `profile.d/default.sh` へ。撒く先は `all`）。
 * 先に新しいファイルを原子的に書いてから旧ファイルを消すので、途中で落ちても
 * 本文は失われない（次の `list` が、`default.sh` が既に在れば旧ファイルを捨てるだけで
 * 終える。**新しい側を優先する** — 人間が移行後に直した値を、旧ファイルで巻き戻さない）。
 */
export class FsProfileStore implements ProfileStore {
  readonly #legacyPath: string;
  readonly #dir: string;
  /** 旧ファイルの移行を1本に並べる（同時の `list` が二重に移さない）。 */
  #migrating: Promise<void> = Promise.resolve();

  constructor(legacyPath: string, dir: string) {
    this.#legacyPath = legacyPath;
    this.#dir = dir;
  }

  #scriptPath(name: string): string {
    return join(this.#dir, `${name}.sh`);
  }

  #scopePath(name: string): string {
    return join(this.#dir, `${name}.scope`);
  }

  async list(): Promise<EnvProfileEntry[]> {
    await this.#migrateLegacy();
    return this.#readAll();
  }

  async #readAll(): Promise<EnvProfileEntry[]> {
    let files: string[];
    try {
      files = await readdir(this.#dir);
    } catch {
      return [];
    }
    const rows: EnvProfileEntry[] = [];
    for (const file of files) {
      if (!file.endsWith('.sh')) continue;
      const name = file.slice(0, -'.sh'.length);
      // **人間が置いたファイルも検査する**（名前がそのままパスの一部になる）。
      if (!PROFILE_ENTRY_NAME.test(name)) continue;
      try {
        const [script, info] = await Promise.all([
          readFile(this.#scriptPath(name), 'utf8'),
          stat(this.#scriptPath(name)),
        ]);
        if (script.trim().length === 0) continue;
        rows.push({
          name,
          script,
          scope: await this.#readScope(name),
          updatedAt: info.mtime.toISOString(),
        });
      } catch {
        // 読めない1ファイルで一覧ごと落とさない。
      }
    }
    return rows.sort((a, b) => compareProfileEntryNames(a.name, b.name));
  }

  async #readScope(name: string): Promise<EnvProfileScope> {
    try {
      const raw = (await readFile(this.#scopePath(name), 'utf8')).trim();
      return raw === 'app' || raw === 'runner' ? raw : 'all';
    } catch {
      return 'all';
    }
  }

  #migrateLegacy(): Promise<void> {
    const next = this.#migrating.then(async () => {
      let info;
      try {
        info = await stat(this.#legacyPath);
      } catch {
        return; // 旧ファイルは無い（普通の状態）
      }
      const script = await readFile(this.#legacyPath, 'utf8');
      if (script.trim().length > 0 && !(await this.#exists(this.#scriptPath('default')))) {
        await this.#writeRow('default', script, 'all', info.mtime);
      }
      await rm(this.#legacyPath, { force: true });
    });
    // 失敗しても列は止めない（次の `list` が挑み直す）。失敗は呼び出し側へ返す。
    this.#migrating = next.catch(() => undefined);
    return next;
  }

  async #exists(path: string): Promise<boolean> {
    try {
      await stat(path);
      return true;
    } catch {
      return false;
    }
  }

  async #writeRow(name: string, script: string, scope: EnvProfileScope, at: Date): Promise<void> {
    await mkdir(this.#dir, { recursive: true });
    // 撒く先を先に書く（クラスの doc）。`all` は「無い」と同じなので置かない。
    if (scope === 'all') await rm(this.#scopePath(name), { force: true });
    else await writeFileAtomic(this.#scopePath(name), `${scope}\n`, { mode: 0o600 });
    // 受け取ったものをそのまま書く（ここで改行を足すと、読み直したときの指紋が
    // 書いたときの指紋と変わる。形を決めるのは入口だけ）。mode は 0600。
    await writeFileAtomic(this.#scriptPath(name), script, { mode: 0o600 });
    // mtime を `updatedAt` として持つので、決めた時刻に揃える。
    await utimes(this.#scriptPath(name), at, at);
  }

  async set(name: string, script: string, scope: EnvProfileScope): Promise<EnvProfileEntry> {
    assertProfileRowWritable({ name, script });
    await this.#migrateLegacy();
    const at = new Date();
    await this.#writeRow(name, script, scope, at);
    return { name, script, scope, updatedAt: at.toISOString() };
  }

  async remove(name: string): Promise<boolean> {
    await this.#migrateLegacy();
    const existed = await this.#exists(this.#scriptPath(name));
    await rm(this.#scriptPath(name), { force: true });
    await rm(this.#scopePath(name), { force: true });
    return existed;
  }

  /**
   * 取り消した更新をなかったことにする。
   *
   * **mtime も戻す。** ここは `list()` が `updatedAt` として返す値であり、人間が
   * `profile status` で見る「最後に本文を変えた時刻」である。本文だけ戻して時刻を
   * 進めると、成功していない更新が最後の変更として表示される。
   */
  async replaceAll(previous: readonly EnvProfileEntry[]): Promise<void> {
    for (const row of previous) assertProfileRowWritable(row);
    const keep = new Set(previous.map((row) => row.name));
    for (const row of await this.#readAll()) {
      if (!keep.has(row.name)) await this.remove(row.name);
    }
    for (const row of previous) {
      await this.#writeRow(row.name, row.script, row.scope, new Date(row.updatedAt));
    }
  }

  /** 外す（`ProfileStore.clear` の doc）。 */
  async clear(): Promise<number> {
    const count = (await this.list()).length;
    await rm(this.#dir, { recursive: true, force: true });
    await rm(this.#legacyPath, { force: true });
    return count;
  }
}
