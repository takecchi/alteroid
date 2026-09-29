/**
 * **テストの中の実時間の待ちを、これ以上増やさないラチェット（#2146 の続き）。**
 *
 * #2146 で、実時間の `setTimeout(resolve, 20)` で待つ形のテストが、器が混んだ時に1回だけ
 * 落ちた（PR #2153 で偽の時計へ置き換えた）。同じ形は repo にまだ 283 か所・72 ファイル在る
 * （2026-09-29T16:1xZ 実測）。**落ちた実績が無いものを予防で直すと「直った」を確かめられない**
 * （AGENTS.md「範囲外でも気づいたことは上げる」）ので、既存の分は直さずに基準値として固定し、
 * **新しく足された分だけを止める**（teto の判断、2026-09-29）。
 *
 * - 数え方・数えないもの・限界: `scripts/wallclock-waits-core.mjs` の冒頭の doc
 * - 基準値: `scripts/wallclock-waits-baseline.json`（ファイルごとの件数。合計で持つと、あるファイルで
 *   減った分に隠れて別のファイルで増えても通る）
 * - 増えたら落ちる。**減っても落ちる**（基準値を下げさせて、次の追加に余白を残さない）。
 *   どちらも、理由文に直し方が書いてある
 * - 対象は root の `vitest.config.ts` の include と同じ `*.test.ts` / `*.test.tsx`。一覧は
 *   `collectRepoFiles`（`.gitignore` 済みの `.scratch/` などは拾わない。#2111）
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { collectRepoFiles } from './repo-scan-files.js';
import {
  compareWithBaseline,
  countWallclockWaits,
  describeRatchetFailure,
  isTestFile,
  // @ts-expect-error -- 素の .mjs
} from './wallclock-waits-core.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const BASELINE_REL = 'scripts/wallclock-waits-baseline.json';
const SELF_REL = 'scripts/wallclock-waits-ratchet.test.ts';
const EXCLUDE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.react-router', '.vite']);

type Counts = Record<string, number>;

describe('countWallclockWaits', () => {
  it('正の定数の待ちを数え、0 と定数でない待ちは数えない', () => {
    const source = [
      'await new Promise((resolve) => setTimeout(resolve, 20));',
      'await new Promise((r) => setTimeout(r, 5));',
      'await new Promise((r) => setTimeout( r , 1.5 ));',
      'await new Promise((resolve) => setTimeout(resolve, 0));',
      'await new Promise((resolve) => setTimeout(resolve, WAIT_MS));',
      'setTimeout(() => done(), 20);',
    ].join('\n');
    expect(countWallclockWaits(source)).toBe(3);
  });
});

describe('compareWithBaseline / describeRatchetFailure', () => {
  it('増えた・新しく現れた・減ったを分けて返す', () => {
    const result = compareWithBaseline(
      { 'a.test.ts': 3, 'new.test.ts': 1, 'c.test.ts': 1 },
      { 'a.test.ts': 2, 'c.test.ts': 2, 'gone.test.ts': 4 },
    );
    expect(result.increased).toEqual([
      { file: 'a.test.ts', now: 3, allowed: 2 },
      { file: 'new.test.ts', now: 1, allowed: 0 },
    ]);
    expect(result.decreased).toEqual([
      { file: 'c.test.ts', now: 1, allowed: 2 },
      { file: 'gone.test.ts', now: 0, allowed: 4 },
    ]);
  });

  it('増えたときの理由文は、偽の時計を使う直し方を書く', () => {
    const text = describeRatchetFailure(
      { increased: [{ file: 'x.test.ts', now: 1, allowed: 0 }], decreased: [] },
      BASELINE_REL,
    );
    expect(text).toContain('x.test.ts: 1 件（基準 0 件）');
    expect(text).toContain('vi.useFakeTimers()');
    expect(text).toContain('vi.advanceTimersByTimeAsync(20)');
    expect(text).toContain(BASELINE_REL);
  });

  it('減ったときの理由文は、基準値の下げ方を書く', () => {
    const text = describeRatchetFailure(
      {
        increased: [],
        decreased: [
          { file: 'c.test.ts', now: 1, allowed: 2 },
          { file: 'gone.test.ts', now: 0, allowed: 4 },
        ],
      },
      BASELINE_REL,
    );
    expect(text).toContain('"c.test.ts": 1');
    expect(text).toContain('"gone.test.ts": 行を消す');
  });
});

describe('実物の repo: テストの中の実時間の待ちが基準値から動いていない（#2146）', () => {
  it('ファイルごとの件数が基準値と一致する', () => {
    const baseline = JSON.parse(readFileSync(path.join(ROOT, BASELINE_REL), 'utf8')) as Counts;
    const actual: Counts = {};
    // この歯自身は、数え方を測るために例の文字列を持つので数えない。
    const files = collectRepoFiles(ROOT, EXCLUDE_DIRS).filter(
      (f) => isTestFile(f) && f !== SELF_REL,
    );
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const n = countWallclockWaits(readFileSync(path.join(ROOT, file), 'utf8')) as number;
      if (n > 0) actual[file] = n;
    }
    const result = compareWithBaseline(actual, baseline);
    const message = describeRatchetFailure(result, BASELINE_REL);
    expect(result.increased.length === 0 && result.decreased.length === 0, message).toBe(true);
  });
});
