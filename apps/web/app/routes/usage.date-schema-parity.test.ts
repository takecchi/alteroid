/**
 * `usage.tsx` の `USAGE_DATE_PATTERN` は `usageDateSchema`
 * （`packages/core/src/usage.ts`）の正規表現を複製したものである（issue
 * #2133。`USAGE_DATE_PATTERN` の doc に理由がある——`usageDateSchema` は
 * ブラウザ向けの軽い口（`@alteroid/core/usage`）には出ておらず、`apps/web`
 * は `@alteroid/core`（バレル）を値として import できない）。
 *
 * **複製は書き写した瞬間から古くなりうる。** ここで測るのは、複製した
 * 正規表現とデーモン側の正本（`usageDateSchema`）が同じ入力の集合に同じ
 * 判定を返すことである。
 *
 * **`@alteroid/core`（バレル）からの値 import は、テストファイルでは
 * 許容されている**（`eslint.config.js` の `no-restricted-imports` の
 * `ignores`。`journal.test.tsx` の `JOURNAL_ENTRY_TYPES` と同じ形）。
 */
import { usageDateSchema } from '@alteroid/core';
import { describe, expect, it } from 'vitest';

import { USAGE_DATE_PATTERN } from './usage';

const CASES = [
  // 読める形。
  '2026-08-01',
  '0001-01-01',
  '9999-12-31',
  // 形は合うが実在しない日（issue #2133 の確かめる対象。両者とも「形だけ」
  // 見て通すことを期待する——`USAGE_DATE_PATTERN` の doc 参照）。
  '2026-02-30',
  '2026-13-01',
  '2026-00-00',
  // 読めない形。
  '',
  'not-a-date',
  '2026-8-1',
  '2026/08/01',
  '2026-08-01T00:00:00.000Z',
  '2026-08-011',
  '02026-08-01',
  ' 2026-08-01',
  '2026-08-01 ',
  '2026-08-01\n',
  '20260801',
] as const;

describe('USAGE_DATE_PATTERN と usageDateSchema の一致（issue #2133）', () => {
  it.each(CASES)('%s の判定が一致する', (value) => {
    expect(USAGE_DATE_PATTERN.test(value)).toBe(usageDateSchema.safeParse(value).success);
  });
});
