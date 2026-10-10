import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

import {
  assertNoNul,
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

// 読めなくても投げず `null` を返し、跡だけ残す: 投げるとクローンの起動そのものが止まるため
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

// 素の `writeFile` ではなく `writeFileAtomic` で書く: truncate してから書くので、途中で読む側が切れた JSON を見るため
// `setCloneSessionId` / `setProjectKey` を `withPathLock` で囲まない: 全置換で読んでから書く隙が無く、lock ファイルが増えるだけのため。
// 墓標2つの set だけはロックの中で書く: `clear…If` が同じパスのロックの中で読んで消すので、判定と `rm` の間に新しい墓標が消えるため
export class FsSessionRegistry implements SessionRegistry {
  readonly #dir: string;
  readonly #path: string;
  // 墓標は別のファイルに置く: `setCloneSessionId(null)` が `session.json` を丸ごと消すので、同居させると墓標も消えるため
  readonly #gravePath: string;
  // 別のファイルに置く: `#gravePath` と同時に立ちうるうえ、`#path` と同居すると `setCloneSessionId(null)` で消えるため
  readonly #lostSessionPath: string;
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
    if (sessionId !== null) assertNoNul('session.cloneSessionId', sessionId);
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

  /** `clearTranscriptGraveIf` と同じロックの中で書く（理由はそちらの doc）。 */
  async setTranscriptGrave(grave: TranscriptGrave | null): Promise<void> {
    await withPathLock(this.#gravePath, async () => {
      if (grave === null) {
        await rm(this.#gravePath, { force: true });
        return;
      }
      await mkdir(this.#dir, { recursive: true });
      await writeFileAtomic(this.#gravePath, `${JSON.stringify(grave)}\n`);
    });
  }

  async clearTranscriptGraveIf(archiveId: string): Promise<boolean> {
    return withPathLock(this.#gravePath, async () => {
      // 読みをロックの外へ出さない: `get` → 比較 → `set` と同じになり、判定と書き込みの間に割り込まれるため
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

  /** `clearLostSessionGraveIf` と同じロックの中で書く。 */
  async setLostSessionGrave(grave: LostSessionGrave | null): Promise<void> {
    await withPathLock(this.#lostSessionPath, async () => {
      if (grave === null) {
        await rm(this.#lostSessionPath, { force: true });
        return;
      }
      await mkdir(this.#dir, { recursive: true });
      await writeFileAtomic(this.#lostSessionPath, `${JSON.stringify(grave)}\n`);
    });
  }

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
    assertNoNul('session.projectKey', projectKey);
    await mkdir(this.#dir, { recursive: true });
    await writeFileAtomic(this.#projectKeyPath, `${JSON.stringify({ projectKey })}\n`);
  }

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
