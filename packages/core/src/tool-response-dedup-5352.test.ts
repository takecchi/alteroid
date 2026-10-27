import { describe, expect, it } from 'vitest';

import { createMemoryStores } from './testing.js';
import { COMMITMENT_BODY_LIMIT, createCloneTools } from './tools.js';

function harness() {
  const stores = createMemoryStores();
  const tools = createCloneTools({
    stores,
    emit: () => undefined,
    conversationId: () => undefined,
    memoryCause: () => 'clone',
  });
  return {
    stores,
    description(name: string): string {
      return tools.find((entry) => entry.name === name)!.description;
    },
    async call(name: string, args: Record<string, unknown>): Promise<string> {
      const found = tools.find((entry) => entry.name === name);
      if (!found) throw new Error(`ツール ${name} が無い`);
      const result = await found.handler(args as never, {});
      return (result.content ?? [])
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join('');
    },
  };
}

const FETCH_FULL = 'commitment_list id=<id>';
const count = (text: string, needle: string): number => text.split(needle).length - 1;

describe('approvals_list は作成だけを出し、更新が出ない理由は説明文が言う（#5352）', () => {
  it('更新も、更新＝作成の説明の注記も応答に出ない。作成は各件に1つ', async () => {
    const h = harness();
    for (const n of [1, 2, 3]) {
      await h.stores.jobs.putApproval({
        id: `ap-${n}`,
        createdAt: `2026-05-0${n}T00:00:00.000Z`,
        question: `続けてよいか${n}`,
      });
    }
    const reply = await h.call('approvals_list', {});
    expect(reply).not.toContain('更新');
    for (const n of [1, 2, 3]) expect(count(reply, `2026-05-0${n}T00:00:00.000Z`)).toBe(1);
    expect(h.description('approvals_list')).toContain('更新はいつも作成と同じ');
  });
});

describe('commitment_list の更新と状態の札（#5352）', () => {
  async function seed(h: ReturnType<typeof harness>) {
    await h.stores.commitments.open({
      id: 'c-open',
      at: '2026-02-01T00:00:00.000Z',
      origin: 'external',
      body: '未了のまま',
    });
    await h.stores.commitments.open({
      id: 'c-closed',
      at: '2026-02-02T00:00:00.000Z',
      origin: 'manager',
      body: '片付いた',
    });
    await h.stores.commitments.close('c-closed', '2026-02-03T00:00:00.000Z', '対応済み', 'clone');
  }

  it('includeClosed なしでは行に「状態: 未了」を付けず、先頭の1行で言う。更新は出ない', async () => {
    const h = harness();
    await seed(h);
    const reply = await h.call('commitment_list', {});
    expect(reply).not.toContain('状態:');
    expect(reply).not.toContain('更新');
    expect(reply.split('\n')[0]).toBe('（以下はすべて未了）');
    expect(count(reply, '以下はすべて未了')).toBe(1);
  });

  it('includeClosed では行ごとに状態を出し、更新が作成と違う行だけ両方の時刻を出す', async () => {
    const h = harness();
    await seed(h);
    const reply = await h.call('commitment_list', { includeClosed: true });
    const lines = reply.split('\n');
    expect(reply).not.toContain('以下はすべて未了');
    expect(lines).toContain('  状態: 未了');
    expect(lines).toContain('  状態: 2026-02-03T00:00:00.000Z に片付けた（対応済み）');
    expect(lines).toContain('  作成: 2026-02-01T00:00:00.000Z');
    expect(lines).toContain('  作成: 2026-02-02T00:00:00.000Z / 更新: 2026-02-03T00:00:00.000Z');
  });

  it('説明文が、更新が出ないときの読み方を言う', () => {
    expect(harness().description('commitment_list')).toContain('更新が出ないときは作成と同じ');
  });
});

describe('commitment_list は全文の取り方を末尾の1か所で言い、字数は定数から組む（#5353）', () => {
  it('本文が240字を超えて切れた応答でも、全文の取り方は1回だけ。字数は COMMITMENT_BODY_LIMIT', async () => {
    const h = harness();
    await h.stores.commitments.open({
      id: 'c-long',
      at: '2026-03-01T00:00:00.000Z',
      origin: 'human',
      body: 'あ'.repeat(COMMITMENT_BODY_LIMIT + 100),
    });
    const reply = await h.call('commitment_list', {});
    expect(reply).toContain('省略');
    expect(count(reply, FETCH_FULL)).toBe(1);
    expect(reply).toContain(`本文は${COMMITMENT_BODY_LIMIT}字の抜粋`);
    expect(reply.trimEnd().split('\n').at(-1)).toContain(FETCH_FULL);
  });

  it('予算で行が省かれた応答でも、全文の取り方は末尾の1回だけで、省略の断り書きは続きの cursor を案内する', async () => {
    const h = harness();
    for (let n = 0; n < 60; n += 1) {
      await h.stores.commitments.open({
        id: `c-${String(n).padStart(3, '0')}`,
        at: `2026-04-01T00:${String(n).padStart(2, '0')}:00.000Z`,
        origin: 'human',
        body: `${n}:${'あ'.repeat(COMMITMENT_BODY_LIMIT)}`,
      });
    }
    const reply = await h.call('commitment_list', {});
    expect(reply).toMatch(/…ほか \d+ 件は省略/);
    expect(reply).toContain('commitment_list cursor=');
    expect(count(reply, FETCH_FULL)).toBe(1);
    const omittedLine = reply.split('\n').find((line) => line.startsWith('…ほか'))!;
    expect(omittedLine).not.toContain(FETCH_FULL);
    expect(omittedLine.endsWith('）。')).toBe(true);
  });

  it('切れていない応答にも、全文の取り方は従来どおり1回出る', async () => {
    const h = harness();
    await h.stores.commitments.open({
      id: 'c-short',
      at: '2026-03-01T00:00:00.000Z',
      origin: 'human',
      body: '短い依頼',
    });
    const reply = await h.call('commitment_list', {});
    expect(reply).not.toContain('省略');
    expect(count(reply, FETCH_FULL)).toBe(1);
  });
});

describe('practice_history は作成だけを出す（#5352）', () => {
  it('各版の時刻は1つ。更新は出ず、説明文が理由を言う', async () => {
    const h = harness();
    for (const content of ['一版', '二版']) {
      await h.stores.practices.write({ slug: 'daily', kind: '日報', title: '日報', content });
    }
    const reply = await h.call('practice_history', { slug: 'daily' });
    expect(reply).toContain('版1');
    expect(reply).toContain('版2');
    expect(reply).not.toContain('更新');
    expect(count(reply, '作成: ')).toBe(2);
    expect(h.description('practice_history')).toContain('更新はいつも作成と同じ');
  });
});
