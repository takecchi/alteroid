import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  AGENTS_MD_MAX_BYTES,
  BUDGET_HISTORY,
  judgeAgentsMdSize,
  // @ts-expect-error -- 素の .mjs（型宣言を持たない build 用スクリプト）を読む
} from './check-agents-md-size-core.mjs';

/**
 * `check-agents-md-size` の判定ロジックの歯（Issue #1192）。
 *
 * **本物のファイルを読まずに試す。** CLI 側（`check-agents-md-size.mjs`）は
 * ファイル読み込みだけを持ち、判定は `check-agents-md-size-core.mjs` に
 * 切り出してあるので、ここでは合成した `{ bytes, lines }` で判定だけを
 * 確かめる（`check-web-bundle-size.test.ts` と同じ分け方・同じ理由）。
 *
 * 実ファイル（`AGENTS.md`）に対する予算の遵守だけは、この歯の末尾で
 * 別途見る——`pnpm test` だけでも当たるようにするためである。
 */
describe('check-agents-md-size: judgeAgentsMdSize', () => {
  it('予算未満なら ok で、overBytes は 0', () => {
    const result = judgeAgentsMdSize({ bytes: AGENTS_MD_MAX_BYTES - 100, lines: 500 });
    expect(result.ok).toBe(true);
    expect(result.overBytes).toBe(0);
    expect(result.overPercent).toBe(0);
    expect(result.slackBytes).toBe(100);
  });

  it('予算ちょうどは超過ではない（境界は超えていない側）', () => {
    const result = judgeAgentsMdSize({ bytes: AGENTS_MD_MAX_BYTES, lines: 500 });
    expect(result.ok).toBe(true);
    expect(result.overBytes).toBe(0);
    expect(result.slackBytes).toBe(0);
  });

  it('予算を超えると NG になり、overBytes / overPercent を持つ', () => {
    const overBy = Math.round(AGENTS_MD_MAX_BYTES * 0.1);
    const bytes = AGENTS_MD_MAX_BYTES + overBy;
    const result = judgeAgentsMdSize({ bytes, lines: 700 });
    expect(result.ok).toBe(false);
    expect(result.overBytes).toBe(overBy);
    expect(result.overPercent).toBeCloseTo(10, 0);
    expect(result.slackBytes).toBe(0);
  });

  it('usedPercent は予算に対する使用率を返す', () => {
    const result = judgeAgentsMdSize({ bytes: AGENTS_MD_MAX_BYTES / 2, lines: 300 });
    expect(result.usedPercent).toBeCloseTo(50, 0);
  });

  it('catWindows は cat の打ち切り（30,000 バイト）で何回に分かれるかを返す', () => {
    expect(judgeAgentsMdSize({ bytes: 1, lines: 1 }).catWindows).toBe(1);
    expect(judgeAgentsMdSize({ bytes: 30_000, lines: 1 }).catWindows).toBe(1);
    expect(judgeAgentsMdSize({ bytes: 30_001, lines: 1 }).catWindows).toBe(2);
    expect(judgeAgentsMdSize({ bytes: 60_000, lines: 1 }).catWindows).toBe(2);
    expect(judgeAgentsMdSize({ bytes: 60_001, lines: 1 }).catWindows).toBe(3);
  });

  it('bytes / lines をそのまま返す', () => {
    const result = judgeAgentsMdSize({ bytes: 12_345, lines: 67 });
    expect(result.bytes).toBe(12_345);
    expect(result.lines).toBe(67);
  });
});

describe('check-agents-md-size: BUDGET_HISTORY の構造', () => {
  it('1件以上ある', () => {
    expect(BUDGET_HISTORY.length).toBeGreaterThan(0);
  });

  it('date が YYYY-MM-DD の形である', () => {
    for (const entry of BUDGET_HISTORY) {
      expect(entry.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('date が非減少である（後の記録が前より古い日付を持たない）', () => {
    for (let i = 1; i < BUDGET_HISTORY.length; i++) {
      const prev = BUDGET_HISTORY[i - 1];
      const curr = BUDGET_HISTORY[i];
      expect(prev).toBeDefined();
      expect(curr).toBeDefined();
      if (prev !== undefined && curr !== undefined) {
        expect(curr.date >= prev.date).toBe(true);
      }
    }
  });

  it('bytes / lines が正の整数である', () => {
    for (const entry of BUDGET_HISTORY) {
      expect(Number.isInteger(entry.bytes)).toBe(true);
      expect(entry.bytes).toBeGreaterThan(0);
      expect(Number.isInteger(entry.lines)).toBe(true);
      expect(entry.lines).toBeGreaterThan(0);
    }
  });

  it('why が非空である（trim して長さ > 0）——中身の正しさまでは測らない', () => {
    for (const entry of BUDGET_HISTORY) {
      expect(entry.why.trim().length).toBeGreaterThan(0);
    }
  });

  it('ref が非空である', () => {
    for (const entry of BUDGET_HISTORY) {
      expect(entry.ref.trim().length).toBeGreaterThan(0);
    }
  });
});

describe('check-agents-md-size: AGENTS_MD_MAX_BYTES', () => {
  it('BUDGET_HISTORY の最新の件の bytes と一致する', () => {
    const latest = BUDGET_HISTORY[BUDGET_HISTORY.length - 1];
    expect(latest).toBeDefined();
    expect(AGENTS_MD_MAX_BYTES).toBe(latest?.bytes);
  });
});

describe('check-agents-md-size: 実ファイル', () => {
  const ROOT = fileURLToPath(new URL('..', import.meta.url));
  const AGENTS_MD_PATH = path.join(ROOT, 'AGENTS.md');

  it('AGENTS.md が読める大きさである（走査が壊れて0件・読めないことを緑と読まない足場）', () => {
    const stat = statSync(AGENTS_MD_PATH);
    // 2026-09-17 実測で 150,308 B。10万バイトを下回ったら「読めていない」
    // （空ファイル・別ファイルを指している等）を疑うべき差なので、ここで捕まえる。
    expect(stat.size).toBeGreaterThan(100_000);
  });

  it('いまの AGENTS.md の実測バイト数が予算以下である', () => {
    const text = readFileSync(AGENTS_MD_PATH, 'utf8');
    const bytes = Buffer.byteLength(text, 'utf8');
    const result = judgeAgentsMdSize({ bytes, lines: 0 });
    expect(
      result.ok,
      `AGENTS.md が ${bytes} B で予算 ${AGENTS_MD_MAX_BYTES} B を超えている。` +
        'scripts/check-agents-md-size-core.mjs の doc を見て、予算を上げるか本文を削るか判断すること。',
    ).toBe(true);
  });
});
