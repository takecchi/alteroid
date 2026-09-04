import { describe, expect, it } from 'vitest';

import { resolveWithheldReportFlushMs, WITHHELD_REPORT_FLUSH_MS_ENV_KEY } from './manager.js';

/**
 * `resolveWithheldReportFlushMs`（`ALTEROID_WITHHELD_REPORT_FLUSH_MS`）を
 * 固定する。`resolveWorkspacePolicy`（`manager-workspace-policy.test.ts`）・
 * `resolveManagerModel`（`runner.ts`）と同じ作法——env は必ず引数で渡し、
 * `process.env` を書き換えない。
 *
 * **既定は動かさない。** `manager.ts` の `WITHHELD_REPORT_FLUSH_MS`（30分）と
 * 同じ値をここでも直書きしている（`manager-withheld-reports.test.ts` の
 * ローカル定数と同じ理由——エクスポートされていない内部定数なので、試験側で
 * 独立して値を持つ）。
 */
const DEFAULT_MS = 30 * 60_000;

describe('resolveWithheldReportFlushMs', () => {
  it('正常値: 数値文字列をそのまま ms として読む', () => {
    expect(resolveWithheldReportFlushMs({ [WITHHELD_REPORT_FLUSH_MS_ENV_KEY]: '600000' })).toBe(
      600_000,
    );
  });

  it('陰性対照: 未設定なら既定30分', () => {
    expect(resolveWithheldReportFlushMs({})).toBe(DEFAULT_MS);
  });

  it('空文字は既定30分へ倒す', () => {
    expect(resolveWithheldReportFlushMs({ [WITHHELD_REPORT_FLUSH_MS_ENV_KEY]: '' })).toBe(
      DEFAULT_MS,
    );
  });

  it('数値でない文字列は既定30分へ倒す', () => {
    expect(resolveWithheldReportFlushMs({ [WITHHELD_REPORT_FLUSH_MS_ENV_KEY]: 'abc' })).toBe(
      DEFAULT_MS,
    );
  });

  it('0以下（0・負数）は既定30分へ倒す', () => {
    expect(resolveWithheldReportFlushMs({ [WITHHELD_REPORT_FLUSH_MS_ENV_KEY]: '0' })).toBe(
      DEFAULT_MS,
    );
    expect(resolveWithheldReportFlushMs({ [WITHHELD_REPORT_FLUSH_MS_ENV_KEY]: '-1000' })).toBe(
      DEFAULT_MS,
    );
  });
});
