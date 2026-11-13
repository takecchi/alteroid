import { describe, expect, it } from 'vitest';

import config from '../vitest.config.js';

// 実物の PostgreSQL（CI の `storage-pg を本物の PostgreSQL で`）では、storage-pg の試験の1本が、手元の実測の数倍かかる。
// #6784: `tasks.test.ts` の「3実装共通の契約を満たす」が、手元では 780ms なのに main の CI で 5779ms かかり、vitest の既定の
// 5000ms で落ちた（同じ workflow は次の main で通った。時間の揺れ）。同じ形の契約の試験は、手元でも 2〜3 秒かかるものが
// 明示の上限を持たず（`approval-conversation-filter-contract`・`journal-type-seq-index` ほか）、同じ倍率なら 15〜20 秒になる。
// 試験ごとに上限を足すと、次の新しい試験が同じ形で落ちるので、パッケージの既定を、このパッケージの明示の上限で最も多い 30_000 にする。
// 下げるなら、実物の PostgreSQL の CI での最長の所要（手元の 2.8 秒 × 7.4 倍 ≒ 20 秒）を超えることを確かめてから。
const FLOOR_MS = 30_000;

describe('storage-pg の試験の既定の上限（#6784）', () => {
  it(`実物の PostgreSQL の CI で数倍かかっても落ちないよう、${String(FLOOR_MS)}ms 以上にしてある`, () => {
    expect(config.test?.testTimeout).toBeGreaterThanOrEqual(FLOOR_MS);
  });
});
