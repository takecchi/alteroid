import { describe, expect, it } from 'vitest';

import { createMemoryStores } from './testing.js';
import { createCloneTools } from './tools.js';

// `journal_read` の一覧で、見出しの伸びうる欄（escalation の approvalId など）が1件で予算（8,000字）を超えないことの歯。
// 固定値（clone-tools-journal-read-output-pin.json）の `list-budget-single` と同じ形の入力を使うが、
// こちらは「見出しが上限で切られる」「予算内に収まり続きの案内が出る」を名指しで確かめる（固定値は全文の一致だけを見る）。

type Append = Parameters<ReturnType<typeof createMemoryStores>['journal']['append']>[0];

const LONG = 9000;

async function listing(args: Record<string, unknown>, seed: Append[]): Promise<string> {
  const stores = createMemoryStores();
  for (const entry of seed) await stores.journal.append(entry);
  const tools = createCloneTools({
    stores,
    emit: () => undefined,
    memoryCause: () => 'clone',
    conversationId: () => undefined,
  });
  const found = tools.find((entry) => entry.name === 'journal_read');
  if (!found) throw new Error('journal_read が無い');
  const result = await found.handler(args as never, {});
  return (result.content ?? []).map((block) => (block.type === 'text' ? block.text : '')).join('');
}

const before: Append = {
  type: 'exchange',
  with: 'human',
  role: 'inbound',
  text: '手前の発言',
} as Append;

function longEscalation(extra: Record<string, unknown> = {}): Append {
  return {
    type: 'escalation',
    question: '長い id の承認',
    approvalId: `ap-${'x'.repeat(LONG)}`,
    ...extra,
  } as Append;
}

describe('journal_read の一覧: 見出しの上限', () => {
  it('approvalId が長くても、見出しは上限で切られ、切ったことが分かる', async () => {
    const text = await listing({ limit: 1, types: ['escalation'] }, [longEscalation()]);
    expect(text).not.toContain('x'.repeat(200));
    expect(text).toMatch(/approval=ap-x+…（\d[\d,]* 文字省略。全 9,003 文字）/);
    expect(text).toContain('未回答');
  });

  it('見出しが長い1件でも一覧は予算（8,000字）内に収まり、本文の抜粋は残る', async () => {
    const text = await listing({ limit: 1, types: ['escalation'] }, [longEscalation()]);
    expect(text.length).toBeLessThan(1000);
    expect(text).not.toContain('件は省略');
    expect(text).toContain('長い id の承認');
  });

  it('長い見出しの1件の後ろにも行があれば、両方出て続きの案内が出る', async () => {
    const text = await listing({ limit: 2 }, [before, before, longEscalation(), before]);
    expect(text).toContain('approval=ap-x');
    expect(text.length).toBeLessThan(2000);
    expect(text).not.toContain('件は省略');
    expect(text).toContain('続きは journal_read afterId=');
  });

  it('managerId・answeredVia の accountId など、ほかの欄が長くても同じに切られる', async () => {
    const text = await listing({ types: ['escalation'] }, [
      longEscalation({
        managerId: `mgr-${'m'.repeat(LONG)}`,
        answeredAt: '2026-10-26T00:30:00.000Z',
        answer: 'よい',
        answeredVia: { kind: 'account', accountId: `acct-${'a'.repeat(LONG)}` },
      }),
    ]);
    expect(text.length).toBeLessThan(1000);
    expect(text).toContain('回答済み');
  });

  it('通常の長さの見出しは1文字も変わらない', async () => {
    const text = await listing({ types: ['escalation'] }, [
      {
        type: 'escalation',
        question: '本番へ出してよいか',
        approvalId: '0f8fad5b-d9cb-469f-a165-70867728950e',
        managerId: 'mgr-1',
      } as Append,
    ]);
    expect(text).toContain(
      '[escalation approval=0f8fad5b-d9cb-469f-a165-70867728950e manager=mgr-1 未回答]',
    );
  });

  it('id を渡した全文読みの見出しは切らない', async () => {
    const text = await listing({ id: 'id-1' }, [longEscalation()]);
    expect(text).toContain(`approval=ap-${'x'.repeat(LONG)} `);
  });
});
