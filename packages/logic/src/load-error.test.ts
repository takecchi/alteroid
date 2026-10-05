import { describe, expect, it } from 'vitest';

import { classifyLoadError } from './load-error.js';

class FakeApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

describe('classifyLoadError', () => {
  it('ネットワーク断（TypeError: Failed to fetch）は「つながっていない」で、生の文は detail にだけ入る', () => {
    const info = classifyLoadError(new TypeError('Failed to fetch'));
    expect(info.kind).toBe('network');
    expect(info.summary).toBe('デーモンにつながっていません。');
    expect(info.summary).not.toMatch(/fetch/i);
    expect(info.detail).toBe('Failed to fetch');
  });

  it('ブラウザごとの文言（Load failed / NetworkError）も通信の失敗に分ける', () => {
    expect(classifyLoadError(new Error('Load failed')).kind).toBe('network');
    expect(
      classifyLoadError(new Error('NetworkError when attempting to fetch resource.')).kind,
    ).toBe('network');
  });

  it('500 は「サーバーが失敗した」で、応答の文（boom）は主文に出さない', () => {
    const info = classifyLoadError(new FakeApiError(500, 'boom'));
    expect(info.kind).toBe('server');
    expect(info.summary).toContain('処理に失敗');
    expect(info.summary).not.toContain('boom');
    expect(info.detail).toBe('HTTP 500: boom');
    expect(info.retryable).toBe(true);
  });

  it.each([
    [401, 'unauthorized', true],
    [403, 'forbidden', false],
    [404, 'notFound', true],
    [422, 'rejected', true],
    [503, 'server', true],
  ] as const)('HTTP %i は %s（再試行 %s）', (status, kind, retryable) => {
    const info = classifyLoadError(new FakeApiError(status, 'x'));
    expect(info.kind).toBe(kind);
    expect(info.retryable).toBe(retryable);
  });

  it('文の無い応答は HTTP の番号だけを詳細に持つ', () => {
    expect(classifyLoadError(new FakeApiError(502, '')).detail).toBe('HTTP 502');
  });

  it('分類できないものは原因不明と言い、文字列の失敗もその文を詳細に持つ', () => {
    const info = classifyLoadError('weird');
    expect(info.kind).toBe('unknown');
    expect(info.detail).toBe('weird');
    expect(classifyLoadError(undefined).detail).toBeUndefined();
  });
});
