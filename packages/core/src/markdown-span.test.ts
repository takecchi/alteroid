import { describe, expect, it } from 'vitest';

import { codeSpan } from './markdown-span.js';

describe('codeSpan（Markdown として書かれていない文字列を包む）', () => {
  it('Bash のコマンド置換を含む JSON ダンプが、そこで閉じない包みになる', () => {
    const dump = '{"command":"echo `date` && rm -rf /"}';
    const wrapped = codeSpan(dump);

    expect(wrapped).toBe(`\`\`${dump}\`\``);
    expect(wrapped).toContain('echo `date`');
  });

  it('連続したバッククォートにも、それより長い包みが付く', () => {
    const wrapped = codeSpan('a ``` b');

    expect(wrapped.startsWith('````')).toBe(true);
    expect(wrapped.endsWith('````')).toBe(true);
    expect(wrapped).toContain('a ``` b');
  });

  it('端がバッククォートなら内側へ空白を足す（包みと中身が繋がらない）', () => {
    const wrapped = codeSpan('`x`');

    expect(wrapped).toBe('`` `x` ``');
  });

  it('端が空白でも、その空白が取り除かれない形にする', () => {
    const wrapped = codeSpan(' x ');

    expect(wrapped).toBe('`  x  `');
  });

  it('強調の記法になりうる字面を、記法として解かれない位置へ移す', () => {
    expect(codeSpan('{"glob":"*.ts","note":"a *bold* b"}')).toBe(
      '`{"glob":"*.ts","note":"a *bold* b"}`',
    );
  });

  it('SDK のツール名を識別子として包む（MCP の `mcp__…__…` を含む）', () => {
    expect(codeSpan('mcp__github__create_issue')).toBe('`mcp__github__create_issue`');
  });

  it('空文字は包まない（無い事実を「空のコード」として描かない）', () => {
    expect(codeSpan('')).toBe('');
  });

  it('包む必要が無い文字列には空白を足さない', () => {
    expect(codeSpan('Bash')).toBe('`Bash`');
  });
});
