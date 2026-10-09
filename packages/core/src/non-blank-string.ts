import { z } from 'zod';
import { stripNul } from './nul-guard.js';

/**
 * NUL は落としてから見る: ストアが NUL を落として残すので、NUL だけの値は空として残る。
 * 値は trim しない: 入力を黙って書き換えない。
 * 入力にだけ使う: 保存済みの行を読む schema に使うと、既にある空白だけの値が読めなくなる。
 */
export const nonBlankString = z
  .string()
  .min(1)
  .refine((value) => stripNul(value).trim().length > 0);
