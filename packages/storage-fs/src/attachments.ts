import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  ATTACHMENT_UNBOUND_TTL_MS,
  assertNoNul,
  hasNul,
  isAttachmentPrunable,
  prepareAttachment,
  readAttachmentLimits,
  type AttachmentBindResult,
  type AttachmentMeta,
  type AttachmentPutInput,
  type AttachmentStore,
  type AttachmentStoreOptions,
} from '@alteroid/core';
import { z } from 'zod';

import { writeFileAtomic } from './atomic.js';
import { withPathLock } from './file-lock.js';

const META_FILE = 'meta.json';
const DATA_FILE = 'data';

/** core が払い出す id は UUID。**これ以外の形は「無い」と答える**（`../` でディレクトリの外へ出さない）。 */
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const metaSchema = z.object({
  id: z.string(),
  name: z.string(),
  mediaType: z.string(),
  size: z.number().int().nonnegative(),
  sha256: z.string(),
  conversationId: z.string().optional(),
  createdAt: z.string(),
  expiresAt: z.string(),
});

/**
 * 添付ファイルの置き場（fs。#3111 段1a）。契約は `packages/core/src/attachment-contract.ts`。
 *
 * 配置は `<dir>/<id>/meta.json`（控え）と `<dir>/<id>/data`（中身）。**`meta.json` が在って初めて
 * 「預かった」と数える**——中身を先に置いて控えを最後に rename するので、途中で落ちた残骸は
 * 控えの無いディレクトリになり、`prune` が1時間後に片付ける。`getMeta` は `data` を読まない。
 */
export class FsAttachmentStore implements AttachmentStore {
  readonly #dir: string;
  readonly #options: AttachmentStoreOptions;

  constructor(dir: string, options: AttachmentStoreOptions = {}) {
    this.#dir = dir;
    this.#options = options;
  }

  #idDir(id: string): string | undefined {
    return hasNul(id) || !ID_PATTERN.test(id) ? undefined : join(this.#dir, id);
  }

  async #readMeta(dir: string): Promise<AttachmentMeta | undefined> {
    let raw: string;
    try {
      raw = await readFile(join(dir, META_FILE), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return undefined;
    }
    const parsed = metaSchema.safeParse(json);
    if (!parsed.success) return undefined;
    const { conversationId, ...rest } = parsed.data;
    return { ...rest, ...(conversationId === undefined ? {} : { conversationId }) };
  }

  async put(input: AttachmentPutInput): Promise<AttachmentMeta> {
    const limits = this.#options.limits ?? readAttachmentLimits().limits;
    const meta = prepareAttachment(input, limits, this.#options.now?.() ?? new Date());
    const dir = join(this.#dir, meta.id);
    await mkdir(dir, { recursive: true });
    try {
      const tmp = join(dir, `${DATA_FILE}.tmp.${process.pid}.${randomUUID().slice(0, 8)}`);
      await writeFile(tmp, input.bytes, { mode: 0o600 });
      await rename(tmp, join(dir, DATA_FILE));
      await writeFileAtomic(join(dir, META_FILE), `${JSON.stringify(meta)}\n`, { mode: 0o600 });
    } catch (error) {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
    return meta;
  }

  async get(id: string): Promise<{ meta: AttachmentMeta; bytes: Uint8Array } | undefined> {
    const dir = this.#idDir(id);
    if (dir === undefined) return undefined;
    const meta = await this.#readMeta(dir);
    if (meta === undefined) return undefined;
    try {
      return { meta, bytes: new Uint8Array(await readFile(join(dir, DATA_FILE))) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  async getMeta(id: string): Promise<AttachmentMeta | undefined> {
    const dir = this.#idDir(id);
    return dir === undefined ? undefined : this.#readMeta(dir);
  }

  async bind(ids: readonly string[], conversationId: string): Promise<AttachmentBindResult> {
    assertNoNul('conversationId', conversationId);
    const bound: string[] = [];
    const missing: string[] = [];
    const conflicts: string[] = [];
    for (const id of ids) {
      const dir = this.#idDir(id);
      if (dir === undefined) {
        missing.push(id);
        continue;
      }
      try {
        const outcome = await withPathLock(join(dir, META_FILE), async () => {
          const meta = await this.#readMeta(dir);
          if (meta === undefined) return 'missing' as const;
          if (meta.conversationId !== undefined && meta.conversationId !== conversationId) {
            return 'conflict' as const;
          }
          if (meta.conversationId === undefined) {
            await writeFileAtomic(
              join(dir, META_FILE),
              `${JSON.stringify({ ...meta, conversationId })}\n`,
              { mode: 0o600 },
            );
          }
          return 'bound' as const;
        });
        (outcome === 'bound' ? bound : outcome === 'conflict' ? conflicts : missing).push(id);
      } catch (error) {
        // 掃除が先にディレクトリごと消した（ロックファイルを置けない）。「無い」と同じ。
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        missing.push(id);
      }
    }
    return { bound, missing, conflicts };
  }

  async prune(now: Date): Promise<number> {
    let names: string[];
    try {
      names = await readdir(this.#dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
      throw error;
    }
    let count = 0;
    for (const name of names) {
      if (!ID_PATTERN.test(name)) continue;
      const dir = join(this.#dir, name);
      const meta = await this.#readMeta(dir);
      if (meta === undefined) {
        // 控えの無い（書きかけ・壊れた）ディレクトリは、作ってから1時間たったら片付ける。
        const info = await stat(dir).catch(() => undefined);
        if (info === undefined || info.mtimeMs + ATTACHMENT_UNBOUND_TTL_MS > now.getTime())
          continue;
      } else if (!isAttachmentPrunable(meta, now)) {
        continue;
      }
      await rm(dir, { recursive: true, force: true });
      count += 1;
    }
    return count;
  }
}
