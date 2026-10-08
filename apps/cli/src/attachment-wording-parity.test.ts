import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  AttachmentRejectedError,
  validateAttachmentBatch,
  validateAttachmentInput,
} from '@alteroid/core';
import { checkAttachments } from '@alteroid/logic';
import { describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';
import { AttachmentDraft } from './attachments.js';

// 同じ理由の断りは、サーバ・Web の送る前の検査・CLI と TUI の送る前の検査で同じ文になる（#3933）。
const MIB = 1024 * 1024;
const LIMITS = {
  maxImageBytes: 5 * MIB,
  maxFileBytes: 25 * MIB,
  maxPerMessage: 3,
  maxTotalBytes: 30 * MIB,
  retentionDays: 1,
};

function serverReason(run: () => void): string {
  try {
    run();
  } catch (error) {
    if (error instanceof AttachmentRejectedError) return error.message;
    throw error;
  }
  throw new Error('断られなかった');
}

describe('添付の断りの文は3か所で同じ', () => {
  const sizes = [5 * MIB + 1, 5 * MIB + 52_428, 5 * MIB + 52_429, 6 * MIB];
  it.each(sizes)('画像 %i バイト', async (size) => {
    const dir = await makeTempDir('alteroid-cli-wording-');
    const path = join(dir, 'a.png');
    await writeFile(path, Buffer.alloc(size));
    const png = new Uint8Array(size);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const server = serverReason(() =>
      validateAttachmentInput({ name: 'a.png', mediaType: 'image/png', bytes: png }, LIMITS),
    );
    const web = checkAttachments([], [{ name: 'a.png', size, type: 'image/png' }], LIMITS)
      .rejected[0]?.reason;
    const cli = await new AttachmentDraft(LIMITS).add(path);
    expect(web).toBe(server);
    expect(cli.ok ? '' : cli.reason).toBe(`a.png: ${server}`);
  });

  it('ファイル 25 MiB + 1', async () => {
    const size = 25 * MIB + 1;
    const dir = await makeTempDir('alteroid-cli-wording-');
    const path = join(dir, 'a.bin');
    await writeFile(path, Buffer.alloc(size));
    const server = serverReason(() =>
      validateAttachmentInput(
        { name: 'a.bin', mediaType: 'application/octet-stream', bytes: new Uint8Array(size) },
        LIMITS,
      ),
    );
    const web = checkAttachments(
      [],
      [{ name: 'a.bin', size, type: 'application/octet-stream' }],
      LIMITS,
    ).rejected[0]?.reason;
    const cli = await new AttachmentDraft(LIMITS).add(path);
    expect(server).toBe('ファイルは 1 つ 25 MiB まで（26,214,401 バイトある）');
    expect(web).toBe(server);
    expect(cli.ok ? '' : cli.reason).toBe(`a.bin: ${server}`);
  });

  it('個数', async () => {
    const dir = await makeTempDir('alteroid-cli-wording-');
    const path = join(dir, 'a.txt');
    await writeFile(path, 'x');
    const server = serverReason(() => validateAttachmentBatch([1, 1, 1, 1], LIMITS));
    const file = { name: 'a.txt', size: 1, type: 'text/plain' };
    const web = checkAttachments([file, file, file], [file], LIMITS).rejected[0]?.reason;
    const draft = new AttachmentDraft(LIMITS);
    for (let i = 0; i < 3; i += 1) expect((await draft.add(path)).ok).toBe(true);
    const cli = await draft.add(path);
    expect(server).toBe('1 発言に添えられるのは 3 個まで（4 個）');
    expect(web).toBe(server);
    expect(cli.ok ? '' : cli.reason).toBe(server);
  });

  it('合計', async () => {
    const dir = await makeTempDir('alteroid-cli-wording-');
    const path = join(dir, 'a.bin');
    await writeFile(path, Buffer.alloc(20 * MIB));
    const server = serverReason(() => validateAttachmentBatch([20 * MIB, 11 * MIB], LIMITS));
    const file = (size: number) => ({ name: 'a.bin', size, type: 'application/octet-stream' });
    const web = checkAttachments([file(20 * MIB)], [file(11 * MIB)], LIMITS).rejected[0]?.reason;
    const draft = new AttachmentDraft(LIMITS);
    expect((await draft.add(path)).ok).toBe(true);
    const big = join(dir, 'b.bin');
    await writeFile(big, Buffer.alloc(11 * MIB));
    const cli = await draft.add(big);
    expect(server).toBe('1 発言の合計は 30 MiB まで（31.0 MiB ある）');
    expect(web).toBe(server);
    expect(cli.ok ? '' : cli.reason).toBe(server);
  });
});
