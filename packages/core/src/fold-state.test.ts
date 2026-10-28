import { describe, expect, it } from 'vitest';

import { DigestSessionDelta } from './digest-session-delta.js';
import {
  FOLD_STATE_MAX_CHARS,
  parseFoldState,
  serializeFoldState,
  type FoldState,
} from './fold-state.js';

function sample(): FoldState {
  const delta = new DigestSessionDelta();
  delta.fixed('digest:phrase', '長い全文', '参照');
  delta.reportShown('mgr-a', 'あ'.repeat(1_200), new Date('2026-09-05T00:00:00.000Z'));
  delta.requestSeenAt('weekly', '依頼本文', new Date('2026-09-05T00:00:00.000Z'));
  delta.renderDigest('まえがき\n## 節A\n- 行1\n', new Date('2026-09-05T01:00:00.000Z'));
  delta.commit();
  return {
    v: 1,
    sessionId: 'sess-1',
    situation: [['readings', '全文']],
    turnsSinceFull: 3,
    digest: delta.exportState(),
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

  it('DigestSessionDelta へ戻すと、畳んだ記録（固定文・要約の節）が続く', () => {
    const restored = new DigestSessionDelta();
    restored.importState(sample().digest);

    expect(restored.fixed('digest:phrase', '長い全文', '参照')).toBe('参照');
    // 要約を1度出した記録があるので、最初の要約から完全な全文へ倒す理由は無い
    expect(restored.isLean()).toBe(false);
    expect(
      restored.renderDigest('まえがき\n## 節A\n- 行1\n', new Date('2026-09-05T02:00:00.000Z')).text,
    ).toContain('前回（01:00Z）の要約から変わっていない');
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
