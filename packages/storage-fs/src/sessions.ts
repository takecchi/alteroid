import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

import {
  noteSessionMaterialUnreadable,
  type LostSessionGrave,
  type SessionRegistry,
  type TranscriptGrave,
} from '@alteroid/core';
import { z } from 'zod';

import { writeFileAtomic } from './atomic.js';
import { withPathLock } from './file-lock.js';

const stateSchema = z.object({ cloneSessionId: z.string().nullable().default(null) });
const graveSchema = z.object({ archiveId: z.string().min(1) });
const projectKeySchema = z.object({ projectKey: z.string().min(1) });
const lostSessionSchema = z.object({
  projectKey: z.string().min(1),
  sessionId: z.string().min(1),
});

/**
 * 4つの読み手（`getCloneSessionId` 等）が共有する読み出しの形（issue #1147）。
 *
 * **「無い（`ENOENT`）」と「在ったのに読めなかった」を分ける。** 前者は正常な
 * 状態なので跡を残さず `null` を返す。後者（読み込みそのものの失敗・
 * `JSON.parse` の失敗・zod のスキーマ不一致）も `null` を返す点は変えない
 * （握り潰しをやめて例外を投げると、クローンの起動そのものが止まる——
 * `storage-pg` 側の「壊れた1行で起動を止めない」という既存の判断と揃える）
 * が、**`noteSessionMaterialUnreadable` で跡だけを残す。**
 *
 * @param path 読む先。
 * @param what 何を読もうとしたか（`noteSessionMaterialUnreadable` へそのまま渡す固定文言）。
 * @param parse 読めた本文から値を作る（`JSON.parse` + zod の検証）。ここが
 *   投げた例外も「在ったのに読めなかった」側として扱う。
 */
async function readSessionMaterial<T>(
  path: string,
  what: string,
  parse: (raw: string) => T,
): Promise<T | null> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    noteSessionMaterialUnreadable(what, error);
    return null;
  }
  try {
    return parse(raw);
  } catch (error) {
    noteSessionMaterialUnreadable(what, error);
    return null;
  }
}

/**
 * クローンのセッション id の置き場。
 *
 * これは「同一性の置き場」ではない。同一性は記憶に宿る（architecture.md
 * 「寿命モデル」）。ここにあるのは resume を試みるための再開素材にすぎず、
 * 失われてもクローンは記憶から再構成される。
 *
 * **4つの書き込み（`setCloneSessionId` / `setTranscriptGrave` /
 * `setLostSessionGrave` / `setProjectKey`）は `writeFileAtomic`（tmp へ書いて
 * `rename`）を経由する（issue #1147）。** 素の `writeFile` は宛先を truncate
 * してから書くので、書き込みの途中でその宛先を読む読み手が切れた（不正な
 * JSON の）本文を見る窓が在った。
 *
 * **`withPathLock`（`file-lock.ts`）は足していない。** 4つとも呼び出し側が
 * 渡した値で全置換するだけで、既存の内容を読んでから書き戻す
 * read-modify-write ではない——だからロックで守るべき「読んでから書くまでの
 * 間に他人が割り込む」隙が、そもそも存在しない。足しても
 * `~/.alteroid/` に要らない lock ファイルが増えるだけである（issue #1147 の
 * 「直すなら」節、決定済み）。
 */
export class FsSessionRegistry implements SessionRegistry {
  readonly #dir: string;
  readonly #path: string;
  /**
   * 墓標は**別のファイル**に置く。
   *
   * `setCloneSessionId(null)` は `session.json` を丸ごと消すので、同居させると
   * resume を捨てた瞬間に墓標も消える（`SessionRegistry` の doc）。
   */
  readonly #gravePath: string;
  /**
   * こちらも**別のファイル**である。`#gravePath` と分ける理由は同時に立ちうるからで、
   * `#path` と分ける理由は `setCloneSessionId(null)` が消すからである
   * （`SessionRegistry` の doc）。
   */
  readonly #lostSessionPath: string;
  /** ここも別のファイルである（理由は上の2つと同じ）。 */
  readonly #projectKeyPath: string;

  constructor(dir: string) {
    this.#dir = dir;
    this.#path = join(dir, 'session.json');
    this.#gravePath = join(dir, 'transcript-grave.json');
    this.#lostSessionPath = join(dir, 'lost-session-grave.json');
    this.#projectKeyPath = join(dir, 'project-key.json');
  }

