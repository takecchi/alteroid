import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { TranscriptArchive } from '@alteroid/core';

/**
 * セッション生ログの退避先（可観測性3層の最下段）。
 *
 * PreCompact フックで要約に潰される直前の全文をここへ落とす。人間が後から追う
 * ための用途にセッション本体を太らせ続けない（architecture.md「寿命モデル」）。
 */
export class FsTranscriptArchive implements TranscriptArchive {
  readonly #dir: string;

  constructor(dir: string) {
    this.#dir = dir;
  }

  async archive(sessionId: string, transcript: string): Promise<string> {
    await mkdir(this.#dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const name = `${sanitize(sessionId)}-${stamp}.jsonl`;
    await writeFile(join(this.#dir, name), transcript, 'utf8');
    return name;
  }

  async list(): Promise<string[]> {
    try {
      return (await readdir(this.#dir))
        .filter((n) => n.endsWith('.jsonl'))
        .sort()
        .reverse();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  async read(id: string): Promise<string | null> {
    if (sanitize(id) !== id) return null;
    try {
      return await readFile(join(this.#dir, id), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }
}

function sanitize(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_');
}
