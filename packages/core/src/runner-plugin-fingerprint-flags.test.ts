import { describe, expect, it } from 'vitest';

import {
  runnerPluginFingerprintEntrySchema,
  runnerPluginsFingerprintSchema,
} from './runner-protocol.js';

// 欄と口は同じ #4045 で入った: 欄を持たない runner は無いので、欄の無い指紋は読めないものとして扱う（#5816）
describe('runner の plugin の指紋は enableHooks・enableMcp を必ず持つ', () => {
  const entry = { name: 'p', sha: 'a'.repeat(40), contentSha256: 'b'.repeat(64) };

  it('2つの欄が揃っていれば読める', () => {
    const parsed = runnerPluginFingerprintEntrySchema.safeParse({
      ...entry,
      enableHooks: false,
      enableMcp: true,
    });
    expect(parsed.success).toBe(true);
  });

  it.each([
    ['enableHooks', { enableMcp: false }],
    ['enableMcp', { enableHooks: false }],
  ])('%s が無い指紋は読めない', (_missing, flags) => {
    expect(runnerPluginFingerprintEntrySchema.safeParse({ ...entry, ...flags }).success).toBe(
      false,
    );
    expect(
      runnerPluginsFingerprintSchema.safeParse({
        sha256: 'c'.repeat(64),
        plugins: [{ ...entry, ...flags }],
        updatedAt: '2026-10-30T00:00:00.000Z',
      }).success,
    ).toBe(false);
  });
});