  async getCloneSessionId(): Promise<string | null> {
    return readSessionMaterial(
      this.#path,
      'クローンのセッション id（session.json）',
      (raw) => stateSchema.parse(JSON.parse(raw)).cloneSessionId,
    );
  }

  async setCloneSessionId(sessionId: string | null): Promise<void> {
    if (sessionId === null) {
      await rm(this.#path, { force: true });
      return;
    }
    await mkdir(this.#dir, { recursive: true });
    await writeFileAtomic(this.#path, `${JSON.stringify({ cloneSessionId: sessionId })}\n`);
  }

  async getTranscriptGrave(): Promise<TranscriptGrave | null> {
    return readSessionMaterial(this.#gravePath, '生ログの墓標（transcript-grave.json）', (raw) =>
      graveSchema.parse(JSON.parse(raw)),
    );
  }

  async setTranscriptGrave(grave: TranscriptGrave | null): Promise<void> {
    if (grave === null) {
      await rm(this.#gravePath, { force: true });
      return;
    }
    await mkdir(this.#dir, { recursive: true });
    await writeFileAtomic(this.#gravePath, `${JSON.stringify(grave)}\n`);
  }

  /**
   * `SessionRegistry.clearTranscriptGraveIf` の doc のとおり、**読みと書きを
   * 同じ排他区間へ入れる。** `withPathLock`（`file-lock.js`。issue #1113 /
   * #1050 で足した）で囲むので、**同じディレクトリを向いた別プロセスに対しても
   * 判定と書き込みが割れない**——ただし advisory なので、ロックを見ない書き手が
   * 同じファイルを直接触れば守れない（そちらの doc）。
   *
   * ⛔ **読みをロックの外へ出さないこと。** 出した瞬間、この関数は呼び出し側で
   * `get` → 比較 → `set` と書くのと同じものになり、直そうとしていた窓が戻る。
   */
  async clearTranscriptGraveIf(archiveId: string): Promise<boolean> {
    return withPathLock(this.#gravePath, async () => {
      const current = await readSessionMaterial(
        this.#gravePath,
        '生ログの墓標（transcript-grave.json）',
        (raw) => graveSchema.parse(JSON.parse(raw)),
      );
      if (current?.archiveId !== archiveId) return false;
      await rm(this.#gravePath, { force: true });
      return true;
    });
  }

  async getLostSessionGrave(): Promise<LostSessionGrave | null> {
    return readSessionMaterial(
      this.#lostSessionPath,
      '再開素材を捨てた回の墓標（lost-session-grave.json）',
      (raw) => lostSessionSchema.parse(JSON.parse(raw)),
    );
  }

  async setLostSessionGrave(grave: LostSessionGrave | null): Promise<void> {
    if (grave === null) {
      await rm(this.#lostSessionPath, { force: true });
      return;
    }
    await mkdir(this.#dir, { recursive: true });
    await writeFileAtomic(this.#lostSessionPath, `${JSON.stringify(grave)}\n`);
  }

  /** 形と理由は {@link FsSessionRegistry.clearTranscriptGraveIf} と同じである。 */
  async clearLostSessionGraveIf(sessionId: string): Promise<boolean> {
    return withPathLock(this.#lostSessionPath, async () => {
      const current = await readSessionMaterial(
        this.#lostSessionPath,
        '再開素材を捨てた回の墓標（lost-session-grave.json）',
        (raw) => lostSessionSchema.parse(JSON.parse(raw)),
      );
      if (current?.sessionId !== sessionId) return false;
      await rm(this.#lostSessionPath, { force: true });
      return true;
    });
  }

  async getProjectKey(): Promise<string | null> {
    return readSessionMaterial(
      this.#projectKeyPath,
      'SDK が生ログを預ける scope（project-key.json）',
      (raw) => projectKeySchema.parse(JSON.parse(raw)).projectKey,
    );
  }

  async setProjectKey(projectKey: string): Promise<void> {
    await mkdir(this.#dir, { recursive: true });
    await writeFileAtomic(this.#projectKeyPath, `${JSON.stringify({ projectKey })}\n`);
  }

  /** 4つの欄を全部消す（`SessionRegistry.clear` の doc）。 */
  async clear(): Promise<number> {
    const paths = [this.#path, this.#gravePath, this.#lostSessionPath, this.#projectKeyPath];
    let removed = 0;
    for (const path of paths) {
      try {
        await rm(path);
        removed += 1;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    return removed;
  }
}
