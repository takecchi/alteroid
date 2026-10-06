import { z } from 'zod';

/**
 * 空白だけを許さない文字列（理由・ラベルの**入力**用。issue #3142）。
 *
 * `z.string().min(1)` は空文字を弾くが「 」は通り、日誌に空白だけの理由が残る。
 * Web は送る前に trim して弾いているので、CLI・API からも同じにする。
 *
 * **値は trim しない**（検査だけ。入力を黙って書き換えない）。**入力にだけ使う**——
 * 保存済みの行を読む schema には使わない（既に空白だけの値が在っても読めなくしない）。
 */
export const nonBlankString = z
  .string()
  .min(1)
  .refine((value) => value.trim().length > 0);
