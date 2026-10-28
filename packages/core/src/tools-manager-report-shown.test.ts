import { describe, expect, it } from 'vitest';

import type { ManagerPool, ManagerSummary } from './manager.js';
import { createMemoryStores } from './testing.js';
import { createCloneTools } from './tools.js';

const SHOWN_AT = new Date('2026-10-27T03:04:05.000Z');
const REPORT = `担当の報告。${'結論と根拠が続く。'.repeat(500)}`;

function pool(managers: ManagerSummary[]): ManagerPool {
  const notUsed = () => {
    throw new Error('この歯では使わない');
  };
  return {
    async list() {
      return managers.map((manager) => ({ ...manager }));
    },
    denials() {
      return [];
    },
    runnerBacklog() {
      return [];
    },
    unpushedWork: async () => ({ kind: 'none' }),
    start: notUsed,
    send: notUsed,
    abort: notUsed,
  } as unknown as ManagerPool;
}

function harness(
  shownAt: (managerId: string, text: string) => Date | null,
  isSubagentCall?: (toolUseId: string | undefined) => boolean,
) {
  const summary: ManagerSummary = {
    managerId: 'mgr-1',
    status: 'done',
    live: false,
    cwd: '/work',
    request: `依頼文。${'依頼の説明。'.repeat(50)}`,
    startedAt: '2026-10-27T00:00:00.000Z',
    updatedAt: '2026-10-27T01:00:00.000Z',
    waiting: [],
    lastReport: REPORT,
    lastReportAt: '2026-10-27T01:00:00.000Z',
  };
  const tools = createCloneTools({
    stores: createMemoryStores(),
    emit: () => undefined,
    memoryCause: () => 'clone',
    conversationId: () => undefined,
    managers: pool([summary]),
    managerReportShownAt: shownAt,
    ...(isSubagentCall === undefined ? {} : { isSubagentCall }),
  });
  return {
    async call(args: Record<string, unknown>, extra: unknown = {}): Promise<string> {
      const found = tools.find((entry) => entry.name === 'manager_report');
      if (!found) throw new Error('manager_report が無い');
      const result = await found.handler(args as never, extra as never);
      return (result.content ?? [])
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join('');
    },
  };
}

const seen = (managerId: string, text: string): Date | null =>
  managerId === 'mgr-1' && text === REPORT ? SHOWN_AT : null;

describe('manager_report は、全文が既に発言に載っている報告を引き直されたとき注記だけを返す', () => {
  it('⭐ 控えがあれば本文を出さず、載っている時刻と refetch の案内を返す。字数が大きく減る', async () => {
    const full = await harness(() => null).call({ managerId: 'mgr-1' });
    const note = await harness(seen).call({ managerId: 'mgr-1' });

    expect(full).toContain(REPORT.slice(0, 200));
    expect(note).not.toContain(REPORT.slice(0, 200));
    expect(note).toContain('03:04Z の発言に載っている（会話の上）');
    expect(note).toContain('refetch: true');
    expect(note.length).toBeLessThan(full.length / 5);
  });

  it('⭐ refetch: true は控えがあっても全文を返す', async () => {
    const reply = await harness(seen).call({ managerId: 'mgr-1', refetch: true });

    expect(reply).toContain(REPORT.slice(0, 200));
    expect(reply).not.toContain('の発言に載っている');
  });

  it('控えが無い（reset 後・押し込めなかった回・切り詰めた報告）なら従来どおり全文', async () => {
    const reply = await harness(() => null).call({ managerId: 'mgr-1' });

    expect(reply).toContain(REPORT.slice(0, 200));
    expect(reply).not.toContain('の発言に載っている');
  });

  it('別の担当・別の本文の控えは当たらない', async () => {
    const reply = await harness((_id, text) => (text === `${REPORT}違う` ? SHOWN_AT : null)).call({
      managerId: 'mgr-1',
    });

    expect(reply).toContain(REPORT.slice(0, 200));
  });

  it('頁送り（offset）と依頼文（part=request）は従来どおり本文を出す', async () => {
    const page = await harness(seen).call({ managerId: 'mgr-1', offset: 100 });
    const request = await harness(seen).call({ managerId: 'mgr-1', part: 'request' });

    expect(page).toContain('結論と根拠が続く。');
    expect(page).not.toContain('の発言に載っている');
    expect(request).toContain('依頼の説明。');
  });

  it('⭐ サブエージェントの呼びは控えがあっても全文を返し、控えを引きもしない（#5428）', async () => {
    const asked: string[] = [];
    const h = harness(
      (id, text) => {
        asked.push(id);
        return seen(id, text);
      },
      (toolUseId) => toolUseId === 'tu-sub',
    );

    const sub = await h.call(
      { managerId: 'mgr-1' },
      { _meta: { 'claudecode/toolUseId': 'tu-sub' } },
    );
    expect(sub).toContain(REPORT.slice(0, 200));
    expect(sub).not.toContain('の発言に載っている');
    expect(asked).toEqual([]);

    const main = await h.call(
      { managerId: 'mgr-1' },
      { _meta: { 'claudecode/toolUseId': 'tu-main' } },
    );
    expect(main).toContain('の発言に載っている');
  });

  it('extra から tool_use_id が読めない（_meta 無し・型違い・空）ときは undefined を口へ渡す', async () => {
    const received: unknown[] = [];
    const h = harness(seen, (toolUseId) => {
      received.push(toolUseId);
      return false;
    });

    await h.call({ managerId: 'mgr-1' }, {});
    await h.call({ managerId: 'mgr-1' }, undefined);
    await h.call({ managerId: 'mgr-1' }, { _meta: { 'claudecode/toolUseId': 7 } });
    await h.call({ managerId: 'mgr-1' }, { _meta: { 'claudecode/toolUseId': '' } });
    await h.call({ managerId: 'mgr-1' }, { _meta: { 'claudecode/toolUseId': 'tu-1' } });

    expect(received).toEqual([undefined, undefined, undefined, undefined, 'tu-1']);
  });

  it('口が無い器（テスト・蒸留）は従来どおり全文', async () => {
    const tools = createCloneTools({
      stores: createMemoryStores(),
      emit: () => undefined,
      memoryCause: () => 'clone',
      conversationId: () => undefined,
      managers: pool([
        {
          managerId: 'mgr-1',
          status: 'done',
          live: false,
          cwd: '/work',
          request: 'r',
          startedAt: '2026-10-27T00:00:00.000Z',
          updatedAt: '2026-10-27T01:00:00.000Z',
          waiting: [],
          lastReport: REPORT,
        },
      ]),
    });
    const found = tools.find((entry) => entry.name === 'manager_report');
    const result = await found!.handler({ managerId: 'mgr-1' } as never, {});
    const text = (result.content ?? []).map((b) => (b.type === 'text' ? b.text : '')).join('');

    expect(text).toContain(REPORT.slice(0, 200));
  });
});
