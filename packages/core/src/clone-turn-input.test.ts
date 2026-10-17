import type { query as sdkQuery, Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import { waitFor } from './clone-test-harness.js';
import { ALWAYS_REDELIVER, createClone } from './clone.js';
import type { CloneHost } from './host.js';
import { createLocalRunner } from './runner-local.js';
import { createRunnerRegistry } from './runner-protocol.js';
import { localDate } from './schedule.js';
import type { InboxEvent, JournalEntry } from './schema.js';
import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';

interface Fake {
  fn: typeof sdkQuery;
  inputs: string[];
}

function fakeSdk(behavior: 'reply' | 'hang' = 'reply'): Fake {
  const inputs: string[] = [];
  const forever = new Promise<void>(() => undefined);

  const fn = ((params: { prompt: unknown; options?: Options }) => {
    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: 'sess-fake',
        uuid: 'uuid-init',
      } as unknown as SDKMessage;

      for await (const message of params.prompt as AsyncIterable<{
        message: { content: unknown };
      }>) {
        inputs.push(String(message.message.content));
        if (behavior === 'hang') await forever;
        yield {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'ok' }] },
          parent_tool_use_id: null,
          session_id: 'sess-fake',
          uuid: 'uuid-assistant',
        } as unknown as SDKMessage;
        yield {
          type: 'result',
          subtype: 'success',
          result: 'ok',
          session_id: 'sess-fake',
          uuid: 'uuid-result',
        } as unknown as SDKMessage;
      }
    }

    const generator = generate();
    return Object.assign(generator, {
      close: () => undefined,
      interrupt: async () => undefined,
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;

  return { fn, inputs };
}

function bootClone(
  stores: Stores,
  behavior: 'reply' | 'hang' = 'reply',
): Fake & { clone: CloneHost } {
  const fake = fakeSdk(behavior);
  const clone = createClone({
    redeliveryGate: ALWAYS_REDELIVER,
    stores,
    queryFn: fake.fn,
    env: {},
    runners: createRunnerRegistry([
      createLocalRunner({ workspacePath: '/work', queryFn: fakeSdk().fn, env: {} }),
    ]),
  });
  return { ...fake, clone };
}

async function turnInputAfterTurn(
  stores: Stores,
  fake: Fake,
  needle: string,
  turns = 1,
): Promise<string> {
  await waitFor(() => fake.inputs.length >= turns, `${turns} 本目のターンの本文が SDK へ渡る`);
  const entries: JournalEntry[] = await stores.journal.list({ types: ['exchange'] });
  const hit = entries.find(
    (entry) =>
      entry.type === 'exchange' &&
      entry.with === 'self' &&
      entry.role === 'inbound' &&
      entry.text.includes(needle),
  );
  expect(hit, `日誌に self/inbound の「${needle}」の行が無い`).toBeDefined();
  return hit?.type === 'exchange' ? hit.text : '';
}

const REPORT_MARKER = 'MGR-REPORT-MARKER-9f3a';
const LAST_REPORT = `${REPORT_MARKER} 委譲した仕事の報告の本文。${'この文はマネージャーの報告を長くするために繰り返している。'.repeat(10)}`;

async function seedManagerReport(stores: Stores): Promise<void> {
  const now = new Date().toISOString();
  await stores.jobs.putJob({
    id: 'mgr-243',
    createdAt: now,
    updatedAt: now,
    status: 'running',
    summary: 'テスト用の委譲',
    lastReport: LAST_REPORT,
  });
}

const AT = '2026-08-12T00:00:00.000Z';

interface DigestRoute {
  name: string;
  event: (stores: Stores) => Promise<InboxEvent>;
  needle: string;
  expected: string[];
}

const DIGEST_ROUTES: DigestRoute[] = [
  {
    name: 'timer（定期ジョブ）',
    async event(stores) {
      await stores.schedules.put({
        kind: 'issue-round',
        spec: { type: 'daily', at: '09:00' },
        request: 'open issue を見て、着手できるものから進める',
        createdAt: '2026-08-11T00:00:00.000Z',
        updatedAt: '2026-08-11T00:00:00.000Z',
      });
      return { type: 'timer', id: 'evt-timer', at: AT, kind: 'issue-round', cause: 'manual' };
    },
    needle: 'ターンの入力: timer',
    expected: ['kind=issue-round', 'cause=manual', 'request=yes', 'digest.chars='],
  },
  {
    name: 'self_initiative（発意 tick）',
    event: () =>
      Promise.resolve({
        type: 'self_initiative',
        id: 'evt-self',
        at: AT,
        reason: '定期 tick: 記憶にある目的から次にやることを決める',
      }),
    needle: 'ターンの入力: self_initiative',
    expected: ['reason=定期 tick: 記憶にある目的から次にやることを決める', 'digest.chars='],
  },
  {
    name: 'daily_report（日報）',
    event: () =>
      Promise.resolve({
        type: 'timer',
        id: 'evt-daily',
        at: new Date().toISOString(),
        kind: 'daily_report',
        target: localDate(new Date()),
      }),
    needle: 'ターンの入力: daily_report',
    expected: [`date=${localDate(new Date())}`, 'digest.chars='],
  },
];

describe('ターンの入力を日誌に残す（#243）— digest 経路は形だけ', () => {
  for (const route of DIGEST_ROUTES) {
    it(`${route.name}: 形と材料の id と digest の文字数が日誌に残る`, async () => {
      const stores = createMemoryStores();
      await seedManagerReport(stores);
      const s = bootClone(stores);

      s.clone.post(await route.event(stores));
      const text = await turnInputAfterTurn(stores, s, route.needle);

      for (const fragment of route.expected) expect(text).toContain(fragment);
      const chars = Number(/digest\.chars=(\d+)/u.exec(text)?.[1] ?? '0');
      expect(chars).toBeGreaterThan(0);

      await s.clone.stop();
    });

    it(`${route.name}: digest の本文（マネージャーの直近の報告）は日誌に入らない`, async () => {
      const stores = createMemoryStores();
      await seedManagerReport(stores);
      const s = bootClone(stores);

      s.clone.post(await route.event(stores));
      const text = await turnInputAfterTurn(stores, s, route.needle);

      await waitFor(() => s.inputs.some((input) => input.includes(REPORT_MARKER)), '報告の抜粋');
      expect(s.inputs.join('\n')).toContain('直近の報告:');

      expect(text).not.toContain(REPORT_MARKER);
      expect(text).not.toContain('直近の報告:');
      expect(text).not.toContain('## マネージャー');
      expect(text).not.toContain('期間: ');

      await s.clone.stop();
    });
  }

  it('distill: reason と本文の長さだけが残り、蒸留の指示文そのものは残らない', async () => {
    const stores = createMemoryStores();
    const s = bootClone(stores);

    s.clone.post({
      type: 'human_message',
      id: 'evt-human',
      at: AT,
      text: 'やあ',
      conversationId: 'conv-1',
    });
    await waitFor(() => s.inputs.length > 0, '人間のターン');

    s.clone.post({ type: 'distill', id: 'evt-distill', at: AT, reason: 'shutdown' });
    const text = await turnInputAfterTurn(stores, s, 'ターンの入力: distill', 2);

    expect(text).toContain('reason=shutdown');
    const chars = Number(/prompt\.chars=(\d+)/u.exec(text)?.[1] ?? '0');
    expect(chars).toBeGreaterThan(100);

    await waitFor(
      () => s.inputs.some((input) => input.includes('忘れる前に、記憶へ移すべきものがあるか')),
      '蒸留の指示文',
    );
    expect(text).not.toContain('忘れる前に、記憶へ移すべきものがあるか');

    await s.clone.stop();
  });
});

describe('ターンの入力を日誌に残す（#243）— 人間の回答は全文', () => {
  const ANSWER = 'HUMAN-ANSWER-MARKER-7c1e 進めてよい。ただし本番の鍵は触らないこと。';
  const QUESTION = 'HUMAN-QUESTION-MARKER-2b8d 本番のデータベースへ移行を当ててよいか';

  async function seedApproval(stores: Stores): Promise<void> {
    await stores.jobs.putApproval({
      id: 'apr-243',
      createdAt: AT,
      question: QUESTION,
      jobId: 'mgr-9',
      requestId: 'req-3',
    });
  }

  const answerEvent: InboxEvent = {
    type: 'human_answer',
    id: 'evt-answer',
    at: AT,
    approvalId: 'apr-243',
    answer: ANSWER,
  };

  it('人間の回答は、質問・回答・宛先の全文が日誌に残る', async () => {
    const stores = createMemoryStores();
    await seedApproval(stores);
    const s = bootClone(stores);

    s.clone.post(answerEvent);
    const text = await turnInputAfterTurn(stores, s, 'ターンの入力: human_answer');

    expect(text).toContain('approvalId=apr-243');
    expect(text).toContain(ANSWER);
    expect(text).toContain(QUESTION);
    expect(text).toContain('managerId: "mgr-9"');
    expect(text).toContain('requestId: "req-3"');

    await s.clone.stop();
  });

  it('片付け済みの配り直しでは、ターンを起こさない代わりに、断り書きの全文が畳んだ跡へ残る', async () => {
    const stores = createMemoryStores();
    await seedApproval(stores);

    const dying = bootClone(stores, 'hang');
    dying.clone.post(answerEvent);
    await waitFor(() => dying.inputs.length > 0, '合図が処理に入る');
    await waitFor(async () => (await stores.commitments.get('evt-answer')) !== null, '台帳の未了');
    expect(await stores.commitments.close('evt-answer', AT, 'もう対応済み', 'clone')).toBe(true);

    const reborn = bootClone(stores);
    await waitFor(async () => (await stores.inbox.claimPending()).length === 0, '未読の消し込み');
    await reborn.clone.stop();

    expect(reborn.inputs).toEqual([]);
    const exchanges = (await stores.journal.list({ types: ['exchange'] })).flatMap((entry) =>
      entry.type === 'exchange' ? [entry] : [],
    );
    const text =
      exchanges.find((entry) => entry.text.includes('ターンを起こさずに畳んだ'))?.text ?? '';

    expect(text).toContain('apr-243');
    expect(text).toContain('再起動後の配り直しである');
    expect(text).toContain('approvals_list');
    expect(text).not.toContain(ANSWER);
  });
});
