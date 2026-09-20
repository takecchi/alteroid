import { describe, expect, it } from 'vitest';

import { composeTurnInputText, type TurnInputText } from './turn-input.js';

/**
 * `composeTurnInputText`（`turn-input.ts`）の歯。**純粋関数なので I/O のモック
 * 無しで通せる**（`superseded.ts` の歯と同じ作法）。
 *
 * ## この歯が守っているもの
 *
 * **並び順である。** 抽出（Issue #1190 の最初の1歩）より前、この順序を保証して
 * いたのは `#runTurn` の注釈だけで、歯は1本も無かった。`clone-turn-input.test.ts`
 * は日誌への残り方を見ていて、連結順は見ていない。
 *
 * ⚠️ **この歯が測っているのは並び順と連結だけである。** 8本それぞれを「作るか /
 * 何と書くか」は `Clone` 側に在るので、ここでは測れない（測っていない）。
 */

/** 各欄に別々の印を入れる。**印が違えば、隣どうしを入れ替えた変異が必ず赤くなる。** */
const MARKERS: TurnInputText = {
  distillGap: '<distillGap>',
  contextWindowFold: '<contextWindowFold>',
  redelivery: '<redelivery>',
  superseded: '<superseded>',
  validity: '<validity>',
  mergedBatchTruncation: '<mergedBatchTruncation>',
  commitment: '<commitment>',
  situation: '<situation>',
  body: '<body>',
};

/** 全欄を空にした土台（1欄だけ埋めたいとき用）。 */
const EMPTY: TurnInputText = {
  distillGap: '',
  contextWindowFold: '',
  redelivery: '',
  superseded: '',
  validity: '',
  mergedBatchTruncation: '',
  commitment: '',
  situation: '',
  body: '',
};

describe('composeTurnInputText — ターン入力の並び順', () => {
  /**
   * **並び全体を1つの期待値で固定する。** どこか1箇所でも入れ替わると落ちる。
   * 抽出前の `#runTurn` が `+` で連ねていた順序と同じものを、ここに逐語で置く。
   */
  it('9つの欄を、抽出前の `#runTurn` と同じ順で連ねる', () => {
    expect(composeTurnInputText(MARKERS)).toBe(
      '<distillGap>' +
        '<contextWindowFold>' +
        '<redelivery>' +
        '<superseded>' +
        '<validity>' +
        '<mergedBatchTruncation>' +
        '<commitment>' +
        '<situation>' +
        '<body>',
    );
  });

  /**
   * **本文は必ず最後である。** 断り書きが何本載っても、モデルが最後に読むのは
   * 本文になる。上の逐語の歯とは別に立てておく —— こちらは「8本のうち何本が
   * 空でも」成り立つ性質で、逐語の期待値を書き換えたときにも残る。
   */
  it('本文は、断り書きが何本載っても必ず最後に来る', () => {
    const all = composeTurnInputText(MARKERS);
    expect(all.endsWith('<body>')).toBe(true);

    const onlyBody = composeTurnInputText({ ...EMPTY, body: '<body>' });
    expect(onlyBody).toBe('<body>');

    const oneNotice = composeTurnInputText({
      ...EMPTY,
      situation: '<situation>',
      body: '<body>',
    });
    expect(oneNotice).toBe('<situation><body>');
  });

  /**
   * ⭐ **2つの組の境目を、組の中の順序とは別に固定する。**
   *
   * `redelivery` / `superseded` / `validity` / `mergedBatchTruncation` は「いま
   * 配られているこの束の鮮度・切り方」、`commitment` / `situation` は「束とは
   * 無関係な全体の状態」である。**規則が違うものを同じ場所に置かない**ので、
   * 前の組が全部、後ろの組より先に来る。
   *
   * 上の逐語の歯があれば並びは固定されるが、**この歯は落ちたときに理由を名乗る**
   * —— 逐語の歯は「文字列が違う」としか言わない。
   */
  it('鮮度・切り方の4本は、全体の状態の2本より必ず先に来る', () => {
    const out = composeTurnInputText(MARKERS);
    const freshness = ['<redelivery>', '<superseded>', '<validity>', '<mergedBatchTruncation>'];
    const overall = ['<commitment>', '<situation>'];

    const lastFreshness = Math.max(...freshness.map((m) => out.indexOf(m)));
    const firstOverall = Math.min(...overall.map((m) => out.indexOf(m)));

    for (const m of [...freshness, ...overall]) expect(out).toContain(m);
    expect(lastFreshness).toBeLessThan(firstOverall);
  });

  /**
   * ⭐ **消費する読み2本は、どの断り書きよりも先に来る。**
   *
   * `distillGap` と `contextWindowFold` は `Clone` 側で「読むこと自体が遷移」に
   * なっている欄である（呼ぶと自分の pending が倒れる）。**その2本が先頭に来る
   * ことを固定しておく** —— 後ろへ回す変更が入ったら、ここで止まる。
   */
  it('消費する読みの2本が先頭に来る（distillGap → contextWindowFold の順）', () => {
    const out = composeTurnInputText(MARKERS);
    expect(out.indexOf('<distillGap>')).toBe(0);
    expect(out.indexOf('<contextWindowFold>')).toBe('<distillGap>'.length);
    expect(out.indexOf('<contextWindowFold>')).toBeLessThan(out.indexOf('<redelivery>'));
  });

  /**
   * **空文字は「無い」であって、区切りを作らない。** 断り書きの側が空を返すのは
   * 正常な値である（`#pump` は反復ごとに6本を空へ戻す）ので、空を挟んでも前後が
   * くっつくだけで、余計な空白や改行は入らない。
   */
  it('空の欄は何も足さない（区切り文字を差し込まない）', () => {
    expect(composeTurnInputText(EMPTY)).toBe('');

    const gapOnly = composeTurnInputText({
      ...EMPTY,
      redelivery: 'あ',
      commitment: 'い',
      body: 'う',
    });
    expect(gapOnly).toBe('あいう');
  });
});
