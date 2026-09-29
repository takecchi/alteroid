/**
 * `usage.tsx` の `USAGE_DATE_PATTERN` は `usageDateSchema`
 * （`packages/core/src/usage.ts`）の正規表現を複製したものである（issue
 * #2133。`USAGE_DATE_PATTERN` の doc に理由がある——`usageDateSchema` は
 * ブラウザ向けの軽い口（`@alteroid/core/usage`）には出ておらず、`apps/web`
 * は `@alteroid/core`（バレル）を値として import できない）。
 *
 * **複製は書き写した瞬間から古くなりうる。** ここで測るのは、複製した
 * 正規表現とデーモン側の正本が同じ入力の集合に同じ判定を返すことである。
 *
 * **issue #2156 で、突き合わせの相手を `usageDateSchema` から core の
 * `USAGE_DATE_PATTERN` に替えた**（領域 D の mgr-712ad619）。#2156 で
 * `usageDateSchema` は、形（`USAGE_DATE_PATTERN`）に加えて暦の上の実在
 * （`isRealUsageDate`）も見るようになった。形の正本は `USAGE_DATE_PATTERN` として
 * `packages/core/src/usage-format.ts`（軽い口）から別に出ている。この歯が測って
 * いたのは「書き写した正規表現の一致」なので、相手を形の正本に替えれば、目的は
 * そのまま保てる。以前の相手（`usageDateSchema`）のままだと、`2026-02-30` などの
 * 実在しない日で、形だけを見る画面の正規表現と一致しなくなる。
 *
 * **画面の実在の検査（`isRealCalendarDate`）と core の `isRealUsageDate` の一致は、
 * ここでは測っていない**（画面の関数は export されていない）。画面が
 * `@alteroid/core/usage` の `USAGE_DATE_PATTERN` / `isRealUsageDate` を読む形へ寄せれば、
 * 書き写しそのものが要らなくなる（寄せる作業は領域 E が持つ。#2156 の申し送り）。
 *
 * **`@alteroid/core`（バレル）からの値 import は、テストファイルでは
 * 許容されている**（`eslint.config.js` の `no-restricted-imports` の
 * `ignores`。`journal.test.tsx` の `JOURNAL_ENTRY_TYPES` と同じ形）。
 */
import { USAGE_DATE_PATTERN as CORE_USAGE_DATE_PATTERN } from '@alteroid/core';
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

describe('USAGE_DATE_PATTERN と core の USAGE_DATE_PATTERN（形の正本）の一致（issue #2133 / #2156）', () => {
  it.each(CASES)('%s の判定が一致する', (value) => {
    expect(USAGE_DATE_PATTERN.test(value)).toBe(CORE_USAGE_DATE_PATTERN.test(value));
  });
});
