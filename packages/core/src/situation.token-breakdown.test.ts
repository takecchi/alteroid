import { describe, expect, it } from 'vitest';

import { describeTokenSituation, type TokenSituationRow } from './situation.js';

describe('describeTokenSituation のプール内訳（#1794 人間が外した／失効の分割）', () => {
  const AT = Date.parse('2026-09-27T00:00:00.000Z');

  const row = (
    over: Partial<TokenSituationRow> & { id: string; label: string },
  ): TokenSituationRow => ({
    ...over,
  });

  it('`disabled` と `invalidated` が両方あるとき、別の語・別の数で出す', () => {
    const line = describeTokenSituation({
      tokens: [
        row({ id: 'a', label: 'A-disabled-by-human', disabledAt: '2026-09-01T00:00:00.000Z' }),
        row({
          id: 'b',
          label: 'B-invalidated-by-system',
          invalidatedAt: '2026-09-02T00:00:00.000Z',
        }),
        row({ id: 'c', label: 'C-ready' }),
      ],
      active: null,
      at: AT,
    });

    expect(line).not.toContain('外されている');
    expect(line).toContain('人間が外している 1');
    expect(line).toContain('失効 1');
    expect(line).toContain('いま使える 1');
    expect(line).toContain('冷却中 0');
  });

  it('`disabled` だけのとき、`invalidated` は 0 として出す（省かない）', () => {
    const line = describeTokenSituation({
      tokens: [row({ id: 'a', label: 'off', disabledAt: '2026-09-01T00:00:00.000Z' })],
      active: null,
      at: AT,
    });

    expect(line).toContain('人間が外している 1');
    expect(line).toContain('失効 0');
  });

  it('`invalidated` だけのとき、`disabled` は 0 として出す（省かない）', () => {
    const line = describeTokenSituation({
      tokens: [row({ id: 'a', label: 'dead', invalidatedAt: '2026-09-01T00:00:00.000Z' })],
      active: null,
      at: AT,
    });

    expect(line).toContain('人間が外している 0');
    expect(line).toContain('失効 1');
  });

  it('両方 0 本のとき、両方の区分をそれぞれ 0 で出す', () => {
    const line = describeTokenSituation({
      tokens: [row({ id: 'a', label: 'ready' })],
      active: null,
      at: AT,
    });

    expect(line).toContain('プール 1 本: いま使える 1 / 冷却中 0 / 人間が外している 0 / 失効 0');
    expect(line).not.toContain('外されている');
  });

  it('`disabledAt` が先に判定される行（両方の日付を持つ）は「人間が外している」に数える', () => {
    const line = describeTokenSituation({
      tokens: [
        row({
          id: 'a',
          label: 'both',
          disabledAt: '2026-09-01T00:00:00.000Z',
          invalidatedAt: '2026-09-02T00:00:00.000Z',
        }),
      ],
      active: null,
      at: AT,
    });

    expect(line).toContain('人間が外している 1');
    expect(line).toContain('失効 0');
  });

  it('個々のトークンの状態表示（`TOKEN_STATE_LABEL`）と同じ語を使い回している', () => {
    const line = describeTokenSituation({
      tokens: [row({ id: 'a', label: 'off', disabledAt: '2026-09-01T00:00:00.000Z' })],
      active: { tokenId: 'a' },
      at: AT,
    });

    expect(line).toContain('記録の上では 人間が外している');
    expect(line).toContain('人間が外している 1');
  });
});
