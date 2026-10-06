import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { DEFAULT_ATTACHMENT_LIMITS, type AttachmentStore } from '@alteroid/core';
import { FsAttachmentStore } from '@alteroid/storage-fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';
import { checkAndBindAttachments } from './attachment-batch.js';

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

let dir: string;
beforeEach(async () => {
  dir = await makeTempDir('alteroid-attachment-batch-');
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/**
 * `bind` が部分的に結んだあとで**例外**を投げる（置き場の I/O の失敗。fs の `#bindTo` は id を1つずつ結ぶので、
 * 途中の id で EIO などが出うる。#3592）。例外の時点では `newlyBound` が呼び手に届かないので、「この呼びで結んだ分は
 * 残さない」はストアの側が持つ（契約）。ここでは本物の fs ストアを、2つ目の id の meta.json をディレクトリに
 * 差し替えて壊し（読むと EISDIR）、`checkAndBindAttachments` を通して測る。外部イベントの id は呼びごとに
 * 新しいので、結び付けが残ると、同じ添付で送り直しても `attachment_conflict` で永久に断られる。
 */
describe('checkAndBindAttachments: bind が途中で例外を投げた回は、結び付け残さない', () => {
  it('外部イベント: 例外で落ちた回の後、同じ添付を新しいイベントに付け直せる', async () => {
    const real = new FsAttachmentStore(join(dir, 'attachments'));
    const a = await real.put({ name: 'a.png', mediaType: 'image/png', bytes: PNG });
    const b = await real.put({ name: 'b.png', mediaType: 'image/png', bytes: PNG });
    const event = (store: AttachmentStore, eventId: string) =>
      checkAndBindAttachments([a.id, b.id], {
        store,
        limits: DEFAULT_ATTACHMENT_LIMITS,
        bind: (ids) => store.bindToExternalEvent(ids, eventId),
        unbind: (ids) => store.unbind(ids, { externalEventId: eventId }),
        isBoundElsewhere: (meta) =>
          meta.conversationId !== undefined || meta.externalEventId !== undefined,
        conflictMessage: 'すでに別の宛先に結び付いた添付は使えない',
      });
    // 検査（getMeta）は通り、`bind` の中で、1つ目を結んだあと2つ目の読み出しで置き場が壊れる
    // （検査の後で b の meta.json をディレクトリへ差し替える）。
    const brokenPath = join(dir, 'attachments', b.id, 'meta.json');
    const original = await readFile(brokenPath);
    const flaky = {
      getMeta: (id: string) => real.getMeta(id),
      unbind: (ids: readonly string[], target: Parameters<AttachmentStore['unbind']>[1]) =>
        real.unbind(ids, target),
      bindToExternalEvent: async (ids: readonly string[], eventId: string) => {
        await rm(brokenPath);
        await mkdir(brokenPath);
        return real.bindToExternalEvent(ids, eventId);
      },
    } as unknown as AttachmentStore;
    await expect(event(flaky, 'event-1')).rejects.toMatchObject({ code: 'EISDIR' }); // 500。イベントは投函されない
    // 置き場が直ったあと、呼び手が同じ添付で送り直す。
    await rm(brokenPath, { recursive: true });
    await writeFile(brokenPath, original);
    const retry = await event(real, 'event-2');
    expect(retry.ok).toBe(true);
  });
});
