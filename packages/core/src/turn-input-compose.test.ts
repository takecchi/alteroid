import { describe, expect, it } from 'vitest';

import { composeTurnInputText, type TurnInputText } from './turn-input.js';

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

  it('鮮度・切り方の4本は、全体の状態の2本より必ず先に来る', () => {
    const out = composeTurnInputText(MARKERS);
    const freshness = ['<redelivery>', '<superseded>', '<validity>', '<mergedBatchTruncation>'];
    const overall = ['<commitment>', '<situation>'];

    const lastFreshness = Math.max(...freshness.map((m) => out.indexOf(m)));
    const firstOverall = Math.min(...overall.map((m) => out.indexOf(m)));

    for (const m of [...freshness, ...overall]) expect(out).toContain(m);
    expect(lastFreshness).toBeLessThan(firstOverall);
  });

  it('消費する読みの2本が先頭に来る（distillGap → contextWindowFold の順）', () => {
    const out = composeTurnInputText(MARKERS);
    expect(out.indexOf('<distillGap>')).toBe(0);
    expect(out.indexOf('<contextWindowFold>')).toBe('<distillGap>'.length);
    expect(out.indexOf('<contextWindowFold>')).toBeLessThan(out.indexOf('<redelivery>'));
  });

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
