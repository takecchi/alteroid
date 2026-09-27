import { describe, expect, it } from 'vitest';

import { describeTokenSituation, type TokenSituationRow } from './situation.js';

/**
 * #1794 専用の歯。
 *
 * `describeTokenSituation`（`situation.ts`）のプール内訳が、`disabledAt`（人間が
 * 明示的に外した）と `invalidatedAt`（恒常的に通らないと確定した＝失効）を1つの
 * 「外されている」へ合算していた——`token_list`（`tools.ts`）側はこの2つを別の語
 * （「人間が外した」「失効（原文）」）で分けて出しており、字面が食い違っていた。
 *
 * **ここで測るのは内訳の分け方だけである。** `situation.test.ts` の
 * `枠を理由に見送らせない（describeTokenSituation）` は、この関数の他の性質
 * （不変条件が落ちない・現役の指名の扱い等）を測るので、ここでは重複しない。
 */
describe('describeTokenSituation のプール内訳（#1794 人間が外した／失効の分割）', () => {
  const AT = Date.parse('2026-09-27T00:00:00.000Z');

  const row = (
    over: Partial<TokenSituationRow> & { id: string; label: string },
  ): TokenSituationRow => ({
    ...over,
  });

  it('`disabled` と `invalidated` が両方あるとき、別の語・別の数で出す', () => {
    // Issue #1794 本文の再現そのもの。
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

    // **合算した語は出ない。** 直す前はここが「外されている 2」になっていた
    // ——`disabled` 1本と `invalidated` 1本が同じ数へ潰れ、読み手はどちらの
    // 理由で外れているかをこの行からは判別できなかった。
    expect(line).not.toContain('外されている');
    // **2つの語が別々の本数を持つ。**
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

    // **0 の区分も省かない**——既存の内訳が「いま使える 0」を出す作法に揃える
    // （`situation.test.ts` の「`active` だけ読めなかった回は……」の歯と同じ判断）。
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
    // `tokenStateOf`（判定順を崩さないこと、という doc がある）に手を入れない
    // ——ここは表示側だけを測る歯なので、判定の優先順位が `disabledAt` 先着で
    // あることを前提のまま確かめる。
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
    // 文言を複製していないことの回帰——`current`（現役の状態を言う行）が使う
    // `TOKEN_STATE_LABEL[state]` と、内訳が使う語が字面で一致するかを見る。
    const line = describeTokenSituation({
      tokens: [row({ id: 'a', label: 'off', disabledAt: '2026-09-01T00:00:00.000Z' })],
      active: { tokenId: 'a' },
      at: AT,
    });

    // 現役の行は「記録の上では 人間が外している」、内訳は「人間が外している 1」——
    // どちらも同じ日本語の語である。
    expect(line).toContain('記録の上では 人間が外している');
    expect(line).toContain('人間が外している 1');
  });
});
