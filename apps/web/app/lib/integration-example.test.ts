import { describe, expect, it } from 'vitest';

import { exampleBaseUrl } from './integration-example';

describe('連携の鍵の送り方の例の接続先（#3210）', () => {
  it('同一オリジンの相対（/api）には origin を前に付けて絶対 URL にする', () => {
    expect(exampleBaseUrl('/api', 'https://alteroid.example.com')).toBe(
      'https://alteroid.example.com/api',
    );
  });

  it('末尾のスラッシュは落とす', () => {
    expect(exampleBaseUrl('/api/', 'https://alteroid.example.com')).toBe(
      'https://alteroid.example.com/api',
    );
    expect(exampleBaseUrl('https://daemon.example.com//', 'https://x.test')).toBe(
      'https://daemon.example.com',
    );
  });

  it('すでに絶対 URL ならそのまま（origin を足さない）', () => {
    expect(exampleBaseUrl('http://127.0.0.1:7777', 'https://alteroid.example.com')).toBe(
      'http://127.0.0.1:7777',
    );
  });
});
