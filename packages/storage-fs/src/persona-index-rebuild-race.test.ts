import { rm } from 'node:fs/promises';
import { join } from 'node:path';

import type { JournalStore } from '@alteroid/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

// 索引の書き込みだけを門で止める: 「write が索引を書く直前」に別の読み手が索引の組み直しを始める並びを作るため
const gate = vi.hoisted(() => ({
  holdIndexWrite: null as null | { reached: () => void; release: Promise<void> },
}));

vi.mock('./atomic.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./atomic.js')>();
  return {
    ...actual,
    writeFileAtomic: async (...args: Parameters<typeof actual.writeFileAtomic>) => {
      const hold = gate.holdIndexWrite;
      if (hold !== null && args[0].endsWith('.index.json')) {
        gate.holdIndexWrite = null;
        hold.reached();
        await hold.release;
      }
      return actual.writeFileAtomic(...args);
    },
  };
});

import { createFsStores } from './index.js';
import { FsPersonaStore } from './persona.js';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('索引の組み直しが lock の外から走り、人間が触った印を落とす筋', () => {
  let root: string;

  beforeEach(async () => {
    root = await makeTempDir('alteroid-test-');
  });

  it('索引が壊れた直後の読み手の組み直しが、同時の人間の write の印を上書きして落とさない', async () => {
    const stores = createFsStores(root);
    // 日誌の走査を止める門: 組み直しが「日誌を読んだあと・本文を読む前」で待つ並びを作る
    const journalGate = deferred();
    const journalReached = deferred();
    let gateJournal = false;
    const journal = new Proxy(stores.journal, {
      get(target, prop, receiver) {
        if (prop === 'listPage') {
          return async (...args: Parameters<JournalStore['listPage']>) => {
            const result = await target.listPage(...args);
            if (gateJournal) {
              journalReached.resolve();
              await journalGate.promise;
            }
            return result;
          };
        }
        const value = Reflect.get(target, prop, receiver) as unknown;
        return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
      },
    });
    const persona = new FsPersonaStore(join(root, 'memory'), journal);

    await persona.write('values', '# 価値観\n\nV1\n');
    expect(await persona.protectionStatus('values')).toEqual({ kind: 'clone-only' });

    gateJournal = true;
    // 人間の write を「索引を書く直前」で止める（本文は書き終わり、索引は旧版の読みのまま）
    const reached = deferred();
    const release = deferred();
    gate.holdIndexWrite = { reached: reached.resolve, release: release.promise };
    const humanWrite = persona.write('values', '# 価値観\n\nV2\n', {
      humanTouchedAt: '2026-11-01T00:00:00.000Z',
    });
    await reached.promise;

    // その間に索引が壊れ（消え）、lock の外の読み手が組み直しを始める。日誌を読んだ所で止める
    await rm(join(root, 'memory', '.index.json'), { force: true });
    const reader = persona.protectionStatus('values');
    // lock の中でだけ組み直すなら、組み直しは write の完了まで始まらない（journalReached は来ない）ので、待ちに上限を置く
    // 実時間の待ちにしない（#2146）: I/O を回すために setImmediate を上限つきで繰り返す
    let journalReachedFlag = false;
    void journalReached.promise.then(() => {
      journalReachedFlag = true;
    });
    for (let i = 0; i < 200 && !journalReachedFlag; i += 1) {
      await new Promise((r) => setImmediate(r));
    }

    // write が索引（印あり）を書き終えてから、組み直しが続きを走る
    release.resolve();
    await humanWrite;
    journalGate.resolve();
    await reader;

    expect(await persona.protectionStatus('values')).toEqual({ kind: 'human' });
  });
});
