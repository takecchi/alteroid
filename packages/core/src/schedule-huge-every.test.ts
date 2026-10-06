import { afterEach, describe, expect, it, vi } from 'vitest';

import { createScheduler } from './schedule.js';
import type { InboxEvent } from './schema.js';
import { SCHEDULE_EVERY_MINUTES_MAX, scheduleSpecSchema } from './schema.js';
import { createMemoryStores } from './testing.js';
import { createCloneTools } from './tools.js';

/**
 * `every` の分数に上限が無く、`minutes: 1e15` のような値が保存できた（#3533）。保存された行は次の予定を
 * Invalid Date にし、スケジューラは 1ms 周期で `timer` を積み、`list()` は `RangeError: Invalid time value` を投げた。
 *
 * 人間の決定（2026-10-06）: 入口の schema に上限（1年 = 525600 分）を置く。
 * - 上限超えは入口（`scheduleSpecSchema`・道具 `schedule_create`）で断る。
 * - 既に保存された上限超えの行は、保存層が読めない行（`unreadable`）として返す。スケジューラはそれを
 *   仕込まず、洪水も起こさず、`list()` も投げない。fs の実ファイルでの確認は
 *   `packages/storage-fs/src/schedules-huge-every-stored.test.ts`。
 */
const MAX = SCHEDULE_EVERY_MINUTES_MAX;

describe('every の分数の上限（1年 = 525600 分）', () => {
  it('上限は 525600', () => {
    expect(MAX).toBe(525_600);
  });

  it('525600 は通る', () => {
    expect(scheduleSpecSchema.safeParse({ type: 'every', minutes: MAX }).success).toBe(true);
  });

  it.each([MAX + 1, 1e15, Number.MAX_SAFE_INTEGER])(
    '%s は断る。文言は上限と cron・単発を伝える',
    (minutes) => {
      const result = scheduleSpecSchema.safeParse({ type: 'every', minutes });
      expect(result.success).toBe(false);
      const message = result.success
        ? ''
        : result.error.issues.map((issue) => issue.message).join();
      expect(message).toContain('525600');
      expect(message).toContain('cron');
      expect(message).toContain('単発');
    },
  );

  it('1 は通り、0 は断る（下限は従来どおり）', () => {
    expect(scheduleSpecSchema.safeParse({ type: 'every', minutes: 1 }).success).toBe(true);
    expect(scheduleSpecSchema.safeParse({ type: 'every', minutes: 0 }).success).toBe(false);
  });
});

describe('schedule_create の everyMinutes の上限', () => {
  async function create(everyMinutes: number) {
    const stores = createMemoryStores();
    const tools = createCloneTools({
      stores,
      emit: () => undefined,
      memoryCause: () => 'clone',
      conversationId: () => undefined,
    });
    const found = tools.find((entry) => entry.name === 'schedule_create');
    expect(found, 'schedule_create という道具が無い').toBeDefined();
    const result = await found?.handler(
      { kind: 'huge', request: '確認する', everyMinutes } as never,
      {} as never,
    );
    const reply = (result?.content ?? []).map((b) => (b.type === 'text' ? b.text : '')).join('');
    return { stores, reply };
  }

  it('525600 は仕込む', async () => {
    const { stores } = await create(MAX);
    expect((await stores.schedules.list()).entries.map((entry) => entry.spec)).toEqual([
      { type: 'every', minutes: MAX },
    ]);
  });

  it.each([MAX + 1, 1e15])('%s は仕込まずに断る。上限と cron・単発を伝える', async (minutes) => {
    const { stores, reply } = await create(minutes);
    expect((await stores.schedules.list()).entries).toEqual([]);
    expect(reply).toContain('everyMinutes');
    expect(reply).toContain('525600');
    expect(reply).toContain('cron');
    expect(reply).toContain('単発');
  });
});

describe('保存済みの上限超えの行（unreadable）はスケジューラが仕込まず、洪水も起こさない', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  async function setup() {
    const stores = createMemoryStores();
    // 保存層（fs / pg）は上限超えの行を entries に入れず unreadable で返す。その形を持つ store で模す。
    const schedules = {
      ...stores.schedules,
      list: async () => ({
        entries: [],
        unreadable: [{ kind: 'huge', reason: 'spec.minutes' }],
      }),
    };
    const posted: InboxEvent[] = [];
    const scheduler = createScheduler({
      entries: [],
      post: (event) => posted.push(event),
      schedules,
      onError: () => undefined,
    });
    await scheduler.refresh();
    return { scheduler, posted };
  }

  it('10秒の間に timer を積まない', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-06T00:00:00.000Z'));
    const { scheduler, posted } = await setup();
    scheduler.start();
    await vi.advanceTimersByTimeAsync(10_000);
    scheduler.stop();
    expect(posted).toEqual([]);
  });

  it('list() は投げず、unreadable() に見える', async () => {
    const { scheduler } = await setup();
    expect(scheduler.list()).toEqual([]);
    expect(scheduler.unreadable().map((row) => row.kind)).toEqual(['huge']);
  });
});
