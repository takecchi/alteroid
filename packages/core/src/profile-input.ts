import { assertNoNul } from './nul-guard.js';

/**
 * `ProfileStore.set` / `replaceAll` の入口の NUL の断り（issue #2927。teto の判断、2026-10-05）。
 * 3実装が書く前に呼ぶ。`name` は鍵、`script` は環境変数になる値（NUL は入れられない）なので、
 * どちらも `NulNotAllowedError` で断る。`replaceAll` は全行を先に検査し、1行でも不正なら何も書かない。
 */
export function assertProfileRowWritable(row: { name: string; script: string }): void {
  assertNoNul('profile.name', row.name);
  assertNoNul('profile.script', row.script);
}
