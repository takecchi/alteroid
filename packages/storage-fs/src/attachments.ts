import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import {
  ATTACHMENT_UNBOUND_TTL_MS,
  AttachmentStreamMeter,
  collectAttachmentStream,
  planAttachmentStream,
  prepareStreamedAttachment,
  addToAttachmentUsage,
  assertNoNul,
  attachmentBindTargetLabel,
  canBindAttachmentTo,
  emptyAttachmentUsage,
  matchesAttachmentListQuery,
  pageAttachmentMetas,
  isAttachmentBound,
  isAttachmentBoundTo,
  isAttachmentExpired,
  hasNul,
  isAttachmentPrunable,
  prepareAttachment,
  reasonOf,
  readAttachmentLimits,
  withAttachmentKept,
  type AttachmentBindResult,
  type AttachmentBindTarget,
  type AttachmentListPage,
  type AttachmentListQuery,
  type AttachmentMeta,
  type AttachmentUsage,
  type AttachmentPutInput,
  type AttachmentPutStreamInput,
  type AttachmentStore,
  type AttachmentStoreOptions,
} from '@alteroid/core';
import { z } from 'zod';

import { writeFileAtomic } from './atomic.js';
import { withPathLock } from './file-lock.js';

const META_FILE = 'meta.json';
const DATA_FILE = 'data';

