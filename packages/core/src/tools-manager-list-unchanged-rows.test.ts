import { describe, expect, it } from 'vitest';

import { DigestSessionDelta } from './digest-session-delta.js';
import type { ManagerPool, ManagerSummary } from './manager.js';
import { createMemoryStores } from './testing.js';
import { createCloneTools } from './tools.js';

// manager_list の「前回と変わらない行」を、同じ会話の2回目から managerId だけの1行に畳む

const SAME = '前回と同じ';

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

const small = (): ManagerSummary[] => [1, 2, 3, 4, 5].map((n) => summary(n));

// 1回の呼びを作る。同じ delta を渡せば同じ会話の続き
function call(
  managers: ManagerSummary[],
  delta: DigestSessionDelta | null,
  args: Record<string, unknown> = {},
): Promise<string> {
  const tools = createCloneTools({
    stores: createMemoryStores(),
    emit: () => undefined,
    memoryCause: () => 'clone',
    conversationId: () => undefined,
    managers: pool(managers),
    ...(delta === null
      ? {}
      : {
          foldFixed: (id: string, full: string, ref: string, supersedes?: string) =>
            delta.fixedInTurn(id, full, ref, supersedes),
        }),
  });
  const found = tools.find((entry) => entry.name === 'manager_list');
  if (!found) throw new Error('manager_list が無い');
  return found
    .handler(args as never, {})
    .then((result) =>
      (result.content ?? []).map((block) => (block.type === 'text' ? block.text : '')).join(''),
    );
}

function rowOf(text: string, id: string): string {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line.startsWith(`- ${id}`));
  if (start < 0) return '';
  let end = start + 1;
  while (end < lines.length && lines[end]!.startsWith('  ')) end += 1;
  return lines.slice(start, end).join('\n');
}

