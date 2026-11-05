import { describe, expect, it } from 'vitest';

import {
  FOLD_STATE_MAX_CHARS,
  parseFoldState,
  serializeFoldState,
  type FoldState,
} from './fold-state.js';

// 控えの字面の検査が目的なので、中身のある写しを直接書く（畳みを外したので、`DigestSessionDelta` はもう中身のある控えを作れない）
function sample(): FoldState {
  return {
    v: 1,
    sessionId: 'sess-1',
    situation: [['readings', '全文']],
    turnsSinceFull: 3,
    digest: {
      sections: {
        at: '2026-09-05T01:00:00.000Z',
        sections: [['## 節A', '- 行1']],
      },
      fixed: ['digest:phrase'],
      requests: [['weekly', { text: '依頼本文', at: '2026-09-05T00:00:00.000Z' }]],
      paragraphs: ['p'],
      reports: [['mgr-a', { key: 'k', chars: 1_200, at: '2026-09-05T00:00:00.000Z' }]],
    },
    usage: { totalTokens: 10_000, autoCompactThreshold: 200_000, isAutoCompactEnabled: true },
    growthTokens: 500,
  };
}

describe('畳みの控えの形（fold-state）', () => {
  it('書いたものを、そのまま読み戻せる', () => {
    const raw = serializeFoldState(sample());

    expect(raw).not.toBeNull();
    expect(parseFoldState(raw ?? '')).toEqual(sample());
  });

  it('⭐ 壊れている・形が合わない控えは、投げずに null（全文へ倒れる）', () => {
    const base = JSON.parse(serializeFoldState(sample()) ?? '{}') as Record<string, unknown>;
    const broken: unknown[] = [
      '{壊れた',
      '[]',
      'null',
      '"x"',
      { ...base, v: 2 },
      { ...base, sessionId: '' },
      { ...base, sessionId: 5 },
      { ...base, situation: 'x' },
      { ...base, situation: [['readings']] },
      { ...base, turnsSinceFull: -1 },
      { ...base, turnsSinceFull: 1.5 },
      { ...base, digest: null },
      { ...base, digest: { ...(base.digest as object), fixed: 5 } },
      { ...base, digest: { ...(base.digest as object), sections: { at: 'いつか', sections: [] } } },
      { ...base, usage: 'x' },
    ];
    for (const candidate of broken) {
      const raw = typeof candidate === 'string' ? candidate : JSON.stringify(candidate);
      expect(parseFoldState(raw), raw.slice(0, 60)).toBeNull();
    }
  });

  it('大きすぎる控えは預けない（null）', () => {
    const big = sample();
    big.situation = [['readings', 'あ'.repeat(FOLD_STATE_MAX_CHARS)]];

    expect(serializeFoldState(big)).toBeNull();
  });
});
