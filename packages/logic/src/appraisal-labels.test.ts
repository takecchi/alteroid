/**
 * `appraisal-labels.ts` の `APPRAISAL_LABELS` は `@alteroid/core` の
 * `APPRAISAL_LABELS`（`packages/core/src/schema.ts`）を書き写したものである
 * （issue #2164。`appraisal-labels.ts` の doc に理由がある——`apps/web` は
 * `@alteroid/core`（バレル）を値として import できない）。
 *
 * **複製は書き写した瞬間から古くなりうる。** ここで測るのは、複製した
 * ラベルとサーバ側の正本（`APPRAISAL_LABELS`）が同じ3値に同じ字面を
 * 返すことである。
 *
 * **`@alteroid/core`（バレル）からの値 import は、テストファイルでは
 * 許容されている**（`eslint.config.js` の `no-restricted-imports` の
 * `ignores`。`journal.test.tsx` の `JOURNAL_ENTRY_TYPES` と同じ形）。
 */
import { APPRAISAL_LABELS as CORE_APPRAISAL_LABELS } from '@alteroid/core';
import { describe, expect, it } from 'vitest';

import { APPRAISAL_LABELS } from './appraisal-labels';

describe('APPRAISAL_LABELS と @alteroid/core の APPRAISAL_LABELS の一致（issue #2164）', () => {
  const keys = Object.keys(CORE_APPRAISAL_LABELS) as (keyof typeof CORE_APPRAISAL_LABELS)[];

  it('core と同じ3値ぶんのキーを持つ（多すぎても少なすぎても落ちる）', () => {
    expect(Object.keys(APPRAISAL_LABELS).sort()).toEqual(keys.slice().sort());
  });

  it.each(keys)('%s の字面が core と一致する', (key) => {
    expect(APPRAISAL_LABELS[key]).toBe(CORE_APPRAISAL_LABELS[key]);
  });
});
