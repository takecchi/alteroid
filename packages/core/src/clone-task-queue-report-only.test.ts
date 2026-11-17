import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CloneTaskIntake } from './clone-task-intake.js';
import type { InboxEvent, Task } from './schema.js';
import { createMemoryStores, humanMessage } from './testing.js';
import { READING, readingRef } from './turn-readings.js';

// 待ち行列の節（断り書き `[system] 待ち行列（…`）は、束の全件がマネージャーの報告のときだけ、先頭の task を出さず件数と滞留の行だけにする（2026-11-17 のオーナー判断）。
// 報告は毎時十数回あり、先頭3件の題がそのたびに会話履歴へ積もる。次の1件を選ぶのは発意の tick と人間の発言のターンで、そこでは先頭を出す。
// 件数・needs_decision・最も古い滞留は報告のターンにも残るので、詰まりは見える。

const FROZEN_AT = '2026-11-01T09:00:00.000Z';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(FROZEN_AT));
});

afterEach(() => {
  vi.useRealTimers();
});

function task(id: string, status: Task['status'], updatedAt: string): Task {
  return {
    id,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt,
    status,
    origin: 'self',
    title: `title-${id}`,
    body: `body-${id}`,
  };
}

async function intakeWithQueue(): Promise<CloneTaskIntake> {
  const stores = createMemoryStores();
  await stores.tasks.add(task('q-1', 'queued', '2026-10-31T09:00:00.000Z'));
  await stores.tasks.add(task('n-1', 'needs_decision', '2026-10-27T06:00:00.000Z'));
  return new CloneTaskIntake({ stores: () => stores, journal: () => Promise.resolve() });
}

const at = (): string => new Date().toISOString();
const report = (id: string, managerId = 'mgr-a'): InboxEvent => ({
  type: 'manager_message',
  id,
  at: at(),
  managerId,
  kind: 'report',
  text: '報告',
});
const question = (id: string): InboxEvent => ({
  type: 'manager_message',
  id,
  at: at(),
  managerId: 'mgr-q',
  kind: 'question',
  text: '質問',
});
const permission = (id: string): InboxEvent => ({
  type: 'manager_message',
  id,
  at: at(),
  managerId: 'mgr-p',
  kind: 'permission',
  text: '許可確認',
  requestId: 'rq-1',
});

const COUNT_LINE = '- 待ち行列: 開いている 2 件（queued 1 / waiting 0 / needs_decision 1）';
const BACKLOG_LINE = '- 滞留: needs_decision 1 件（最も古いのは 5日3時間前）';
const HEAD_ROW = '- q-1（';

describe('待ち行列の節は、報告だけのターンでは件数の行と滞留の行だけ', () => {
  it('⭐ 報告だけ（1件・複数件）: 件数・needs_decision・滞留は在り、task の行と参照は無い', async () => {
    for (const events of [[report('e1')], [report('e1'), report('e2', 'mgr-b')]]) {
      const notice = await (await intakeWithQueue()).taskQueueNoticeFor(events);
      expect(notice).toContain('[system] 待ち行列（09:00:00Z に数えた材料）');
      expect(notice).toContain(COUNT_LINE);
      expect(notice).toContain(BACKLOG_LINE);
      expect(notice).not.toContain(HEAD_ROW);
      expect(notice).not.toContain('title-');
      expect(notice).not.toContain(readingRef(READING.queue));
    }
  });

  it.each([
    ['人間の発言', [humanMessage('こんにちは')]],
    ['質問', [question('e1')]],
    ['許可確認', [permission('e1')]],
    ['報告と質問が混ざった束', [report('e1'), question('e2')]],
    ['報告と許可確認が混ざった束', [report('e1'), permission('e2')]],
    [
      '報告と外部の出来事が混ざった束',
      [report('e1'), { type: 'external', id: 'e2', at: at(), source: 'github', payload: {} }],
    ],
    [
      '外部の出来事',
      [{ type: 'external', id: 'e1', at: at(), source: 'github', payload: {} } as InboxEvent],
    ],
    [
      '定期ジョブ',
      [
        {
          type: 'timer',
          id: 'e1',
          at: at(),
          kind: 'weekly_check',
          cause: 'schedule',
        } as InboxEvent,
      ],
    ],
  ] as const)('⭐ %s のターンは、今どおり先頭の task と参照が出る', async (_name, events) => {
    const notice = await (await intakeWithQueue()).taskQueueNoticeFor([...events]);
    expect(notice).toContain(COUNT_LINE);
    expect(notice).toContain(BACKLOG_LINE);
    expect(notice).toContain(HEAD_ROW);
    expect(notice).toContain('- n-1（');
    expect(notice).toContain(readingRef(READING.queue));
  });

  it('報告だけでも、待ち行列を読めなかった断りは出る', async () => {
    const stores = createMemoryStores();
    const failing = {
      ...stores.tasks,
      list: () => Promise.reject(new Error('読めない理由')),
    };
    const intake = new CloneTaskIntake({
      stores: () => ({ tasks: failing, jobs: stores.jobs }),
      journal: () => Promise.resolve(),
    });
    const notice = await intake.taskQueueNoticeFor([report('e1')]);
    expect(notice).toContain('待ち行列を読めなかった');
    expect(notice).toContain('読めない理由');
  });
});
