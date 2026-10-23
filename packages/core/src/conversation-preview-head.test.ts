import { describe, expect, it } from 'vitest';

import {
  CONVERSATION_PREVIEW,
  CONVERSATION_PREVIEW_HEAD_CHARS,
  previewFromHead,
  previewOfTitled,
} from './conversation.js';

// 細い窓（DB が本文の先頭だけを返す）で作る題が、全文から作る題と1文字も違わないこと

/** DB の `left(text, chars)` と `length(text) > chars` を写す（どちらもコードポイントで数える） */
function headOf(text: string, attachments = 0, chars = CONVERSATION_PREVIEW_HEAD_CHARS) {
  const codePoints = [...text];
  return {
    id: 'x',
    head: codePoints.slice(0, chars).join(''),
    truncated: codePoints.length > chars,
    attachments,
  };
}

function fullPreview(text: string, attachments = 0): string {
  return previewOfTitled({
    text,
    ...(attachments === 0
      ? {}
      : {
          attachments: Array.from({ length: attachments }, (_, i) => ({
            id: `a${String(i)}`,
            name: `a${String(i)}.png`,
          })) as never,
        }),
  });
}

const EMOJI = '😀';

const CASES: ReadonlyArray<[string, string, number?]> = [
  ['短い本文', 'こんにちは'],
  ['空の本文', ''],
  ['空白だけの本文', '   \n\t  '],
  ['空の本文で添付だけ', '', 2],
  ['空白だけの本文で添付だけ', '  \n ', 1],
  ['本文があって添付もある', '画像を見て', 1],
  ['題の長さちょうど', 'あ'.repeat(CONVERSATION_PREVIEW)],
  ['題の長さ+1', 'あ'.repeat(CONVERSATION_PREVIEW + 1)],
  ['先頭の長さちょうど', 'い'.repeat(CONVERSATION_PREVIEW_HEAD_CHARS)],
  ['先頭の長さ+1', 'い'.repeat(CONVERSATION_PREVIEW_HEAD_CHARS + 1)],
  ['長い本文', 'う'.repeat(5000)],
  [
    '絵文字が題の切れ目をまたぐ',
    `${'え'.repeat(CONVERSATION_PREVIEW - 1)}${EMOJI}${'お'.repeat(1000)}`,
  ],
  ['絵文字だけの長い本文', EMOJI.repeat(1000)],
  ['改行と空白の混じった長い本文', `一行目\n\n  二行目\t\t三行目 ${'か'.repeat(2000)}`],
  [
    '先頭の空白が長く、先頭だけでは題に届かない',
    `${' '.repeat(CONVERSATION_PREVIEW_HEAD_CHARS)}本文${'き'.repeat(500)}`,
  ],
  [
    '先頭の内側で空白の連なりが切れ目をまたぐ',
    `${'く'.repeat(CONVERSATION_PREVIEW_HEAD_CHARS - 3)}      ${'け'.repeat(500)}`,
  ],
  [
    '空白をまとめると題の長さぎりぎりになる',
    `${'こ '.repeat(40)}${' '.repeat(CONVERSATION_PREVIEW_HEAD_CHARS)}${'さ'.repeat(10)}`,
  ],
  ['全角空白の連なり', `${'し　　'.repeat(300)}`],
];

describe('previewFromHead は、作れるときは全文から作る題と同じ題を返し、作れないときは undefined を返す', () => {
  for (const [label, text, attachments] of CASES) {
    it(label, () => {
      const fromHead = previewFromHead(headOf(text, attachments ?? 0));
      const expected = fullPreview(text, attachments ?? 0);
      if (fromHead !== undefined) expect(fromHead).toBe(expected);
    });
  }

  it('⭐ 先頭が切れていて、空白をまとめた先頭が題に届かないときだけ undefined（全文を引き直させる）', () => {
    const lacking = `${' '.repeat(CONVERSATION_PREVIEW_HEAD_CHARS)}本文${'き'.repeat(500)}`;
    expect(previewFromHead(headOf(lacking))).toBeUndefined();
    // 切れていない本文は、どんな形でも作れる
    for (const [, text, attachments] of CASES) {
      const head = headOf(text, attachments ?? 0);
      if (!head.truncated) expect(previewFromHead(head)).toBe(fullPreview(text, attachments ?? 0));
    }
  });

  it('⭐ 乱数の本文（空白・改行・絵文字・全角を混ぜる）2,000 本で、作れた題はすべて全文の題と一致する', () => {
    let seed = 20261024;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const pieces = [' ', '  ', '\n', '\t', '　', 'あ', 'b', EMOJI, '漢字', '。'];
    let made = 0;
    for (let n = 0; n < 2000; n += 1) {
      const length = Math.floor(random() * 900);
      let text = '';
      for (let i = 0; i < length; i += 1) text += pieces[Math.floor(random() * pieces.length)];
      const fromHead = previewFromHead(headOf(text));
      if (fromHead === undefined) continue;
      made += 1;
      expect(fromHead).toBe(fullPreview(text));
    }
    // ほとんどは先頭だけで作れる（引き直しは例外であること）
    expect(made).toBeGreaterThan(1900);
  });
});