// UUID 以外の形は「無い」と答える: `../` でディレクトリの外へ出さないため
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const metaSchema = z.object({
  id: z.string(),
  name: z.string(),
  mediaType: z.string(),
  size: z.number().int().nonnegative(),
  sha256: z.string(),
  conversationId: z.string().optional(),
  externalEventId: z.string().optional(),
  managerReportId: z.string().optional(),
  uploadedBy: z.string().optional(),
  createdAt: z.string(),
  // 保存中（keptAt あり）は期限を持たない。どちらも無い meta は壊れたものとして「無い」と扱う（期限なしで残り続けないため）
  expiresAt: z.string().optional(),
  keptAt: z.string().optional(),
  releasedAt: z.string().optional(),
});

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
    const {
      conversationId,
      externalEventId,
      managerReportId,
      expiresAt,
      keptAt,
      releasedAt,
      ...rest
    } = parsed.data;
    if (expiresAt === undefined && keptAt === undefined) return undefined;
    return {
      ...rest,
      ...(conversationId === undefined ? {} : { conversationId }),
      ...(externalEventId === undefined ? {} : { externalEventId }),
      ...(managerReportId === undefined ? {} : { managerReportId }),
      ...(expiresAt === undefined ? {} : { expiresAt }),
      ...(keptAt === undefined ? {} : { keptAt }),
      ...(releasedAt === undefined ? {} : { releasedAt }),
    };
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
      // meta.json を最後に置く: 途中で落ちた残骸を「預かった」と数えないため
      await writeFileAtomic(join(dir, META_FILE), `${JSON.stringify(meta)}\n`, { mode: 0o600 });
    } catch (error) {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
    return meta;
  }

  /**
   * 流して預ける（#4128 段1）。tmp へ書きながら大きさと sha256 を数え、上限を超えたら読むのを止めて tmp ごと消す。
   * 画像は先頭の見た目と寸法の検査に中身が要るので、上限つきで集めて `put` へ渡す（画像の上限は小さい）。
   */
  async putStream(input: AttachmentPutStreamInput): Promise<AttachmentMeta> {
    const limits = this.#options.limits ?? readAttachmentLimits().limits;
    const plan = planAttachmentStream(input, limits);
    const { body, ...rest } = input;
    if (plan.image) {
      return this.put({ ...rest, bytes: await collectAttachmentStream(body, plan) });
    }
    const id = randomUUID();
    const dir = join(this.#dir, id);
    await mkdir(dir, { recursive: true });
    try {
      const meter = new AttachmentStreamMeter(plan);
      const tmp = join(dir, `${DATA_FILE}.tmp.${process.pid}.${randomUUID().slice(0, 8)}`);
      await pipeline(
        body,
        async function* (source: AsyncIterable<Uint8Array>) {
          for await (const chunk of source) {
            meter.write(chunk);
            yield chunk;
          }
        },
        createWriteStream(tmp, { mode: 0o600 }),
      );
      const done = meter.finish();
      const meta: AttachmentMeta = {
        ...prepareStreamedAttachment(
          input,
          plan,
          done,
          limits,
          this.#options.now?.() ?? new Date(),
        ),
        id,
      };
      await rename(tmp, join(dir, DATA_FILE));
      // meta.json を最後に置く: 途中で落ちた残骸を「預かった」と数えないため
      await writeFileAtomic(join(dir, META_FILE), `${JSON.stringify(meta)}\n`, { mode: 0o600 });
      return meta;
    } catch (error) {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  /** `get` と同じ判定（排他は `get` と同じく取らない。消えていれば `undefined`）。 */
  async open(id: string): Promise<{ meta: AttachmentMeta; stream: Readable } | undefined> {
    const dir = this.#idDir(id);
    if (dir === undefined) return undefined;
    const meta = await this.#readLiveMeta(dir);
    if (meta === undefined) return undefined;
    const path = join(dir, DATA_FILE);
    try {
      // 開いて存在を確かめてから返す（get の ENOENT → undefined と揃える）
      await stat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    return { meta, stream: createReadStream(path) };
  }

  async get(id: string): Promise<{ meta: AttachmentMeta; bytes: Uint8Array } | undefined> {
    const dir = this.#idDir(id);
    if (dir === undefined) return undefined;
    const meta = await this.#readLiveMeta(dir);
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
    return dir === undefined ? undefined : this.#readLiveMeta(dir);
  }

  async #readLiveMeta(dir: string): Promise<AttachmentMeta | undefined> {
    const meta = await this.#readMeta(dir);
    const now = this.#options.now?.() ?? new Date();
    return meta === undefined || isAttachmentExpired(meta, now) ? undefined : meta;
  }

  async bind(ids: readonly string[], conversationId: string): Promise<AttachmentBindResult> {
    assertNoNul('conversationId', conversationId);
    return this.#bindTo(ids, { conversationId });
  }

  async bindToExternalEvent(
    ids: readonly string[],
    eventId: string,
  ): Promise<AttachmentBindResult> {
    assertNoNul('eventId', eventId);
    return this.#bindTo(ids, { externalEventId: eventId });
  }

  async bindToManagerReport(
    ids: readonly string[],
    reportId: string,
  ): Promise<AttachmentBindResult> {
    assertNoNul('reportId', reportId);
    return this.#bindTo(ids, { managerReportId: reportId });
  }

  async #bindTo(
    ids: readonly string[],
    target: AttachmentBindTarget,
  ): Promise<AttachmentBindResult> {
    const bound: string[] = [];
    const newlyBound: string[] = [];
    const missing: string[] = [];
    const conflicts: string[] = [];
    try {
      await this.#bindEach(ids, target, { bound, newlyBound, missing, conflicts });
    } catch (error) {
      // この呼びで新しく結んだ分だけ戻して投げ直す: 呼び手には結果が届かず、先に結んだ分が結び付いたまま残るため
      await this.unbind(newlyBound, target).catch((rollbackError: unknown) => {
        process.stderr.write(
          `alteroidd: 添付の結び付けを戻せなかった（${attachmentBindTargetLabel(target)}へ結んだ ${newlyBound.length} 件が残る）: ${reasonOf(rollbackError)}\n`,
        );
      });
      throw error;
    }
    return { bound, newlyBound, missing, conflicts };
  }

  async #bindEach(
    ids: readonly string[],
    target: AttachmentBindTarget,
    out: { bound: string[]; newlyBound: string[]; missing: string[]; conflicts: string[] },
  ): Promise<void> {
    const { bound, newlyBound, missing, conflicts } = out;
    for (const id of ids) {
      const dir = this.#idDir(id);
      if (dir === undefined) {
        missing.push(id);
        continue;
      }
      try {
        // `createDir: false`: 無い id のロックのために空のディレクトリを作らないため
        const outcome = await withPathLock(
          join(dir, META_FILE),
          async () => {
            const meta = await this.#readLiveMeta(dir);
            if (meta === undefined) return 'missing' as const;
            if (!canBindAttachmentTo(meta, target)) return 'conflict' as const;
            if (!isAttachmentBound(meta)) {
              await writeFileAtomic(
                join(dir, META_FILE),
                `${JSON.stringify({ ...meta, ...target })}\n`,
                { mode: 0o600 },
              );
              return 'newly' as const;
            }
            return 'bound' as const;
          },
          { createDir: false },
        );
        if (outcome === 'newly') newlyBound.push(id);
        (outcome === 'bound' || outcome === 'newly'
          ? bound
          : outcome === 'conflict'
            ? conflicts
            : missing
        ).push(id);
      } catch (error) {
        // ENOENT は「無い」と同じ: 掃除が先にディレクトリごと消したため
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        missing.push(id);
      }
    }
  }

  async unbind(ids: readonly string[], target: AttachmentBindTarget): Promise<string[]> {
    const unbound: string[] = [];
    for (const id of new Set(ids)) {
      const dir = this.#idDir(id);
      if (dir === undefined) continue;
      try {
        const done = await withPathLock(
          join(dir, META_FILE),
          async () => {
            const meta = await this.#readMeta(dir);
            if (meta === undefined || !isAttachmentBoundTo(meta, target)) return false;
            const rest: { -readonly [K in keyof AttachmentMeta]: AttachmentMeta[K] } = { ...meta };
            delete rest.conversationId;
            delete rest.externalEventId;
            delete rest.managerReportId;
            await writeFileAtomic(join(dir, META_FILE), `${JSON.stringify(rest)}\n`, {
              mode: 0o600,
            });
            return true;
          },
          { createDir: false },
        );
        if (done) unbound.push(id);
      } catch (error) {
        // ENOENT は戻すものが無いのと同じ: 掃除が先にディレクトリごと消したため
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    return unbound;
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
    const failures: string[] = [];
    for (const name of names) {
      if (!ID_PATTERN.test(name)) continue;
      const dir = join(this.#dir, name);
      try {
        const meta = await this.#readMeta(dir);
        // 更新時刻はロックを取る前に見る: ロックファイルを置くとディレクトリの更新時刻が進むため
        const staleOrphan = meta === undefined && (await this.#isStaleOrphan(dir, now));
        if (meta === undefined ? !staleOrphan : !isAttachmentPrunable(meta, now)) continue;
        // ロックの中で判定し直す: 外で読んだあとに `bind` が通っても、結び付けた直後の添付を消さないため
        const removed = await withPathLock(
          join(dir, META_FILE),
          async () => {
            const latest = await this.#readMeta(dir);
            if (latest === undefined ? !staleOrphan : !isAttachmentPrunable(latest, now))
              return false;
            await rm(dir, { recursive: true, force: true });
            return true;
          },
          { createDir: false },
        );
        if (removed) count += 1;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        failures.push(`${name}: ${reasonOf(error)}`);
      }
    }
    if (failures.length > 0) {
      process.stderr.write(
        `alteroidd: 添付ファイルの掃除で ${failures.length} 件を消せなかった: ${failures.join('; ')}\n`,
      );
    }
    return count;
  }

  async setKept(id: string, kept: boolean, now: Date): Promise<AttachmentMeta | undefined> {
    const dir = this.#idDir(id);
    if (dir === undefined) return undefined;
    try {
      return await withPathLock(
        join(dir, META_FILE),
        async () => {
          const meta = await this.#readMeta(dir);
          if (meta === undefined || isAttachmentExpired(meta, now)) return undefined;
          const limits = this.#options.limits ?? readAttachmentLimits().limits;
          const next = withAttachmentKept(meta, kept, now, limits);
          if (next === meta) return meta;
          await writeFileAtomic(join(dir, META_FILE), `${JSON.stringify(next)}\n`, {
            mode: 0o600,
          });
          return next;
        },
        { createDir: false },
      );
    } catch (error) {
      // ENOENT は「無い」と同じ: 掃除・削除が先にディレクトリごと消したため
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  async remove(id: string): Promise<boolean> {
    const dir = this.#idDir(id);
    if (dir === undefined) return false;
    try {
      return await withPathLock(
        join(dir, META_FILE),
        async () => {
          const meta = await this.#readMeta(dir);
          await rm(dir, { recursive: true, force: true });
          return meta !== undefined && !isAttachmentExpired(meta, this.#now());
        },
        { createDir: false },
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }

  async list(query: AttachmentListQuery): Promise<AttachmentListPage> {
    const metas = (await this.#readAllLive()).filter((meta) =>
      matchesAttachmentListQuery(meta, query),
    );
    return pageAttachmentMetas(metas, query);
  }

  async usage(): Promise<AttachmentUsage> {
    const usage = emptyAttachmentUsage();
    for (const meta of await this.#readAllLive()) addToAttachmentUsage(usage, meta);
    return usage;
  }

  async clear(): Promise<number> {
    const names = await this.#idDirNames();
    let count = 0;
    for (const name of names) {
      await rm(join(this.#dir, name), { recursive: true, force: true });
      count += 1;
    }
    return count;
  }

  #now(): Date {
    return this.#options.now?.() ?? new Date();
  }

  async #idDirNames(): Promise<string[]> {
    try {
      return (await readdir(this.#dir)).filter((name) => ID_PATTERN.test(name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  /** 期限内の控えを全部読む（meta.json だけ。中身の `data` は読まない）。 */
  async #readAllLive(): Promise<AttachmentMeta[]> {
    const metas: AttachmentMeta[] = [];
    for (const name of await this.#idDirNames()) {
      const meta = await this.#readLiveMeta(join(this.#dir, name));
      if (meta !== undefined) metas.push(meta);
    }
    return metas;
  }

  async #isStaleOrphan(dir: string, now: Date): Promise<boolean> {
    const info = await stat(dir).catch(() => undefined);
    return info !== undefined && info.mtimeMs + ATTACHMENT_UNBOUND_TTL_MS <= now.getTime();
  }
}
