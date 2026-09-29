/**
 * 元は、`usage.tsx` が持っていた書き写し（`USAGE_DATE_PATTERN` / 旧
 * `isRealCalendarDate`）と `usageDateSchema`（`packages/core/src/usage.ts`）が
 * 同じ入力の集合に同じ判定を返すことを測る歯だった（issue #2133 / #2156。
 * 書き写した理由は当時 `usageDateSchema` がブラウザ向けの軽い口
 * `@alteroid/core/usage` から出ておらず、`apps/web` は `@alteroid/core`
 * （バレル）を値として import できなかったため）。
 *
 * **issue #2166 で、書き写しそのものを削った。** `usage.tsx` はいま
 * `@alteroid/core/usage` の `USAGE_DATE_PATTERN` / `isRealUsageDate` を
 * そのまま import して使っており、画面側に別の実装は存在しない。
 * ⟹ 「複製と正本が一致するか」はもう測る対象が無い（比べる相手の複製が
 * 無い）。
 *
 * **ここで測る対象を、「画面の `parseUsageDate` が core の判定へそのまま
 * 委譲しているか」に変えた。** `parseUsageDate` は `usage.tsx` の中で
 * `USAGE_DATE_PATTERN.test(raw)` と `isRealUsageDate(raw)` を呼ぶだけの
 * 薄い関数で、テストのためだけに `export` した（`usage.tsx` の
 * `parseUsageDate` の doc に理由がある）。この歯は、`parseUsageDate` の
 * 戻り値が「`core` の2関数から素朴に導ける期待値」と一致することを、
 * 元のケース集合（読める形・形は合うが実在しない日・読めない形）全部で
 * 確かめる。**画面が core の判定から外れて私家版の実在検査へ後戻りしたら、
 * ここが赤くなる**（例: `isRealUsageDate` を通さず常に真を返す変異）。
 *
 * `usage.test.tsx` の「形は合うが実在しない日（2026-02-30）」のテストは
 * 画面の描画（入力欄・注記・`GET /usage` への問い合わせ）まで見る黒箱の
 * 歯で、ここは `parseUsageDate` 単体を直接見る白箱の歯——役割は重複しない。
 */
import { isRealUsageDate, USAGE_DATE_PATTERN } from '@alteroid/core/usage';
import { describe, expect, it } from 'vitest';

import { parseUsageDate } from './usage';

const CASES = [
  // 読める形かつ実在する日。
  '2026-08-01',
  '0001-01-01',
  '9999-12-31',
  '2024-02-29', // 閏年
  // 形は合うが実在しない日。
  '2026-02-30',
  '2026-13-01',
  '2026-00-00',
  '2023-02-29', // 閏年ではない
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

describe('画面の parseUsageDate が core の USAGE_DATE_PATTERN / isRealUsageDate へそのまま委譲している（issue #2133 / #2156 / #2166）', () => {
  it.each(CASES)('%s の判定が core から素朴に導ける期待値と一致する', (value) => {
    const expected = USAGE_DATE_PATTERN.test(value) && isRealUsageDate(value) ? value : '';
    expect(parseUsageDate(value)).toBe(expected);
  });

  it('raw が null または空文字なら core を呼ぶまでもなく空文字を返す', () => {
    expect(parseUsageDate(null)).toBe('');
    expect(parseUsageDate('')).toBe('');
  });
});
