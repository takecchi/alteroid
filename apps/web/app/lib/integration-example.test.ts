import { describe, expect, it } from 'vitest';

import { claudeMcpAddCommand, daemonOrigin, ORIGIN_PLACEHOLDER } from './integration-example';

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

describe('Claude Code から報告に使う登録コマンド', () => {
  it('claude mcp add --transport http の形で、接続先が分かれば /mcp まで入れ、鍵の値は置き場の印だけにする', () => {
    expect(claudeMcpAddCommand('http://127.0.0.1:7777')).toBe(
      'claude mcp add --transport http alteroid-report http://127.0.0.1:7777/mcp \\\n' +
        '  --header "Authorization: Bearer <上の値>"',
    );
  });

  it('接続先が分からないときは推測せず印を置く', () => {
    expect(claudeMcpAddCommand(null)).toContain(`${ORIGIN_PLACEHOLDER}/mcp`);
    expect(claudeMcpAddCommand(null)).not.toContain('altk_');
  });
});
