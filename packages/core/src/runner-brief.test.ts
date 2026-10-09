import { describe, expect, it } from 'vitest';

import { brief } from './runner.js';

// `isWellFormed()` は tsconfig の lib（ES2023）に無いので直接探す。
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

const isHigh = (code: number) => code >= 0xd800 && code <= 0xdbff;

describe('brief() は補助面の文字の途中で切らない（issue #2449）', () => {
  it('JSON 化した入力の200コード単位目を絵文字がまたいでも、孤立サロゲートを残さない', () => {
    const input = { command: `echo ${'a'.repeat(182)}\u{1F600}` };
    const json = JSON.stringify(input);
    expect(json.length).toBeGreaterThan(200);
    expect(isHigh(json.charCodeAt(199))).toBe(true);

    const out = brief(input);
    expect(out).not.toMatch(LONE_SURROGATE);
    expect(out).toBe(`${json.slice(0, 199)}…`);

    const summary = `Bash の実行許可: ${out}`;
    expect(Buffer.from(summary, 'utf8').toString('utf8')).toBe(summary);
    expect(Buffer.from(summary, 'utf8').toString('utf8')).not.toContain('�');
  });

  it('limit を渡した形（120）でも同じく寄せる', () => {
    const input = { command: `echo ${'a'.repeat(102)}\u{1F600}tail` };
    const json = JSON.stringify(input);
    expect(isHigh(json.charCodeAt(119))).toBe(true);

    const out = brief(input, 120);
    expect(out).not.toMatch(LONE_SURROGATE);
    expect(out).toBe(`${json.slice(0, 119)}…`);
  });

  it('文字列の入力でも寄せる', () => {
    const text = `${'x'.repeat(199)}\u{1F600}y`;
    const out = brief(text);
    expect(out).not.toMatch(LONE_SURROGATE);
    expect(out).toBe(`${'x'.repeat(199)}…`);
  });

  it('対照: 切り口が文字を割らないときは、これまでどおり limit コード単位で切る', () => {
    const input = { command: `echo ${'a'.repeat(183)}\u{1F600}` };
    const json = JSON.stringify(input);
    expect(isHigh(json.charCodeAt(199))).toBe(false);

    expect(brief(input)).toBe(`${json.slice(0, 200)}…`);
  });

  it('対照: limit 以下の長さなら切らず、印も付けない', () => {
    const text = `${'x'.repeat(198)}\u{1F600}`;
    expect(text.length).toBe(200);
    expect(brief(text)).toBe(text);
  });
});
