import { describe, expect, it } from 'vitest';

import { buildActivityDigest, DIGEST_BODY_SHAPE_LIMIT, DIGEST_SETTLED_LIMIT } from './digest.js';
import { DigestSessionDelta } from './digest-session-delta.js';
import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';

// 履歴の性格の節（片付けた仕事・本文の形）は、判断の材料の節より短く切る

const since = () => new Date(Date.now() - 600_000);

// i が大きいほど新しく閉じる（closedAt が 1 秒ずつ進む）
async function seedSettled(stores: Stores, count: number, from = 0): Promise<void> {
  const base = Date.now() - 300_000;
  for (let i = from; i < from + count; i += 1) {
    const at = new Date(base + i * 1000).toISOString();
    await stores.commitments.open({ id: `st-${i}`, at, origin: 'human', body: `片付け ${i}` });
    await stores.commitments.close(`st-${i}`, at, `理由 ${i}`, 'clone');
  }
}

function settledSection(digest: string): string {
  const start = digest.indexOf('## この期間に片付けた仕事');
  const end = digest.indexOf('\n## ', start + 1);
  return digest.slice(start, end === -1 ? undefined : end);
}

describe('この期間に片付けた仕事の一覧は DIGEST_SETTLED_LIMIT 件まで', () => {
  it('上限を超えるとき、新しい側の DIGEST_SETTLED_LIMIT 件だけが出て、省略の行が件数と引き方を名乗る', async () => {
    const stores = createMemoryStores();
    const total = DIGEST_SETTLED_LIMIT + 6;
    await seedSettled(stores, total);

    const digest = await buildActivityDigest(stores, { since: since() });
    const section = settledSection(digest);

    expect(digest).toContain(`- この期間に片付けた仕事: ${total} 件`);
    const shown = Array.from({ length: total }, (_, i) => i).filter((i) =>
      section.includes(`- 片付け ${i}\n`),
    );
    expect(shown).toEqual(
      Array.from({ length: DIGEST_SETTLED_LIMIT }, (_, k) => total - 1 - k).reverse(),
    );
    expect(section).toContain(`…ほか ${total - DIGEST_SETTLED_LIMIT} 件（`);
    expect(section).toContain('`commitment_list` に includeClosed=true を渡すと辿れる');
  });

  it('上限以下なら全件が出て、省略の行は出ない', async () => {
    const stores = createMemoryStores();
    await seedSettled(stores, DIGEST_SETTLED_LIMIT);

    const digest = await buildActivityDigest(stores, { since: since() });
    const section = settledSection(digest);

    expect(digest).toContain(`- この期間に片付けた仕事: ${DIGEST_SETTLED_LIMIT} 件`);
    for (let i = 0; i < DIGEST_SETTLED_LIMIT; i += 1) expect(section).toContain(`- 片付け ${i}\n`);
    expect(section).not.toContain('…ほか');
  });
});

describe('同じ会話の2回目の差分（DigestSessionDelta）が新しい行数でも壊れない', () => {
  it('片付けた仕事が増えて新しい5件へ入れ替わっても、新しい行と省略の行が出て、変わらない行は畳まれる', async () => {
    const stores = createMemoryStores();
    const delta = new DigestSessionDelta();
    await seedSettled(stores, DIGEST_SETTLED_LIMIT + 3);
    for (let i = 0; i < DIGEST_BODY_SHAPE_LIMIT + 2; i += 1) {
      await stores.journal.append({
        type: 'external_event',
        source: `src-${i}`,
        summary: `s ${i}`,
      });
    }

    const first = await buildActivityDigest(stores, { since: since() });
    const renderedFirst = delta.renderDigest(first, new Date());
    delta.commit();
    expect(renderedFirst.text).toBe(first);

    await seedSettled(stores, 1, DIGEST_SETTLED_LIMIT + 3);
    const second = await buildActivityDigest(stores, { since: since() });
    const renderedSecond = delta.renderDigest(second, new Date());

    const newest = DIGEST_SETTLED_LIMIT + 3;
    const section = settledSection(renderedSecond.text);
    expect(section).toContain(`- 片付け ${newest}\n`);
    expect(section).toContain(`…ほか ${newest + 1 - DIGEST_SETTLED_LIMIT} 件`);
    expect(section).toContain(`ほかの ${DIGEST_SETTLED_LIMIT - 1} 件は前回`);
    expect(renderedSecond.fullChars).toBe(second.length);
    expect(renderedSecond.text.length).toBeLessThan(second.length);
    // 本文の形（保持した標本）を含む外部イベントの節は、変わっていなければ節ごと畳まれる
    expect(first).toContain('…ほか 2 件');
    expect(renderedSecond.text).toContain('## 届いた外部イベント\n（前回（');
  });
});
