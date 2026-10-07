import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

import {
  PluginNameConflictError,
  isValidPluginName,
  parsePluginInput,
  parseStoredPlugin,
  pluginNamesCollide,
  pluginSummaryOf,
  sortPluginSummaries,
} from '@alteroid/core';
import type { PluginInput, PluginStore, PluginSummary, StoredPlugin } from '@alteroid/core';

import { writeFileAtomic } from './atomic.js';
import { withPathLock } from './file-lock.js';

/**
 * 人間が入れた plugin の置き場（既定 `~/.alteroid/plugins/`。#3815 土台1）。
 *
 * **1 plugin = 1つの JSON（`<name>.json`）。** 本体の files は JSON の中に base64 で持ち、
 * **ディレクトリへ展開しない**。理由は2つ: (1) 置き換えが「tmp へ書いて rename」の1回で原子的になる
 * （files のディレクトリを入れ替える形は、途中で落ちると半端な plugin が残る）。(2) files の path が
 * ファイルシステムの path にならないので、path の検査をすり抜けても置き場の外へ書けない。
 * 展開は後の段（`ALTEROID_HOME/plugins/<name>@<sha>/`）が、検査済みの値からやる。
 *
 * **0600 / ディレクトリ 0700 で持つ**（`FsMcpServerStore` と同じ考え方。plugin はコードと
 * プロンプトを持ち込むので、他のユーザーに読ませも書かせもしない）。**`memory/` には置かない**。
 *
 * **読むときにも検査する。** ファイルは手で書き換えられるので、形と `contentSha256`（files から
 * 計算し直す）を突き合わせる。**読めなければ投げる**（黙って飛ばすと「入れたのに無い」が原因の出ない
 * 形で起きる）。文言に値は載せない（JSON.parse の SyntaxError は本文の断片を含む）。
 * `remove` は中身を読まないので、壊れたものも外せる。
 */
export class FsPluginStore implements PluginStore {
  readonly #dir: string;

  constructor(dir: string) {
    this.#dir = dir;
  }

  #pathOf(name: string): string {
    return join(this.#dir, `${name}.json`);
  }

  async #readFile(name: string): Promise<StoredPlugin | null> {
    const path = this.#pathOf(name);
    let raw: string;
    try {
      raw = await readFile(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`${path} が JSON として読めない`);
    }
    try {
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('保存された plugin の形が不正');
      }
      const object = parsed as Record<string, unknown>;
      // **ファイル名と中の name が食い違うものは読まない**（別の名前になりすませない）。
      if (object.name !== name) throw new Error('ファイル名と name が食い違う');
      const files = Array.isArray(object.files)
        ? object.files.map((file: unknown) => {
            if (file === null || typeof file !== 'object') return file;
            const entry = file as Record<string, unknown>;
            return typeof entry.content === 'string'
              ? { ...entry, content: new Uint8Array(Buffer.from(entry.content, 'base64')) }
              : entry;
          })
        : object.files;
      return parseStoredPlugin({ ...object, files });
    } catch (error) {
      throw new Error(`plugin「${name}」を読めない（${path}）: ${(error as Error).message}`, {
        cause: error,
      });
    }
  }

  async list(): Promise<PluginSummary[]> {
    let entries: string[];
    try {
      entries = await readdir(this.#dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const summaries: PluginSummary[] = [];
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue;
      const name = entry.slice(0, -'.json'.length);
      // 書き込みは必ず形に合う名前で行うので、合わないファイルは人の置いたもの（読まない）。
      if (!isValidPluginName(name)) continue;
      const plugin = await this.#readFile(name);
      if (plugin !== null) summaries.push(pluginSummaryOf(plugin));
    }
    return sortPluginSummaries(summaries);
  }

  async get(name: string): Promise<StoredPlugin | null> {
    if (!isValidPluginName(name)) return null;
    return this.#readFile(name);
  }

  async put(input: PluginInput): Promise<PluginSummary> {
    // **書く前に検査する**（`PluginStore.put` の doc）。不正ならここで投げ、
    // ファイルには1バイトも触れない（前のものが残る）。
    const plugin = parsePluginInput(input);
    await withPathLock(this.#dir, async () => {
      await mkdir(this.#dir, { recursive: true, mode: 0o700 });
      for (const entry of await readdir(this.#dir)) {
        if (!entry.endsWith('.json')) continue;
        const existing = entry.slice(0, -'.json'.length);
        if (pluginNamesCollide(plugin.name, existing)) {
          throw new PluginNameConflictError(plugin.name, existing);
        }
      }
      const body = {
        ...plugin,
        files: plugin.files.map((file) => ({
          path: file.path,
          executable: file.executable,
          content: Buffer.from(file.content).toString('base64'),
        })),
      };
      // 一時ファイルの時点で 0600（`writeFileAtomic` の `mode`）。
      await writeFileAtomic(this.#pathOf(plugin.name), `${JSON.stringify(body)}\n`, {
        mode: 0o600,
      });
    });
    return pluginSummaryOf(plugin);
  }

  async remove(name: string): Promise<boolean> {
    if (!isValidPluginName(name)) return false;
    return withPathLock(
      this.#dir,
      async () => {
        const path = this.#pathOf(name);
        try {
          await readFile(path);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
          throw error;
        }
        await rm(path, { force: true });
        return true;
      },
      // 無いものを相手に空のディレクトリを作らない（#3781）。
      { createDir: false },
    ).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    });
  }
}
