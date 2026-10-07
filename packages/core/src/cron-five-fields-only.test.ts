import { describe, expect, it } from 'vitest';

import { isCronExpression, parseCron } from './cron.js';
import { scheduleSpecSchema } from './schema.js';
import { createMemoryStores } from './testing.js';
import { createCloneTools } from './tools.js';

const SIX_OR_SEVEN_FIELDS = [
  '*/5 * * * * *',
  '0 0 10 * * 1',
  '0 10 * * 1 *',
  '0 0 10 * * 1 2030',
  '* * * * * * *',
];

describe('parseCron は5欄だけを読む', () => {
  it.each(SIX_OR_SEVEN_FIELDS)('6欄・7欄の「%s」は読めない式', (expression) => {
    expect(parseCron(expression)).toBeNull();
    expect(isCronExpression(expression)).toBe(false);
  });

  it.each(['0 10 * * 1', '30 9 * * 1-5', '*/5 * * * *', '  0   10 * * 1  ', '0\t10 * * 1'])(
    '5欄の「%s」は読める（欄の間の空白の数・種類は問わない）',
    (expression) => {
      expect(parseCron(expression)).not.toBeNull();
    },
  );

  it.each(['0 10 * *', '* * * *', '@daily'])('5欄に満たない「%s」は読めない', (expression) => {
    expect(parseCron(expression)).toBeNull();
  });
});

describe('scheduleSpecSchema（HTTP の POST /schedule の spec）は6欄・7欄の cron を断る', () => {
  it.each(SIX_OR_SEVEN_FIELDS)('「%s」', (expression) => {
    expect(scheduleSpecSchema.safeParse({ type: 'cron', expression }).success).toBe(false);
  });
  it('5欄は通る', () => {
    expect(scheduleSpecSchema.safeParse({ type: 'cron', expression: '0 10 * * 1' }).success).toBe(
      true,
    );
  });
});

describe('schedule_create は6欄・7欄の cron を仕込まずに断る', () => {
  async function create(cron: string) {
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
      { kind: 'five-only', request: '確認する', cron } as never,
      {} as never,
    );
    const reply = (result?.content ?? []).map((b) => (b.type === 'text' ? b.text : '')).join('');
    return { stores, reply };
  }

  it.each(SIX_OR_SEVEN_FIELDS)('「%s」', async (cron) => {
    const { stores, reply } = await create(cron);
    expect(await stores.schedules.list()).toEqual({ entries: [], unreadable: [] });
    expect(reply).toContain('cron 式として読めない');
    expect(reply).not.toContain('仕込んだ');
  });

  it('5欄は仕込む', async () => {
    const { stores } = await create('0 10 * * 1');
    expect((await stores.schedules.list()).entries).toMatchObject([
      { kind: 'five-only', spec: { type: 'cron', expression: '0 10 * * 1' } },
    ]);
  });
});
