import { describe, expect, it } from 'vitest';

import type { Job, Task } from './schema.js';
import { selectWaitingReplyTasks } from './waiting-task-reply-notice.js';

const HOUR = 60 * 60 * 1000;
const NOW = Date.parse('2026-11-08T12:00:00.000Z');

const waitingTask: Task = {
  id: 't',
  createdAt: '2026-11-08T00:00:00.000Z',
  updatedAt: '2026-11-08T00:00:00.000Z',
  status: 'waiting',
  origin: 'human',
  title: 't',
  body: 't',
  originConversationId: 'conv-1',
};

const named = (job: Pick<Job, 'status' | 'taskId' | 'awaitingBackgroundSince'>): boolean =>
  selectWaitingReplyTasks([waitingTask], [job], new Set(['conv-1']), NOW).length === 1;

// 新しい仕様を先に書いた試験（案 D）: 背景処理の完了待ちで閉じた done は、委譲がまだ生きている。
// 「委譲が結び付いていない返事待ち」と名乗ると、manager の鏡が持っている task へ誤った催促が出る。
describe('selectWaitingReplyTasks と背景処理待ちの done', () => {
  it('印が立った done の委譲が結び付いた waiting は、名乗らない', () => {
    expect(
      named({
        status: 'done',
        taskId: 't',
        awaitingBackgroundSince: new Date(NOW - HOUR).toISOString(),
      }),
    ).toBe(false);
  });

  it('印が 6 時間を過ぎた done は、保留を無視して名乗る', () => {
    expect(
      named({
        status: 'done',
        taskId: 't',
        awaitingBackgroundSince: new Date(NOW - 7 * HOUR).toISOString(),
      }),
    ).toBe(true);
  });

  it('印の無い done は今までどおり名乗る', () => {
    expect(named({ status: 'done', taskId: 't' })).toBe(true);
  });

  it('running の委譲が結び付いていれば名乗らない（今までどおり）', () => {
    expect(named({ status: 'running', taskId: 't' })).toBe(false);
  });
});

// 新しい仕様を先に書いた試験（案 C の残り。今の作りの出力から確かめたものではない）:
// 猶予（30 分）の内の done は、走っている委譲と同じに読む（見回りがまだ倒さない waiting を、結び付いていない返事待ちと名乗らない）。
describe('(h) selectWaitingReplyTasks と猶予内の done', () => {
  const MIN = 60 * 1000;
  const endedAgo = (ms: number): Pick<Job, 'status' | 'taskId' | 'endedAt'> => ({
    status: 'done',
    taskId: 't',
    endedAt: new Date(NOW - ms).toISOString(),
  });
  const namedWith = (job: Pick<Job, 'status' | 'taskId' | 'endedAt'>): boolean =>
    selectWaitingReplyTasks([waitingTask], [job], new Set(['conv-1']), NOW).length === 1;

  it('猶予の内の done の委譲が結び付いた waiting は、名乗らない', () => {
    expect(namedWith(endedAgo(29 * MIN))).toBe(false);
  });

  it('猶予を過ぎた done は、名乗る（見回りが倒す側と揃える）', () => {
    expect(namedWith(endedAgo(31 * MIN))).toBe(true);
  });

  it('endedAt の無い done は名乗る（今までどおり）', () => {
    expect(namedWith({ status: 'done', taskId: 't' })).toBe(true);
  });

  it('failed の委譲は、終わった直後でも名乗る（猶予 0）', () => {
    expect(namedWith({ ...endedAgo(MIN), status: 'failed' })).toBe(true);
  });
});

// pin（今の作りの出力から確かめた。仕様を先に書いたものではない）: 猶予（案 C の残り）を置く前、done の委譲は
// たった今終わっても「結び付いていない返事待ち」と名乗られる。猶予の PR で反転した（猶予内の done は名乗らない。反転前の期待は toHaveLength(1)）。
describe('pin: 猶予を置く前の done の読み（猶予の PR で反転）', () => {
  it('反転済み: たった今 endedAt が付いた done の委譲が結び付いた waiting は、名乗らない', () => {
    const fresh: Pick<Job, 'status' | 'taskId' | 'endedAt'> = {
      status: 'done',
      taskId: 't',
      endedAt: new Date(NOW - 60_000).toISOString(),
    };
    expect(selectWaitingReplyTasks([waitingTask], [fresh], new Set(['conv-1']), NOW)).toHaveLength(
      0,
    );
  });
});
