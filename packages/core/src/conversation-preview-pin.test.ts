import { describe, expect, it } from 'vitest';

import { preview } from './conversation.js';

// 題（preview）の出力を入力ごとに固定する。同じ入力・同じ期待を `packages/swr/src/hooks/mutations.test.tsx` の
// 抜粋の試験（自分の送信の即時反映の `roughPreview`）が持つ: 両者が食い違うと、反映した瞬間に抜粋の見た目が飛ぶ
const CASES: { name: string; text: string; expected: string }[] = [
  { name: 'ASCII 80 文字ちょうどは切らない', text: 'a'.repeat(80), expected: 'a'.repeat(80) },
  { name: 'ASCII 81 文字は 80 で切る', text: 'a'.repeat(81), expected: `${'a'.repeat(80)}…` },
  { name: 'ASCII 79 文字は切らない', text: 'a'.repeat(79), expected: 'a'.repeat(79) },
  { name: '日本語 80 文字ちょうどは切らない', text: 'あ'.repeat(80), expected: 'あ'.repeat(80) },
  { name: '日本語 81 文字は 80 で切る', text: 'あ'.repeat(81), expected: `${'あ'.repeat(80)}…` },
  {
    name: '改行・タブ・連続空白は 1 つの空白にして trim',
    text: '\n a\n\n b\t\t c  ',
    expected: 'a b c',
  },
  {
    name: '空白を畳んだ後の長さで切る',
    text: `${'a'.repeat(40)}\n\n\n${'b'.repeat(40)}`,
    expected: `${'a'.repeat(40)} ${'b'.repeat(39)}…`,
  },
  {
    name: '切り口にかかる絵文字を割らない（79 文字 + 絵文字 + 1 文字）',
    text: `${'a'.repeat(79)}😀b`,
    expected: `${'a'.repeat(79)}😀…`,
  },
  {
    name: '絵文字 50 個（80 コードポイント以下）は切らない',
    text: '😀'.repeat(50),
    expected: '😀'.repeat(50),
  },
  { name: '絵文字 80 個ちょうどは切らない', text: '😀'.repeat(80), expected: '😀'.repeat(80) },
  { name: '絵文字 81 個は 80 個で切る', text: '😀'.repeat(81), expected: `${'😀'.repeat(80)}…` },
];

describe('preview（会話の題）', () => {
  it.each(CASES)('$name', ({ text, expected }) => {
    expect(preview(text)).toBe(expected);
  });
});
