import { assertNoNul } from './nul-guard.js';

export function assertProfileRowWritable(row: { name: string; script: string }): void {
  assertNoNul('profile.name', row.name);
  assertNoNul('profile.script', row.script);
}
