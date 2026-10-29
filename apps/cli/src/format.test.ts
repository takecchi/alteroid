import { describe, expect, it } from 'vitest';

import {
  describeFailedResponse,
  errorReason,
  formatElapsedAgo,
  oneLine,
  shortId,
  withErrorReason,
} from './format.js';
import { describeAuthFailure } from './target.js';

describe('shortId', () => {
  it('12 字以下はそのまま、超えたら 12 字で切って … を付ける', () => {
    expect(shortId('abcdefghijkl')).toBe('abcdefghijkl');
    expect(shortId('abcdefghijklm')).toBe('abcdefghijkl…');
  });
});

describe('oneLine', () => {
  it('空白を潰して切る', () => {
    expect(oneLine('a \n  b', 10)).toBe('a b');
    expect(oneLine('abcdef', 3)).toBe('abc…');
  });

  // サロゲートペアを割らない（#2592）
  it('孤立した上位サロゲートを残さない', () => {
    const out = oneLine(`a${'😀'.repeat(400)}`, 300);
    expect(out).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(out.endsWith('…')).toBe(true);
  });
});

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

  it('読めない ISO は「経過不明」——「不明前」にも0分前のようにも読めない', () => {
    expect(formatElapsedAgo('not-a-real-timestamp', NOW)).toBe('経過不明');
    expect(formatElapsedAgo('', NOW)).not.toContain('不明前');
  });

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

describe('describeFailedResponse', () => {
  const target = { baseUrl: 'http://127.0.0.1:4517', headers: {}, remote: false, note: null };
  const response = (status: number, body: unknown) => ({
    status,
    json: () => Promise.resolve(body),
  });

  it('401 は本文の理由より先に、認証の案内を返す', async () => {
    expect(
      await describeFailedResponse('失敗しました', response(401, { error: '理由' }), target),
    ).toBe(describeAuthFailure(401, target));
  });

  it('認証の案内が無い status は、デーモンの理由を文言の後ろへ足す', async () => {
    expect(
      await describeFailedResponse('失敗しました（500）', response(500, { error: '理由' }), target),
    ).toBe('失敗しました（500）: 理由');
  });

  it('理由が無ければ、文言をそのまま返す', async () => {
    expect(await describeFailedResponse('失敗しました（500）', response(500, {}), target)).toBe(
      '失敗しました（500）',
    );
  });
});
