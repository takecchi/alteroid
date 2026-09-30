import { describe, expect, it } from 'vitest';

import { brief } from './runner.js';

/**
 * **issue #2449 — `brief()`（`runner.ts`）の切り口を、補助面の文字の途中に置かない。**
 *
 * `brief()` は許可確認の要約（`#onPermission` の `` `${toolName} の実行許可: ${brief(input)}` ``）・
 * `describeQuestions` が落ちたときの `brief(input)`・`tool_use` の表示に使われる。
 * 以前は `text.slice(0, limit)` を素で使っていたので、JSON 化した入力の `limit`
 * コード単位目を絵文字がまたぐと高サロゲートだけが残り、UTF-8 へ変える経路
 * （クローンの受信箱・`manager_list`）で U+FFFD に化けた（#1606 と同じ症状）。
 *
 * 切り口は `excerpt.ts` の `codePointBoundary` で1つ手前へ寄せる。**長さの数え方
 * （UTF-16 のコード単位）と、割らないときの切り口は変えない**——下の対照で固定する。
 */

/** 孤立サロゲート（高だけ・低だけ）。`isWellFormed()` は tsconfig の lib（ES2023）に無いので直接探す。 */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

const isHigh = (code: number) => code >= 0xd800 && code <= 0xdbff;

describe('brief() は補助面の文字の途中で切らない（issue #2449）', () => {
  it('JSON 化した入力の200コード単位目を絵文字がまたいでも、孤立サロゲートを残さない', () => {
    // Issue の入力そのまま。`{"command":"` の12字 + `echo ` の5字 + 182字 = 199 で、
    // 😀 は199・200コード単位目の2つに乗る。
    const input = { command: `echo ${'a'.repeat(182)}\u{1F600}` };
    const json = JSON.stringify(input);
    // 足場の確認: 素の slice(0, 200) なら高サロゲートだけが残る長さである。
    expect(json.length).toBeGreaterThan(200);
    expect(isHigh(json.charCodeAt(199))).toBe(true);

    const out = brief(input);
    expect(out).not.toMatch(LONE_SURROGATE);
    expect(out).toBe(`${json.slice(0, 199)}…`);

    // 許可確認の要約の形（`#onPermission`）で UTF-8 を往復させても化けない。
    const summary = `Bash の実行許可: ${out}`;
    expect(Buffer.from(summary, 'utf8').toString('utf8')).toBe(summary);
    expect(Buffer.from(summary, 'utf8').toString('utf8')).not.toContain('�');
  });

  it('limit を渡した形（120）でも同じく寄せる', () => {
    // 12 + 5 + 102 = 119 で、😀 は119・120コード単位目に乗る。
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
    // 12 + 5 + 183 = 200 で、😀 は200・201コード単位目——切り口（200）の外にある。
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
