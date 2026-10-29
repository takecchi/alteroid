import { describe, expect, it } from 'vitest';

import { DigestSessionDelta } from './digest-session-delta.js';
import type { ManagerPool, ManagerSummary } from './manager.js';
import { createMemoryStores } from './testing.js';
import { createCloneTools, TOOL_USE_ID_META_KEY } from './tools.js';

// manager_list の行内の固定文（起点の会話の使い方・⚠ 文）の畳みは、サブエージェントの呼びでは効かず全文で返る（#5429 の NO_FIXED_FOLD 経路）。
// 札が指す全文はサブエージェントの文脈にしか載らず、本体の控えも「出した」にならない。
// fixture と foldFixed の fake は tools-manager-list-fold.test.ts と同じ形（あちらは編集しない）。

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
    async runners() {
      return { daemonRevision: { status: 'unheard' }, unassigned: [], runners: [] };
    },
    unpushedWork: async () => ({ kind: 'none' }),
    start: notUsed,
    send: notUsed,
    abort: notUsed,
  } as unknown as ManagerPool;
}

function summary(n: number, extra: Partial<ManagerSummary> = {}): ManagerSummary {
  return {
    managerId: `mgr-${String(n).padStart(3, '0')}`,
    status: 'lost',
    live: false,
    cwd: '/work',
    request: `依頼文 ${n}`,
    startedAt: new Date(Date.UTC(2026, 9, 27, 0, 0, 0) + n * 60_000).toISOString(),
    updatedAt: '2026-10-27T01:00:00.000Z',
    waiting: [],
    lastReport: `報告 ${n}`,
    lastReportAt: '2026-10-27T01:00:00.000Z',
    ...extra,
  };
}

const SUBAGENT_TOOL_USE_ID = 'toolu_subagent';
const MAIN_TOOL_USE_ID = 'toolu_main';
const hint =
  '（報告を人間へ知らせるなら、この会話を起点にした task を task_list で探して task_say で書く。無ければ task_add で足す）';
const delivered = '終端の直前に「喋っただけの本文」がそのまま報告として出る経路が runner に在り';

function harness() {
  const stores = createMemoryStores();
  const delta = new DigestSessionDelta();
  const rows = [summary(1), summary(2), summary(3)];
  const ledger = rows.map((row) => row.managerId);
  const tools = createCloneTools({
    stores,
    emit: () => undefined,
    memoryCause: () => 'clone',
    conversationId: () => undefined,
    managers: pool(rows),
    foldFixed: (id: string, full: string, ref: string) => delta.fixedInTurn(id, full, ref),
    isSubagentCall: (toolUseId) => toolUseId === SUBAGENT_TOOL_USE_ID,
  });
  return async (toolUseId: string): Promise<string> => {
    const found = tools.find((entry) => entry.name === 'manager_list');
    if (!found) throw new Error('manager_list が無い');
    for (const id of ledger) {
      await stores.jobs.putJob({
        id,
        managerId: id,
        createdAt: '2026-10-27T00:00:00.000Z',
        updatedAt: '2026-10-27T00:00:00.000Z',
        status: 'done',
        summary: '依頼',
        conversationId: `conv-${id}`,
      });
    }
    const result = await found.handler({} as never, {
      _meta: { [TOOL_USE_ID_META_KEY]: toolUseId },
    });
    return (result.content ?? [])
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('');
  };
}

const count = (text: string, phrase: string): number => text.split(phrase).length - 1;

describe('manager_list の行内の固定文は、サブエージェントの呼びでは畳まない', () => {
  it('⭐ サブエージェントの呼びは1回目も2回目も行内の固定文が全文。同じ context の通常の呼びは2回目に畳まれる（対照）', async () => {
    const call = harness();

    const subFirst = await call(SUBAGENT_TOOL_USE_ID);
    const subSecond = await call(SUBAGENT_TOOL_USE_ID);

    // 3行ぶんが毎回全文（畳まれると 2 回目は 0 になる）
    for (const text of [subFirst, subSecond]) {
      expect(count(text, hint)).toBe(3);
      expect(count(text, delivered)).toBe(3);
    }

    // サブエージェントの呼びは本体の控えを更新しない: 通常の呼びの1回目は初出として全文（最初の行だけ）
    const mainFirst = await call(MAIN_TOOL_USE_ID);
    expect(count(mainFirst, hint)).toBe(1);
    expect(count(mainFirst, delivered)).toBe(1);

    // 対照: 通常の呼びの2回目は参照になる
    const mainSecond = await call(MAIN_TOOL_USE_ID);
    expect(count(mainSecond, hint)).toBe(0);
    expect(count(mainSecond, delivered)).toBe(0);
    expect(mainSecond.length).toBeLessThan(subSecond.length);
  });
});
