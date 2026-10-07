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

// JSON に包まず素のシェルスクリプトで持つ: 包むと人間が `vi` で直せなくなるため
// `memory/` には置かない: クローンのシステムプロンプトへ鍵が載るため
export class FsProfileStore implements ProfileStore {
  readonly #legacyPath: string;
  readonly #dir: string;
  // 移行を1本に並べる: 同時の `list` が二重に移さないため
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
      // 人間が置いたファイルも検査する: 名前がそのままパスの一部になるため
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
    // 読めない・3語以外の中身も `all` として読む: 綴り違いで一覧ごと失敗すると、直すための書き込みも止まるため
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
        return;
      }
      const script = await readFile(this.#legacyPath, 'utf8');
      // 新しい側を優先する: 人間が移行後に直した値を、旧ファイルで巻き戻さないため
      if (script.trim().length > 0 && !(await this.#exists(this.#scriptPath('default')))) {
        await this.#writeRow('default', script, 'all', info.mtime);
      }
      await rm(this.#legacyPath, { force: true });
    });
    // 失敗しても列は止めない: 次の `list` が挑み直せるように
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
    // 撒く先を先に書く: 本文が先だと、巻き戻しの途中で新しい本文が前の撒く先で届く窓が開くため
    if (scope === 'all') await rm(this.#scopePath(name), { force: true });
    else await writeFileAtomic(this.#scopePath(name), `${scope}\n`, { mode: 0o600 });
    // ここで改行を足さない: 読み直したときの指紋が書いたときの指紋と変わるため
    await writeFileAtomic(this.#scriptPath(name), script, { mode: 0o600 });
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
    // 隣のファイルも消す: 残すと、同じ名前で別の本文を置いたとき古い撒く先が黙って効くため
    await rm(this.#scopePath(name), { force: true });
    return existed;
  }

  async replaceAll(previous: readonly EnvProfileEntry[]): Promise<void> {
    // mtime も戻す: 本文だけ戻すと、成功していない更新が最後の変更として表示されるため
    for (const row of previous) assertProfileRowWritable(row);
    const keep = new Set(previous.map((row) => row.name));
    for (const row of await this.#readAll()) {
      if (!keep.has(row.name)) await this.remove(row.name);
    }
    for (const row of previous) {
      await this.#writeRow(row.name, row.script, row.scope, new Date(row.updatedAt));
    }
  }

  async clear(): Promise<number> {
    const count = (await this.list()).length;
    await rm(this.#dir, { recursive: true, force: true });
    await rm(this.#legacyPath, { force: true });
    return count;
  }
}
