import { describe, expect, it } from 'vitest';

import { errorReason, formatElapsedAgo, withErrorReason } from './format.js';

/**
 * `formatElapsedAgo` の単体（issue #2141 段1）。
 *
 * **境目を1つずつ跨ぐ。** 分・時間・日の切り替えは `< 3600` / `< 86_400` の
 * 2つの条件で決まるので、境目のすぐ手前とちょうどの値を両方測る——どちらか
 * 片方だけでは、条件を `<=` に変異させても赤くならない。
 */
describe('formatElapsedAgo', () => {
  const NOW = new Date('2026-01-10T00:00:00.000Z').getTime();

  it('分（境目の手前・3550秒 = 59分）', () => {
    const at = new Date(NOW - 3550 * 1000).toISOString();
    expect(formatElapsedAgo(at, NOW)).toBe('59分前');
  });

  it('時間の境目（ちょうど3600秒 = 1時間）', () => {
    const at = new Date(NOW - 3600 * 1000).toISOString();
    expect(formatElapsedAgo(at, NOW)).toBe('1時間前');
  });

  it('時間（境目の手前・82800秒 = 23時間）', () => {
    const at = new Date(NOW - 82_800 * 1000).toISOString();
    expect(formatElapsedAgo(at, NOW)).toBe('23時間前');
  });

  it('日の境目（ちょうど86400秒 = 1日）', () => {
    const at = new Date(NOW - 86_400 * 1000).toISOString();
    expect(formatElapsedAgo(at, NOW)).toBe('1日前');
  });

  it('未来の時刻（時計のずれ）は0に丸める', () => {
    const at = new Date(NOW + 100_000).toISOString();
    expect(formatElapsedAgo(at, NOW)).toBe('0分前');
  });

  // 経緯（期待値の反転）: 旧 `formatElapsed` は単位だけ（`59分` / `不明`）を返し、呼び出し
  // 側が `前` を付けていたので、読めない時刻で `（不明前）` と出た（PR #2151）。「前」を
  // 返り値へ移し、読めない時刻は「前」の付かない `経過不明` にした。読める時刻の
  // 期待値は「前」が付いただけで、呼び出し側の見え方（N分前）は変わらない。
  it('読めない ISO は「経過不明」——「不明前」にも0分前のようにも読めない', () => {
    expect(formatElapsedAgo('not-a-real-timestamp', NOW)).toBe('経過不明');
    expect(formatElapsedAgo('', NOW)).not.toContain('不明前');
  });

  /**
   * 丸め（`Math.round`）が単位の上限を越えていた（PR #2151 の欠陥）。
   * 3570〜3599秒は `60分`、84,600〜86,399秒は `24時間`（`round(23.5)` から
   * 繰り上がる）と出ていた。上限の手前で止め、次の単位へ上がるのは境目ちょうど。
   */
  describe.each([
    [3569, '59分'],
    [3570, '59分'],
    [3599, '59分'],
    [3600, '1時間'],
    [84_599, '23時間'],
    [84_600, '23時間'],
    [86_369, '23時間'],
    [86_370, '23時間'],
    [86_399, '23時間'],
    [86_400, '1日'],
  ])('%i 秒前', (seconds, expected) => {
    it(`${expected}`, () => {
      const at = new Date(NOW - seconds * 1000).toISOString();
      expect(formatElapsedAgo(at, NOW)).toBe(`${expected}前`);
    });
  });
});

describe('errorReason / withErrorReason', () => {
  const json = (body: unknown) => ({ json: () => Promise.resolve(body) });

  it('{ error: 文字列 } の理由を取り出し、既存の文言の後ろへ足す', async () => {
    expect(await errorReason(json({ error: '台帳が壊れている' }))).toBe('台帳が壊れている');
    expect(await withErrorReason('失敗しました（500）', json({ error: '台帳が壊れている' }))).toBe(
      '失敗しました（500）: 台帳が壊れている',
    );
  });

  it('読めない本文（JSON でない・error が無い・空文字）は null で、既存の文言をそのまま返す', async () => {
    const notJson = { json: () => Promise.reject(new SyntaxError('Unexpected token <')) };
    for (const response of [
      notJson,
      json({}),
      json({ error: '' }),
      json({ error: 500 }),
      json(null),
    ]) {
      expect(await errorReason(response)).toBeNull();
      expect(await withErrorReason('失敗しました（500）', response)).toBe('失敗しました（500）');
    }
  });
});
