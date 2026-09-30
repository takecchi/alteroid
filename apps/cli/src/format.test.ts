import { describe, expect, it } from 'vitest';

import { errorReason, formatElapsed, withErrorReason } from './format.js';

/**
 * `formatElapsed` の単体（issue #2141 段1）。
 *
 * **境目を1つずつ跨ぐ。** 分・時間・日の切り替えは `< 3600` / `< 86_400` の
 * 2つの条件で決まるので、境目のすぐ手前とちょうどの値を両方測る——どちらか
 * 片方だけでは、条件を `<=` に変異させても赤くならない。
 */
describe('formatElapsed', () => {
  const NOW = new Date('2026-01-10T00:00:00.000Z').getTime();

  it('分（境目の手前・3550秒 = 59分）', () => {
    const at = new Date(NOW - 3550 * 1000).toISOString();
    expect(formatElapsed(at, NOW)).toBe('59分');
  });

  it('時間の境目（ちょうど3600秒 = 1時間）', () => {
    const at = new Date(NOW - 3600 * 1000).toISOString();
    expect(formatElapsed(at, NOW)).toBe('1時間');
  });

  it('時間（境目の手前・82800秒 = 23時間）', () => {
    const at = new Date(NOW - 82_800 * 1000).toISOString();
    expect(formatElapsed(at, NOW)).toBe('23時間');
  });

  it('日の境目（ちょうど86400秒 = 1日）', () => {
    const at = new Date(NOW - 86_400 * 1000).toISOString();
    expect(formatElapsed(at, NOW)).toBe('1日');
  });

  it('未来の時刻（時計のずれ）は0に丸める', () => {
    const at = new Date(NOW + 100_000).toISOString();
    expect(formatElapsed(at, NOW)).toBe('0分');
  });

  it('読めない ISO は「不明」——0分前のように読める値を作らない', () => {
    expect(formatElapsed('not-a-real-timestamp', NOW)).toBe('不明');
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
