import { describe, expect, it } from 'vitest';

import { buildActivityDigest, DIGEST_BODY_SHAPE_LIMIT, MAX_ITEMS } from './digest.js';
import { DigestSessionDelta } from './digest-session-delta.js';
import { createMemoryStores } from './testing.js';

// 履歴の性格の節（本文の形）は、判断の材料の節より短く切る。
// 「この期間に片付けた仕事」の節（DIGEST_SETTLED_LIMIT 件までの歯）は #5469 P6b で節ごと無くなった。
// 閉じた件は `task_list includeClosed` と日誌で読み返せる。ここに残る「新しい行数でも差分化が壊れない」歯は、同じ作りの一覧の節（聞かずに決めたこと）で測る

const since = () => new Date(Date.now() - 600_000);

function decisionsSection(digest: string): string {
  const start = digest.indexOf('## 聞かずに決めたこと');
  const end = digest.indexOf('\n## ', start + 1);
  return digest.slice(start, end === -1 ? undefined : end);
}

describe('同じ会話の2回目の差分（DigestSessionDelta）が新しい行数でも壊れない', () => {
  it('一覧の節の行が増えて新しい MAX_ITEMS 件へ入れ替わっても、新しい行と省略の行が出て、変わらない行は畳まれる', async () => {
    const stores = createMemoryStores();
    const delta = new DigestSessionDelta();
    const seeded = MAX_ITEMS + 3;
    for (let i = 0; i < seeded; i += 1) {
      await stores.journal.append({ type: 'decision', decision: `決めた ${i}`, grounds: '記憶' });
    }
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

    await stores.journal.append({
      type: 'decision',
      decision: `決めた ${seeded}`,
      grounds: '記憶',
    });
    const second = await buildActivityDigest(stores, { since: since() });
    const renderedSecond = delta.renderDigest(second, new Date());

    const section = decisionsSection(renderedSecond.text);
    expect(section).toContain(`決めた ${seeded}（`);
    expect(section).toContain(`…ほか ${seeded + 1 - MAX_ITEMS} 件`);
    expect(section).toContain(`ほかの ${MAX_ITEMS - 1} 件は前回`);
    expect(renderedSecond.fullChars).toBe(second.length);
    expect(renderedSecond.text.length).toBeLessThan(second.length);
    // 本文の形（保持した標本）を含む外部イベントの節は、変わっていなければ節ごと畳まれる
    expect(first).toContain('…ほか 2 件');
    expect(renderedSecond.text).toMatch(/変わらない節: 届いた外部イベント・使った分。/u);
    expect(renderedSecond.text).not.toContain('発行元（source）別の件数');
  });
});
