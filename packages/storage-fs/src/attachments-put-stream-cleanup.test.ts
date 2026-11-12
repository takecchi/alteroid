import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';
import { FsAttachmentStore } from './attachments.js';

// 書き込み先の open を「掃除の rm が呼ばれるまで」遅らせて、負荷時に起きる順序（pipeline の reject → rm → open の完了）を決定的に作る。
// 掃除が書き込み先の close を待つ実装だと rm は open のあとにしか呼ばれないので、回数上限つきの譲りで open を通す（実時間の待ちではない）。
// rm が呼ばれた時点で open が済んでいたかを残し、済んでいなければ rm をすり抜けて 0 バイトの一時ファイルが残る順序だった、と判定する
const hooks = vi.hoisted(() => ({
  releaseOpen: undefined as undefined | (() => void),
  opened: false,
  openedAtRm: [] as boolean[],
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    createWriteStream: ((path: string, options: object) => {
      const gate = new Promise<void>((resolve) => {
        hooks.releaseOpen = resolve;
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
                hooks.opened = true;
                cb(err, fd);
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
      hooks.openedAtRm.push(hooks.opened);
      hooks.releaseOpen?.();
      return actual.rm(...args);
    }) as typeof actual.rm,
  };
});

afterEach(() => {
  hooks.releaseOpen = undefined;
  hooks.opened = false;
  hooks.openedAtRm = [];
});

describe('FsAttachmentStore.putStream: 流れが落ちたときの一時ファイル（#6674 と同じ順序）', () => {
  it('書き込み先の open が済む前に流れが落ちても、掃除は書き込み先が開いて閉じてから行う', async () => {
    const root = await makeTempDir('alteroid-put-stream-tmp-');
    const store = new FsAttachmentStore(join(root, 'attachments'));
    const body = (async function* () {
      yield new Uint8Array();
      throw new Error('boom');
    })();
    await expect(store.putStream({ name: 'a.txt', mediaType: 'text/plain', body })).rejects.toThrow(
      'boom',
    );
    expect(hooks.openedAtRm).toEqual([true]);
    expect(await readdir(join(root, 'attachments'))).toEqual([]);
  });
});
