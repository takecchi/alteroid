// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  hasStoredApiBaseUrl,
  resolveApiBaseUrl,
  resolveApiBaseUrlOrigin,
  SAME_ORIGIN_BASE_URL,
  storeApiBaseUrl,
} from './config.js';

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

/**
 * PR 1（接続先の切り替え）本3の歯: 3つの出どころが区別できることを固定する。
 *
 * `resolveApiBaseUrl` と同じ優先順位を、値ではなく**由来のラベル**として返す。
 * 3ケースとも `resolveApiBaseUrl` と対で確かめる — 値が同じでも由来が違うことが
 * この関数の存在理由なので、値のテストと分けて由来だけを見る。
 */
describe('resolveApiBaseUrlOrigin', () => {
  it('何も無ければ同一オリジン（sameOrigin）', () => {
    expect(resolveApiBaseUrlOrigin(null, undefined)).toBe('sameOrigin');
  });

  it('ビルド時の値だけがあれば buildTime', () => {
    expect(resolveApiBaseUrlOrigin(null, 'https://api.example.com')).toBe('buildTime');
  });

  it('人間が設定した値があれば stored（ビルド時の値があっても勝つ）', () => {
    expect(resolveApiBaseUrlOrigin('http://127.0.0.1:4517', 'https://api.example.com')).toBe(
      'stored',
    );
  });

  it('空白だけの保存値は「未設定」として扱う（sameOrigin まで倒れる）', () => {
    // resolveApiBaseUrl の「空白だけの値は未設定として扱う」と同じ規則を、
    // 由来の判定でも守ること（片方だけ直して片方が古い規則のままにならないように）。
    expect(resolveApiBaseUrlOrigin('   ', undefined)).toBe('sameOrigin');
    expect(resolveApiBaseUrlOrigin('   ', 'https://api.example.com')).toBe('buildTime');
  });
});

/**
 * `hasStoredApiBaseUrl` は `resolveApiBaseUrlOrigin` の上に載せ直してある
 * （引数を取らない実運用の形）。ここだけ `localStorage` が要るので jsdom を使う
 * （ファイル冒頭の `@vitest-environment jsdom`）。
 */
describe('hasStoredApiBaseUrl / storeApiBaseUrl', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('何も保存していなければ false', () => {
    expect(hasStoredApiBaseUrl()).toBe(false);
  });

  it('保存すると true になる', () => {
    storeApiBaseUrl('http://127.0.0.1:4517');
    expect(hasStoredApiBaseUrl()).toBe(true);
  });

  it('storeApiBaseUrl(null) で消える（「既定に戻す」の中身）', () => {
    storeApiBaseUrl('http://127.0.0.1:4517');
    expect(hasStoredApiBaseUrl()).toBe(true);

    storeApiBaseUrl(null);
    expect(hasStoredApiBaseUrl()).toBe(false);
    expect(localStorage.getItem('alteroid.apiBaseUrl')).toBeNull();
  });
});
