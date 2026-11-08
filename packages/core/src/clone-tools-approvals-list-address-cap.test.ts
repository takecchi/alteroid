import { describe, expect, it } from 'vitest';

import type { PendingApproval } from './schema.js';
import { createMemoryStores } from './testing.js';
import { createCloneTools } from './tools.js';

// `approvals_list` の一覧で、各件の「宛先」行（managerId・requestId）が1件で予算（8,000字）を使い切らないことの歯。
// 固定値（clone-tools-approvals-list-output-pin.json）は全文の一致だけを見る。こちらは「80 字で切る」「古い件が押し出されない」を名指しで確かめる（#6620）。

const LONG = 9000;

async function call(args: Record<string, unknown>, seed: PendingApproval[]): Promise<string> {
  const stores = createMemoryStores();
  for (const entry of seed) await stores.jobs.putApproval(entry);
  const tools = createCloneTools({
    stores,
    emit: () => undefined,
    memoryCause: () => 'clone',
    conversationId: () => undefined,
  });
  const found = tools.find((entry) => entry.name === 'approvals_list');
  if (!found) throw new Error('approvals_list が無い');
  const result = await found.handler(args as never, {});
  return (result.content ?? []).map((block) => (block.type === 'text' ? block.text : '')).join('');
}

function ap(id: string, minute: number, extra: Partial<PendingApproval> = {}): PendingApproval {
  const createdAt = new Date(Date.parse('2026-10-01T00:00:00.000Z') + minute * 60_000);
  return { id, createdAt: createdAt.toISOString(), question: `質問 ${id}`, ...extra };
}

describe('approvals_list の一覧: 宛先行の上限', () => {
  it('jobId・requestId が長くても 80 字で切られ、切ったことが分かる', async () => {
    const text = await call({}, [
      ap('long-1', 1, { jobId: `m-${'x'.repeat(LONG)}`, requestId: `r-${'y'.repeat(LONG)}` }),
    ]);
    const head = `m-${'x'.repeat(78)}`;
    const reqHead = `r-${'y'.repeat(78)}`;
    const note = '…（8,922 文字省略。全 9,002 文字）';
    expect(text).toContain(`宛先: managerId: "${head}${note}"`);
    expect(text).toContain(`requestId: "${reqHead}${note}"`);
    expect(text.length).toBeLessThan(2000);
  });

  it('1件が長くても全体の予算内に収まり、古い件の詳細が押し出されない', async () => {
    const seed = [
      ap('old-1', 1, { jobId: 'mgr-old' }),
      ap('old-2', 2),
      ap('new-1', 3, { jobId: `m-${'x'.repeat(LONG)}`, requestId: `r-${'y'.repeat(LONG)}` }),
    ];
    const text = await call({}, seed);
    expect(text.length).toBeLessThanOrEqual(8_000);
    expect(text).not.toContain('詳細を省略');
    expect(text).toContain('old-1');
    expect(text).toContain('宛先: managerId: "mgr-old"');
    expect(text).toContain('old-2');
  });

  it('80 字以内の宛先は変わらない（80 字ちょうども切らない）', async () => {
    const job80 = 'j'.repeat(80);
    const req80 = 'r'.repeat(80);
    const text = await call({}, [
      ap('short-1', 1, { jobId: 'mgr-1', requestId: 'req-1' }),
      ap('edge-1', 2, { jobId: job80, requestId: req80 }),
    ]);
    expect(text).toContain('宛先: managerId: "mgr-1", requestId: "req-1"');
    expect(text).toContain(`宛先: managerId: "${job80}", requestId: "${req80}"`);
    expect(text).not.toContain('文字省略');
  });

  it('id 指定の全文読みは宛先を切らない', async () => {
    const jobId = `m-${'x'.repeat(LONG)}`;
    const requestId = `r-${'y'.repeat(LONG)}`;
    const text = await call({ id: 'full-1' }, [ap('full-1', 1, { jobId, requestId })]);
    expect(text).toContain(`managerId: "${jobId}"`);
    expect(text).toContain(`requestId: "${requestId}"`);
  });
});
