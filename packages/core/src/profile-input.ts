import { assertNoNul } from './nul-guard.js';

// name は鍵、script は環境変数になる値（NUL は入れられない）なので、どちらも断る。
// replaceAll は全行を先に検査し、1行でも不正なら何も書かない。
export function assertProfileRowWritable(row: { name: string; script: string }): void {
  assertNoNul('profile.name', row.name);
  assertNoNul('profile.script', row.script);
}
