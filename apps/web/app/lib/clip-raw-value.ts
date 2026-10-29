const RAW_VALUE_MAX = 40;

/**
 * URL に書かれた読めない値を、注記に出せる長さに切る。
 * 文字数はコードポイントで数える: サロゲートペアの途中で切らない。
 */
export function clipRawValue(raw: string): string {
  const chars = Array.from(raw);
  return chars.length > RAW_VALUE_MAX ? `${chars.slice(0, RAW_VALUE_MAX).join('')}…` : raw;
}