describe('manager_list は前回と変わらない行を畳む', () => {
  it('⭐ 全行が同じなら 2回目は全行が1行になり、件数と引き直す道具の1行が出る', async () => {
    const delta = new DigestSessionDelta();
    const first = await call(small(), delta);
    const second = await call(small(), delta);

    expect(first).not.toContain(SAME);
    expect(first).toContain('報告の本文が続く。');
    for (let n = 1; n <= 5; n += 1) {
      expect(second).toContain(`- mgr-00${String(n)} ${SAME}`);
    }
    expect(second).not.toContain('報告の本文が続く。');
    expect(second).toContain('前回と同じ行 5 本は省いた');
    expect(second).toContain('manager_report <managerId>');
    expect(second).toContain('refetch: true');
    expect(second.length).toBeLessThan(first.length / 2);
  });

  it('⭐ 1行だけ変われば、変わった行だけ全文で他は畳む（並びは保つ）', async () => {
    const delta = new DigestSessionDelta();
    await call(small(), delta);
    const changed = small();
    changed[2] = summary(3, { lastReport: '報告が新しくなった。' });
    const second = await call(changed, delta);

    expect(rowOf(second, 'mgr-003')).toContain('報告が新しくなった。');
    expect(second).toContain(`- mgr-001 ${SAME}`);
    expect(second).toContain(`- mgr-005 ${SAME}`);
    expect(second).toContain('前回と同じ行 4 本は省いた');
    // 並びは新しい順のまま（畳んだ行も元の位置に残る）
    expect(second.indexOf('- mgr-004')).toBeLessThan(second.indexOf('- mgr-003'));
    expect(second.indexOf('- mgr-003')).toBeLessThan(second.indexOf('- mgr-002'));
  });

  it('⭐ ⚠・lost・失敗・枠・runner 消失の行は、同じでも毎回全文', async () => {
    const abnormal = (): ManagerSummary[] => [
      summary(1),
      summary(2, { status: 'lost' }),
      summary(3, { status: 'running', usageStoppedAt: '2026-10-27T00:30:00.000Z' }),
      summary(4, { status: 'running', runnerVanished: true }),
      summary(5, {
        lastFailure: { code: 'rate_limit', via: 'assistant_error', at: '2026-10-27T00:20:00.000Z' },
      }),
      summary(6, { status: 'running', sessionMissingSince: '2026-10-27T00:10:00.000Z' }),
    ];
    const delta = new DigestSessionDelta();
    await call(abnormal(), delta);
    const second = await call(abnormal(), delta);

    expect(second).toContain(`- mgr-001 ${SAME}`);
    for (let n = 2; n <= 6; n += 1) {
      const row = rowOf(second, `mgr-00${String(n)}`);
      expect(row).not.toContain(SAME);
      expect(row).toContain('  cwd: /work');
    }
    expect(second).toContain('前回と同じ行 1 本は省いた');
  });

  it('⭐ A→B→A と戻った行は、2回前の A を「前回と同じ」と言わず全文で出す', async () => {
    const delta = new DigestSessionDelta();
    await call(small(), delta);
    const b = small();
    b[0] = summary(1, { lastReport: 'B の報告。' });
    await call(b, delta);
    const third = await call(small(), delta);

    expect(rowOf(third, 'mgr-001')).toContain('報告の本文が続く。');
    expect(third).toContain(`- mgr-002 ${SAME}`);
  });

  it('⭐ 前回出していない行（予算で省略・別の頁）は畳まない', async () => {
    const many = (): ManagerSummary[] => Array.from({ length: 40 }, (_, i) => summary(i + 1));
    const delta = new DigestSessionDelta();
    const first = await call(many(), delta);
    const shownIds = new Set([...first.matchAll(/^- (mgr-\d+) /gm)].map((m) => m[1]!));
    expect(shownIds.size).toBeGreaterThan(0);
    expect(shownIds.size).toBeLessThan(40);

    const second = await call(many(), delta);
    for (const id of shownIds) expect(second).toContain(`- ${id} ${SAME}`);
    // 省略された行は 2回目にも出ない。次の頁で初めて全文になる
    const cursor = /manager_list cursor=(\S+)/.exec(second)?.[1];
    expect(cursor).toBeDefined();
    const page2 = await call(many(), delta, { cursor });
    const page2Ids = [...page2.matchAll(/^- (mgr-\d+) /gm)].map((m) => m[1]!);
    expect(page2Ids.length).toBeGreaterThan(0);
    for (const id of page2Ids) {
      expect(shownIds.has(id)).toBe(false);
      expect(rowOf(page2, id)).toContain('報告の本文が続く。');
    }
  });

  it('⭐ reset（会話が変わった・compaction）の後は全文へ戻る', async () => {
    for (const reason of ['full', 'compaction'] as const) {
      const delta = new DigestSessionDelta();
      const first = await call(small(), delta);
      await call(small(), delta);

      delta.reset(reason);
      const afterReset = await call(small(), delta);

      expect(afterReset).toBe(first);
    }
  });

  it('⭐ 20 ターン保険（forgetFixed）の後も全文へ戻る', async () => {
    const delta = new DigestSessionDelta();
    const first = await call(small(), delta);
    delta.forgetFixed();

    expect(await call(small(), delta)).toBe(first);
  });

  it('⭐ 口が無い器（蒸留・テスト）は何度呼んでも全文', async () => {
    const first = await call(small(), null);
    const second = await call(small(), null);

    expect(second).toBe(first);
    expect(second).not.toContain(SAME);
  });

  it('⭐ refetch: true は畳まずに全文を出し直し、その次の呼びはまた畳む', async () => {
    const delta = new DigestSessionDelta();
    const first = await call(small(), delta);
    const refetched = await call(small(), delta, { refetch: true });
    const next = await call(small(), delta);

    expect(refetched).not.toContain(SAME);
    expect(refetched.split('報告の本文が続く。').length).toBe(
      first.split('報告の本文が続く。').length,
    );
    expect(next).toContain('前回と同じ行 5 本は省いた');
  });

  it('⭐ cursor の誤りで返した応答の手前で、行を「出した」と控えない', async () => {
    const delta = new DigestSessionDelta();
    const bad = await call(small(), delta, { cursor: 'not-a-cursor' });
    const first = await call(small(), delta);

    expect(bad).toContain('cursor が壊れている');
    expect(first).not.toContain(SAME);
  });
});
