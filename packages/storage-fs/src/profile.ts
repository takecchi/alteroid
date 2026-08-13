import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, stat, readFile, utimes, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { EnvProfile, ProfileStore } from '@alteroid/core';

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
 */
export class FsProfileStore implements ProfileStore {
  readonly #path: string;

  constructor(path: string) {
    this.#path = path;
  }

  async read(): Promise<EnvProfile | null> {
    try {
      const [script, info] = await Promise.all([readFile(this.#path, 'utf8'), stat(this.#path)]);
      if (script.trim().length === 0) return null;
      return { script, updatedAt: info.mtime.toISOString() };
    } catch {
      return null;
    }
  }

  async write(script: string): Promise<EnvProfile> {
    const at = new Date().toISOString();
    if (script.trim().length === 0) {
      await rm(this.#path, { force: true });
      return { script: '', updatedAt: at };
    }

    await mkdir(dirname(this.#path), { recursive: true });
    // **呼び出しごとに一意にする。** 固定名だと、重なった書き込みで片方の rename の
    // 後にもう片方が ENOENT で落ちたり、意図と違う本文が rename されたりする。
    // 上位（`ProfileService`）が直列化しているが、置き場の側だけを見ても壊れない
    // 形にしておく（守りを1枚に寄せない）。
    const staging = `${this.#path}.${randomUUID().slice(0, 8)}`;
    // **受け取ったものをそのまま書く。** ここで改行を足すと、読み直したときの
    // 指紋が書いたときの指紋と変わり、「届いているか」を見る道具が嘘をつく
    // （形を決めるのは入口の `normalizeProfileScript` ただ1か所）。
    await writeFile(staging, script, { encoding: 'utf8', mode: 0o600 });
    try {
      await rename(staging, this.#path);
    } catch (error) {
      await rm(staging, { force: true }).catch(() => undefined);
      throw error;
    }
    return { script, updatedAt: at };
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
      return;
    }
    await this.write(previous.script);
    const at = new Date(previous.updatedAt);
    await utimes(this.#path, at, at);
  }
}
