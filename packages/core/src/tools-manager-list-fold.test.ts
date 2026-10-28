import { describe, expect, it } from 'vitest';

import { DigestSessionDelta } from './digest-session-delta.js';
import type { ManagerPool, ManagerSummary } from './manager.js';
import { createMemoryStores } from './testing.js';
import { createCloneTools } from './tools.js';

// manager_list の固定の説明（件数行・「…ほか N 件」）を、同じ会話の2回目から短い参照にする（DigestSessionDelta.fixedInTurn）

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

function summary(n: number, extra: Partial<ManagerSummary> = {}): ManagerSummary {
  return {
    managerId: `mgr-${String(n).padStart(3, '0')}`,
    status: 'done',
    live: false,
    cwd: '/work',
    request: `依頼文 ${n}。${'依頼の説明が続く。'.repeat(30)}`,
    startedAt: new Date(Date.UTC(2026, 9, 27, 0, 0, 0) + n * 60_000).toISOString(),
    updatedAt: '2026-10-27T01:00:00.000Z',
    waiting: [],
    lastReport: `報告 ${n}。${'報告の本文が続く。'.repeat(30)}`,
    lastReportAt: '2026-10-27T01:00:00.000Z',
    ...extra,
  };
}

// 通常時: 終端した委譲が予算（8,000字）を越えて溜まり、先頭に走行中が1本。lost・枠・runner 消失は無い
const normal = (): ManagerSummary[] => [
  summary(0, { status: 'running', live: true }),
  ...Array.from({ length: 40 }, (_, i) => summary(i + 1)),
];
// 異常時: lost・枠で止まった・runner が名簿から消えた委譲が混ざる
const abnormal = (): ManagerSummary[] => [
  ...normal(),
  summary(100, { status: 'lost' }),
  summary(101, { status: 'running', usageStoppedAt: '2026-10-27T00:30:00.000Z' }),
  summary(102, { status: 'running', runnerVanished: true }),
];

function harness(managers: () => ManagerSummary[], delta: DigestSessionDelta | null) {
  const tools = createCloneTools({
    stores: createMemoryStores(),
    emit: () => undefined,
    memoryCause: () => 'clone',
    conversationId: () => undefined,
    managers: pool(managers()),
    ...(delta === null
      ? {}
      : { foldFixed: (id: string, full: string, ref: string) => delta.fixedInTurn(id, full, ref) }),
  });
  return async (args: Record<string, unknown> = {}): Promise<string> => {
    const found = tools.find((entry) => entry.name === 'manager_list');
    if (!found) throw new Error('manager_list が無い');
    const result = await found.handler(args as never, {});
    return (result.content ?? [])
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('');
  };
}

describe('manager_list は固定の説明を、同じ会話の2回目から短い参照にする', () => {
  it('⭐ 通常時: 2回目は件数・行・続きの取り方を毎回出し、固定の説明だけが参照になって短くなる', async () => {
    const call = harness(normal, new DigestSessionDelta());

    const first = await call();
    const second = await call();

    expect(first).toContain('**「走行中」は「進んでいる」ではない**');
    expect(first).toContain('**省略されたのは終端したもの');
    expect(first).toContain('台帳には保持期間も掃除の機構も無い');
    expect(second).not.toContain('**「走行中」は「進んでいる」ではない**');
    expect(second).not.toContain('**省略されたのは終端したもの');
    expect(second).not.toContain('台帳には保持期間も掃除の機構も無い');
    // 参照にも要点が残る
    expect(second).toContain('動いている本数は「話しかけられる」ほうで数える');
    expect(second).toContain('省略されたのは終端したもの・より古いものの側');
    expect(second).toContain('status や q で絞れば減らせる');
    // 可変部は毎回出る
    for (const text of [first, second]) {
      expect(text).toContain('件数: 全 41 本 / 走行中 1 本（うち話しかけられる 1 本）');
      expect(text).toContain('話しかけられる委譲は全体で 1 本である。');
      expect(text).toContain('- mgr-000');
      expect(text).toMatch(
        /続きは manager_list cursor=\S+ で取れる（status と q は同じまま呼ぶこと）。/,
      );
    }
    // 実測（この fixture）: 1回目 8,009字 → 2回目 7,903字
    expect(second.length).toBeLessThan(first.length - 80);
  });

  it('⭐ 異常時（lost・枠・runner 消失）: 各ブロックが1回ずつ全文で、2回目は要点を残した参照になる', async () => {
    const call = harness(abnormal, new DigestSessionDelta());

    const first = await call();
    const second = await call();

    for (const phrase of [
      '**「戻れなかった(lost)」は「終わった」ではない**',
      '**「枠(利用上限)で止まっている」は status の分割ではなく横断する軸である**',
      '**「宛先の runner が名簿から消えている」は status の分割ではなく横断する軸である**',
    ]) {
      expect(first).toContain(phrase);
      expect(second).not.toContain(phrase);
    }
    // 参照に残る要点: 打つ手が変わるもの
    expect(second).toContain('status: ["lost"]');
    expect(second).toContain('status: ["running"]');
    expect(second).toContain('status: ["done"]');
    expect(second).toContain('確かめる前に manager_start で起こし直さない');
    expect(second).toContain('各行の ⚠ 枠(利用上限)で止まっている から辿る');
    expect(second).toContain('各行の ⚠ 宛先の runner が名簿から消えている から辿る');
    // 件数の内訳は毎回出る
    for (const text of [first, second]) {
      expect(text).toContain('戻れなかった(lost) 1 本');
      expect(text).toContain('枠(利用上限)で止まっている 1 本');
      expect(text).toContain('宛先の runner が名簿から消えている 1 本');
    }
    // 実測（この fixture）: 1回目 9,505字 → 2回目 9,030字
    expect(second.length).toBeLessThan(first.length - 400);
  });

  it('1回目に無かったブロックは、初めて出る回に全文で出る（出していない全文を「出した」と控えない）', async () => {
    const delta = new DigestSessionDelta();
    await harness(normal, delta)();

    const second = await harness(abnormal, delta)();

    expect(second).toContain('**「戻れなかった(lost)」は「終わった」ではない**');
    expect(second).not.toContain('**「走行中」は「進んでいる」ではない**');
  });

  it('⭐ reset（会話が変わった・要約が走りうる・失敗したターンの後）の後は全文へ戻る', async () => {
    for (const reason of ['full', 'compaction'] as const) {
      const delta = new DigestSessionDelta();
      const call = harness(abnormal, delta);
      const first = await call();
      await call();

      delta.reset(reason);
      const afterReset = await call();

      expect(afterReset).toBe(first);
    }
  });

  it('口が無い器（テスト・蒸留）は何度呼んでも全文', async () => {
    const call = harness(abnormal, null);

    const first = await call();
    const second = await call();

    expect(second).toBe(first);
    expect(first).toContain('**「走行中」は「進んでいる」ではない**');
  });
});
