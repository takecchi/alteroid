import { describe, expect, it } from 'vitest';

import { readAttachmentLimits, TurnImageBudget } from './attachment.js';
import { MERGED_BATCH_SIZE_LIMIT } from './clone-batch-merge.js';
import { DEFAULT_PEER_LIMITS } from './peer-broker.js';
import { SYNTHESIZED_NOTICE_WINDOW_MS } from './synthesized-notice.js';

// 調整用に読んでいた 5 つの環境変数を外す前に置いた、「何も置かないときの値」の固定。
// 外した後も、この値は 1 字も変わらない（環境変数が読まれなくなるだけ）。外す前の旧コードでは
// `resolveSynthesizedNoticeWindowMs({})` / `resolveMergedBatchSizeLimit({})` / `resolvePeerLimits({})` で同じ値を確かめてある。

describe('外した調整用の環境変数: 定数に固定した既定値', () => {
  it('機構合成の知らせをまとめる窓は 3000ms', () => {
    expect(SYNTHESIZED_NOTICE_WINDOW_MS).toBe(3_000);
  });

  it('まとめ読みの束の上限は 50 件', () => {
    expect(MERGED_BATCH_SIZE_LIMIT).toBe(50);
  });

  it('peer: 同時に生きているセッションは 4 本・使われない時間は 30 分', () => {
    expect(DEFAULT_PEER_LIMITS).toEqual({ maxLiveSessions: 4, idleMs: 30 * 60_000 });
  });

  it('1 ターンで画像として渡す合計は 16 MiB（ちょうどは通り、1 バイト超えると bytes で外れる）', () => {
    const mib16 = 16 * 1024 * 1024;
    expect(readAttachmentLimits({}).limits.maxTurnImageBytes).toBe(mib16);
    const budget = new TurnImageBudget({});
    expect(budget.take(mib16)).toBeUndefined();
    expect(budget.take(1)).toBe('bytes');
  });
});
