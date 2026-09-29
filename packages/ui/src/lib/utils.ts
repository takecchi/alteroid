import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** 条件付きクラス名を潰して、後勝ちの Tailwind 衝突も解く。 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
