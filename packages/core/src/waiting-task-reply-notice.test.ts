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
