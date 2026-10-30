import { redactBody } from '@alteroid/logic';

/**
 * 本文を1行の短い見出しにする: 伏せる → 空白（改行を含む）を1つにつぶして前後を削る → max 字を超えたら切って「…」を付ける。
 * 伏せてから切る: 切ってから伏せると、途中で切れた秘密が形を外れて素で残る。
 * 文字数はコードポイントで数える: UTF-16 の slice だと絵文字などのサロゲートペアの途中で切れて、壊れた1文字が出る。
 * 空のときの文言は呼び元が決める（ここは空文字を返す）。
 */
export function clipLine(text: string, max: number): string {
  const flat = redactBody(text).replace(/\s+/g, ' ').trim();
  const chars = Array.from(flat);
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : flat;
}
