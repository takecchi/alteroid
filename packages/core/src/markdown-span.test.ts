import { describe, expect, it } from 'vitest';

import { codeSpan } from './markdown-span.js';

/**
 * Markdown の文へ埋め込む包み（issue #287）。
 *
 * **ここで測るのは「包まれたこと」ではなく「字面が残ること」である。** 前者だけを
 * 測ると、包んだ結果として中身が壊れる実装（1本のバッククォートで固定する等）が
 * そのまま通る —— 実際に壊れるのは JSON ダンプのようなバッククォートを含む入力
 * なので、その入力を明示的に置いてある。
 */
describe('codeSpan（Markdown として書かれていない文字列を包む）', () => {
  it('MCP のツール名のアンダースコアが強調に食われない形で残る', () => {
    // `mcp__github__create_issue` は素で埋めると `__github__` が強調になる。
    const wrapped = codeSpan('mcp__github__create_issue');

    expect(wrapped).toBe('`mcp__github__create_issue`');
  });

  it('glob の `**` を含む JSON ダンプが、字面のまま包まれる', () => {
    const dump = '{"command":"grep -n \'**/*.ts\' packages/"}';
    const wrapped = codeSpan(dump);

    expect(wrapped).toBe(`\`${dump}\``);
  });

  it('中身にバッククォートが在れば、包みを1本長くする（そこで閉じない）', () => {
    const wrapped = codeSpan('{"command":"echo `date`"}');

    // 中身の最長の連なりは1本なので、包みは2本になる。
    expect(wrapped.startsWith('``')).toBe(true);
    expect(wrapped.endsWith('``')).toBe(true);
    expect(wrapped).toContain('echo `date`');
  });

  it('連続したバッククォートにも、それより長い包みが付く', () => {
    const wrapped = codeSpan('a ``` b');

    expect(wrapped.startsWith('````')).toBe(true);
    expect(wrapped.endsWith('````')).toBe(true);
  });

  it('端がバッククォートなら内側へ空白を足す（包みと中身が繋がらない）', () => {
    const wrapped = codeSpan('`x`');

    // CommonMark は両端の空白を1つずつ取り除くので、描かれる字面は `x` に戻る。
    expect(wrapped).toBe('`` `x` ``');
  });

  it('端が空白でも、その空白が取り除かれない形にする', () => {
    const wrapped = codeSpan(' x ');

    expect(wrapped).toBe('`  x  `');
  });

  it('空文字は包まない（無い事実を「空のコード」として描かない）', () => {
    expect(codeSpan('')).toBe('');
  });

  it('包む必要が無い文字列には空白を足さない', () => {
    expect(codeSpan('Bash')).toBe('`Bash`');
  });
});
