import { describe, expect, it } from 'vitest';

import { buildDistillPrompt } from './prompt.js';

// 蒸留の指示のうち、「経緯」（日付・人間の逐語）を言っていた3か所の全文を固定する。
// 経緯はモデルの判断に効かないので載せない。判断を言う部分（移動は通る・区分の線・棚卸しの本題）は変えない。
// 重複（同じ主張が何度も出る）の畳みはここでは縛らない。

describe('buildDistillPrompt — 経緯を言う文を載せず、判断を言う文は残す', () => {
  const prompt = buildDistillPrompt('conversation_end');

  it('節の移動の段落', () => {
    expect(prompt).toContain(
      '**⭐ ただし `memory_section_move`（節を別の文書へ移す）は、人間が書いた文書に対しても通る**（移動は先に足して後で切るので、どの瞬間にも本文がどこかに在る＝失われない）。⟹ **このターンでできる整理の本体はこれである。** 断られるのを待たずに、いま移せる。',
    );
  });

  it('区分の線の箇条書き', () => {
    expect(prompt).toContain(
      '- **区分は「費用」ではなく「毎回の判断に要るか」で決めよ。** 判断のたびに要らないものは `fact` でよい。**ただし判断の前提そのものを削るな**',
    );
  });

  it('畳むものの見出し', () => {
    expect(prompt).toContain('### 畳むもの（人間が明示した。定期の棚卸しの本題はここである）');
  });

  it('日付と人間の逐語は載らない', () => {
    expect(prompt).not.toContain('2026-09-08');
    expect(prompt).not.toContain('逐語:');
    expect(prompt).not.toContain('そんなに毎回呼び出さなきゃいけない');
    expect(prompt).not.toContain('かつてここには');
  });
});
