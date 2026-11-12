import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';
import { sha256Hex } from './auth.js';
import type { AttachmentMeta, AttachmentStore } from './attachment.js';
import { fetchAttachmentCopy } from './attachment-fetch.js';

// 書き込み先の open を「一時ファイルの rm が済むまで」遅らせて、負荷時に起きる順序（pipeline の reject → rm → open の完了）を決定的に作る。
// 掃除が書き込み先の close を待つ実装だと rm は open のあとにしか呼ばれないので、回数上限つきの譲りで open を通す（実時間の待ちではない）
const hooks = vi.hoisted(() => ({
  releaseOpen: undefined as undefined | (() => void),
  opened: undefined as undefined | Promise<void>,
  markOpened: undefined as undefined | (() => void),
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    createWriteStream: ((path: string, options: object) => {
      const gate = new Promise<void>((resolve) => {
        hooks.releaseOpen = resolve;
      });
      hooks.opened = new Promise<void>((resolve) => {
        hooks.markOpened = resolve;
      });
      const delayed = (async () => {
        for (let turn = 0; turn < 20_000; turn += 1) {
          const released = await Promise.race([
            gate.then(() => true),
            new Promise<boolean>((resolve) => setImmediate(() => resolve(false))),
          ]);
          if (released) return;
        }
      })();
      return actual.createWriteStream(path, {
        ...options,
        fs: {
          ...actual,
          open: (
            p: string,
            flags: string,
            mode: number,
            cb: (err: NodeJS.ErrnoException | null, fd: number) => void,
          ) => {
            void delayed.then(() => {
              actual.open(p, flags, mode, (err, fd) => {
                cb(err, fd);
                hooks.markOpened?.();
              });
            });
          },
        },
      } as never);
    }) as typeof actual.createWriteStream,
  };
});

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    rm: (async (...args: Parameters<typeof actual.rm>) => {
      const result = await actual.rm(...args);
      hooks.releaseOpen?.();
      return result;
    }) as typeof actual.rm,
  };
});

afterEach(() => {
  hooks.releaseOpen = undefined;
  hooks.opened = undefined;
  hooks.markOpened = undefined;
});

describe('attachment_fetch: 流れが落ちたときの一時ファイル（#6674）', () => {
  it('書き込み先の open が済む前に流れが落ちても、投げ返したあとに 0 バイトの .tmp が現れない', async () => {
    const dir = await makeTempDir('alteroid-fetch-tmp-');
    const meta: AttachmentMeta = {
      id: 'abc',
      name: 'a.txt',
      mediaType: 'text/plain',
      size: 1,
      sha256: sha256Hex(Uint8Array.from([1])),
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 1e9).toISOString(),
    };
    const stream = new Readable({
      read() {
        this.destroy(new Error('boom'));
      },
    });
    const attachments = { open: async () => ({ meta, stream }) } as unknown as AttachmentStore;
    await expect(fetchAttachmentCopy({ attachments }, dir, 'abc')).rejects.toThrow('boom');
    await hooks.opened;
    expect(await readdir(join(dir, 'abc'))).toEqual([]);
  });
});
