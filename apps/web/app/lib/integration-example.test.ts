import { describe, expect, it } from 'vitest';

import { daemonOrigin } from './integration-example';

describe('連携の鍵の送り方の例の接続先（#3531）', () => {
  it('絶対 URL ならそのまま（末尾のスラッシュは落とす）', () => {
    expect(daemonOrigin('http://127.0.0.1:7777')).toBe('http://127.0.0.1:7777');
    expect(daemonOrigin('https://daemon.example.com//')).toBe('https://daemon.example.com');
  });

  it('相対（/api）は外から届く先と分からないので出さない', () => {
    expect(daemonOrigin('/api')).toBeNull();
    expect(daemonOrigin('/api/')).toBeNull();
  });
});
