import { describe, expect, it } from 'vitest';

import { mcpServersVersionOf } from './mcp-servers.js';
import { tokenPoolVersionOf, type AgentToken } from './token-pool.js';

// 版は「正規化した文字列の sha256（hex 全長）」。値を固定して、入力の組み立て・符号化・桁の取り違えを縛る
const token = (
  over: Partial<AgentToken> & Pick<AgentToken, 'id' | 'label' | 'order'>,
): AgentToken => over;

describe('mcpServersVersionOf', () => {
  it('null と空の {} は同じ版で、値が固定されている', () => {
    const empty = '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a';
    expect(mcpServersVersionOf(null)).toBe(empty);
    expect(mcpServersVersionOf({ mcpServers: {} })).toBe(empty);
  });

  it('登録がある版の値が固定されている', () => {
    expect(mcpServersVersionOf({ mcpServers: { s: { command: 'x' } } })).toBe(
      '58044ad46ee3337bc7c0d852d6d2398a1d435f304d70b60e20865c1b9a6924ac',
    );
  });
});

describe('tokenPoolVersionOf', () => {
  it('行の並び（順・id）で畳んだ JSON の sha256 で、値が固定されている', () => {
    expect(tokenPoolVersionOf([token({ id: 'a', label: 'A', order: 0 })])).toBe(
      '9f0a1150a598f4a6aa58440c64c576db0a7ed22337cd9dee67c294f0673d15e9',
    );
    expect(
      tokenPoolVersionOf([
        token({ id: 'b', label: 'B', order: 1 }),
        token({ id: 'a', label: 'あ', order: 0, disabledAt: '2026-01-01T00:00:00.000Z' }),
      ]),
    ).toBe('c84afae68d20d54aeadc638e516d7f9a3cd040d2de2ba8e4a73f5a412e1784f0');
  });
});
