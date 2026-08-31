import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { SessionRegistry, TranscriptGrave } from '@alteroid/core';
import { z } from 'zod';

const stateSchema = z.object({ cloneSessionId: z.string().nullable().default(null) });
const graveSchema = z.object({ archiveId: z.string().min(1) });

/**
 * クローンのセッション id の置き場。
 *
 * これは「同一性の置き場」ではない。同一性は記憶に宿る（architecture.md
 * 「寿命モデル」）。ここにあるのは resume を試みるための再開素材にすぎず、
 * 失われてもクローンは記憶から再構成される。
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

  constructor(dir: string) {
    this.#dir = dir;
    this.#path = join(dir, 'session.json');
    this.#gravePath = join(dir, 'transcript-grave.json');
  }

  async getCloneSessionId(): Promise<string | null> {
    try {
      const raw = await readFile(this.#path, 'utf8');
      return stateSchema.parse(JSON.parse(raw)).cloneSessionId;
    } catch {
      return null;
    }
  }

  async setCloneSessionId(sessionId: string | null): Promise<void> {
    if (sessionId === null) {
      await rm(this.#path, { force: true });
      return;
    }
    await mkdir(this.#dir, { recursive: true });
    await writeFile(this.#path, `${JSON.stringify({ cloneSessionId: sessionId })}\n`, 'utf8');
  }

  async getTranscriptGrave(): Promise<TranscriptGrave | null> {
    try {
      return graveSchema.parse(JSON.parse(await readFile(this.#gravePath, 'utf8')));
    } catch {
      return null;
    }
  }

  async setTranscriptGrave(grave: TranscriptGrave | null): Promise<void> {
    if (grave === null) {
      await rm(this.#gravePath, { force: true });
      return;
    }
    await mkdir(this.#dir, { recursive: true });
    await writeFile(this.#gravePath, `${JSON.stringify(grave)}\n`, 'utf8');
  }
}
