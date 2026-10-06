import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  ATTACHMENT_UNBOUND_TTL_MS,
  assertNoNul,
  canBindAttachmentTo,
  isAttachmentBoundTo,
  isAttachmentExpired,
  hasNul,
  isAttachmentPrunable,
  prepareAttachment,
  reasonOf,
  readAttachmentLimits,
  type AttachmentBindResult,
  type AttachmentBindTarget,
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
  externalEventId: z.string().optional(),
  uploadedBy: z.string().optional(),
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
    const { conversationId, externalEventId, ...rest } = parsed.data;
    return {
      ...rest,
      ...(conversationId === undefined ? {} : { conversationId }),
      ...(externalEventId === undefined ? {} : { externalEventId }),
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

  /** 期限を過ぎたものは、prune が走る前でも「無い」（#3522）。prune と bind は期限切れも読む（`#readMeta`）。 */
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
      // 途中の id で ENOENT 以外の I/O 例外が出た。id を1つずつ結ぶので、先に結んだ分が結び付いたまま残る。
      // 呼び手には結果が届かず `newlyBound` を知れないので、ここで「この呼びで新しく結んだ分」だけを戻す
      // （すでに結んであった id は `newlyBound` に入っていない。#3592）。戻しも落ちたら、戻せなかったことを
      // stderr へ1行残し（件数・宛先の種類・理由だけ。名前や中身は出さない）、元の例外を投げ直す
      // （原因は元の例外。戻せなかった分はその宛先に残る）。
      await this.unbind(newlyBound, target).catch((rollbackError: unknown) => {
        process.stderr.write(
          `alteroidd: 添付の結び付けを戻せなかった（${'conversationId' in target ? '会話' : '外部イベント'}へ結んだ ${newlyBound.length} 件が残る）: ${reasonOf(rollbackError)}\n`,
        );
      });
      throw error;
    }
    return { bound, newlyBound, missing, conflicts };
  }

  /** `#bindTo` の本体。途中で投げたとき、それまでに結んだ分は `out.newlyBound` に残る（戻すのは呼び手）。 */
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
        const outcome = await withPathLock(join(dir, META_FILE), async () => {
          const meta = await this.#readLiveMeta(dir);
          if (meta === undefined) return 'missing' as const;
          if (!canBindAttachmentTo(meta, target)) return 'conflict' as const;
          // 同じ宛先に結び付いている（冪等）なら書き直さない。
          if (meta.conversationId === undefined && meta.externalEventId === undefined) {
            await writeFileAtomic(
              join(dir, META_FILE),
              `${JSON.stringify({ ...meta, ...target })}\n`,
              { mode: 0o600 },
            );
            return 'newly' as const;
          }
          return 'bound' as const;
        });
        if (outcome === 'newly') newlyBound.push(id);
        (outcome === 'bound' || outcome === 'newly'
          ? bound
          : outcome === 'conflict'
            ? conflicts
            : missing
        ).push(id);
      } catch (error) {
        // 掃除が先にディレクトリごと消した（ロックファイルを置けない）。「無い」と同じ。
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
        const done = await withPathLock(join(dir, META_FILE), async () => {
          const meta = await this.#readMeta(dir);
          if (meta === undefined || !isAttachmentBoundTo(meta, target)) return false;
          const rest: { -readonly [K in keyof AttachmentMeta]: AttachmentMeta[K] } = { ...meta };
          delete rest.conversationId;
          delete rest.externalEventId;
          await writeFileAtomic(join(dir, META_FILE), `${JSON.stringify(rest)}\n`, { mode: 0o600 });
          return true;
        });
        if (done) unbound.push(id);
      } catch (error) {
        // 掃除が先にディレクトリごと消した。戻すものが無いのと同じ。
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    return unbound;
  }

  /**
   * 掃除。**判定と `rm` は `bind` / `unbind` と同じロック（meta.json）の中で行い、ロックを取ってから
   * 判定し直す**——外で読んだあとに `bind` が通っても、結び付けた直後の添付を消さない。ディレクトリごとに
   * 失敗を受け止めて次へ進む（1件の `rm` の失敗で周回を止めない）。戻り値は消せた件数。
   */
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
        // 先に外で読み、消す気の無いものはロックを取らずに飛ばす。消す側はロックの中で判定し直す。
        const meta = await this.#readMeta(dir);
        // 控えの無い（書きかけ・壊れた）ディレクトリは、作ってから1時間たったら片付ける。
        // 更新時刻はロックを取る前に見る（ロックファイルを置くとディレクトリの更新時刻が進むため）。
        const staleOrphan = meta === undefined && (await this.#isStaleOrphan(dir, now));
        if (meta === undefined ? !staleOrphan : !isAttachmentPrunable(meta, now)) continue;
        const removed = await withPathLock(join(dir, META_FILE), async () => {
          const latest = await this.#readMeta(dir);
          if (latest === undefined ? !staleOrphan : !isAttachmentPrunable(latest, now))
            return false;
          await rm(dir, { recursive: true, force: true });
          return true;
        });
        if (removed) count += 1;
      } catch (error) {
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

  async #isStaleOrphan(dir: string, now: Date): Promise<boolean> {
    const info = await stat(dir).catch(() => undefined);
    return info !== undefined && info.mtimeMs + ATTACHMENT_UNBOUND_TTL_MS <= now.getTime();
  }
}
