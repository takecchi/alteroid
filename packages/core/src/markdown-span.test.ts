import { describe, expect, it } from 'vitest';

import { codeSpan } from './markdown-span.js';

/**
 * Markdown の文へ埋め込む包み（issue #287）。
 *
 * **ここで測るのは「包まれたこと」ではなく「字面が残ること」である。** 前者だけを
 * 測ると、包んだ結果として中身が壊れる実装（1本のバッククォートで固定する等）が
 * そのまま通る —— 実際に壊れるのはバッククォートを含む JSON ダンプなので、
 * **実機のレンダラで化けることを確認できた入力**を先頭に置いてある。
 */
describe('codeSpan（Markdown として書かれていない文字列を包む）', () => {
  it('Bash のコマンド置換を含む JSON ダンプが、そこで閉じない包みになる', () => {
    // この入力は実機のレンダラ（react-markdown ＋ remark-gfm）で、包まないと
    // `` `date` `` が本物の `<code>` になることを実測した回である。
    const dump = '{"command":"echo `date` && rm -rf /"}';
    const wrapped = codeSpan(dump);

    // 中身の最長の連なりは1本なので、包みは2本になる。
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

    // CommonMark は両端の空白を1つずつ取り除くので、描かれる字面は `x` に戻る。
    expect(wrapped).toBe('`` `x` ``');
  });

  it('端が空白でも、その空白が取り除かれない形にする', () => {
    const wrapped = codeSpan(' x ');

    expect(wrapped).toBe('`  x  `');
  });

  it('強調の記法になりうる字面を、記法として解かれない位置へ移す', () => {
    // `*word*` は空白を挟まなければ `<em>` になる（実測）。
    expect(codeSpan('{"glob":"*.ts","note":"a *bold* b"}')).toBe(
      '`{"glob":"*.ts","note":"a *bold* b"}`',
    );
  });

  it('SDK のツール名を識別子として包む（MCP の `mcp__…__…` を含む）', () => {
    // **この形は包まなくても化けない**（CommonMark はアンダースコアの強調を語中で
    // 発火させない）。包むのは本文の `` `journal_read` `` と扱いを揃えるためで、
    // 化けを直しているのではない —— テストの名前もそう読めるようにしてある。
    expect(codeSpan('mcp__github__create_issue')).toBe('`mcp__github__create_issue`');
  });

  it('空文字は包まない（無い事実を「空のコード」として描かない）', () => {
    expect(codeSpan('')).toBe('');
  });

  it('包む必要が無い文字列には空白を足さない', () => {
    expect(codeSpan('Bash')).toBe('`Bash`');
  });
});
