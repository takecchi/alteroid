import { describe, expect, it } from 'vitest';

import { resolveApiBaseUrl, SAME_ORIGIN_BASE_URL } from './config.js';

describe('resolveApiBaseUrl', () => {
  it('何も無ければ同一オリジンに落ちる', () => {
    expect(resolveApiBaseUrl(null, undefined)).toBe(SAME_ORIGIN_BASE_URL);
  });

  it('ビルド時の値を使う', () => {
    expect(resolveApiBaseUrl(null, 'https://api.example.com')).toBe('https://api.example.com');
  });

  it('人間が設定した値がビルド時の値に勝つ', () => {
    expect(resolveApiBaseUrl('http://127.0.0.1:4517', 'https://api.example.com')).toBe(
      'http://127.0.0.1:4517',
    );
  });

  it('末尾のスラッシュを落とす（経路の連結で // にしないため）', () => {
    expect(resolveApiBaseUrl('https://api.example.com/', undefined)).toBe(
      'https://api.example.com',
    );
  });

  it('空白だけの値は未設定として扱う', () => {
    // 「消したつもりの値が残る」を防ぐ。'' を通すと同一オリジンと区別が付かない。
    expect(resolveApiBaseUrl('   ', 'https://api.example.com')).toBe('https://api.example.com');
    expect(resolveApiBaseUrl('   ', '  ')).toBe(SAME_ORIGIN_BASE_URL);
  });
});
