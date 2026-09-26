import { describe, expect, it } from 'vitest';

import { maskUrl } from './mask-url.js';

describe('maskUrl（CLI と Web の正本。issue #1622）', () => {
  it('クエリ・フラグメント・認証情報を伏せ、読めない URL は丸ごと伏せる', () => {
    expect(maskUrl('https://example.com/mcp')).toBe('https://example.com/mcp');
    expect(maskUrl('https://example.com/mcp?token=x')).toBe('https://example.com/mcp?***');
    expect(maskUrl('https://u:p@example.com/mcp')).toBe('https://example.com/mcp?***');
    expect(maskUrl('https://u@example.com/mcp')).toBe('https://example.com/mcp?***');
    expect(maskUrl('https://example.com/mcp#k')).toBe('https://example.com/mcp?***');
    expect(maskUrl('not a url with secret')).toBe('***');
  });

  /**
   * 🔴 **password だけの userinfo（`username` が空文字）も伏せる。** `username` だけを
   * 見ていた判定では、この形の秘密がそのまま出た（#1622）。
   */
  it('password だけの userinfo（https://:秘密@host）の秘密を出さない', () => {
    const masked = maskUrl('https://:sk-very-secret-value@mcp.example.com/mcp');
    expect(masked).toBe('https://mcp.example.com/mcp?***');
    expect(masked).not.toContain('sk-very-secret-value');
  });
});
