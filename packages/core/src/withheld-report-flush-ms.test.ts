import { describe, expect, it } from 'vitest';

import { resolveWithheldReportFlushMs, WITHHELD_REPORT_FLUSH_MS_ENV_KEY } from './manager.js';
import { captureStderr } from './testing.js';

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

describe('resolveWithheldReportFlushMs の跡（置いたのに読めなかったときだけ鳴る）', () => {
  it('非空だが数値として読めないときは跡を残す（値そのものは載せない）', async () => {
    const lines = await captureStderr(() => {
      expect(resolveWithheldReportFlushMs({ [WITHHELD_REPORT_FLUSH_MS_ENV_KEY]: 'abc' })).toBe(
        DEFAULT_MS,
      );
    });

    const noted = lines.filter((line) => line.includes('握り潰しの配り直しの期限の設定'));
    expect(noted).toHaveLength(1);
    expect(noted[0]).toContain('を読み出せませんでした');
    expect(noted[0]).toContain(WITHHELD_REPORT_FLUSH_MS_ENV_KEY);
    expect(noted[0]).toContain('数値として読めない');
    expect(noted[0]).not.toContain('abc');
  });

  it('非空で数値だが 0 以下のときも跡を残す（読めない側とは別の文言）', async () => {
    const lines = await captureStderr(() => {
      expect(resolveWithheldReportFlushMs({ [WITHHELD_REPORT_FLUSH_MS_ENV_KEY]: '-1000' })).toBe(
        DEFAULT_MS,
      );
    });

    const noted = lines.filter((line) => line.includes('握り潰しの配り直しの期限の設定'));
    expect(noted).toHaveLength(1);
    expect(noted[0]).toContain('0 以下は期限にならない');
    expect(noted[0]).not.toContain('数値として読めない');
    expect(noted[0]).not.toContain('-1000');
  });

  it('陰性対照: 未設定・空・空白のみでは跡を1行も出さない（正常な意思表示だから）', async () => {
    const lines = await captureStderr(() => {
      expect(resolveWithheldReportFlushMs({})).toBe(DEFAULT_MS);
      expect(resolveWithheldReportFlushMs({ [WITHHELD_REPORT_FLUSH_MS_ENV_KEY]: '' })).toBe(
        DEFAULT_MS,
      );
      expect(resolveWithheldReportFlushMs({ [WITHHELD_REPORT_FLUSH_MS_ENV_KEY]: '   ' })).toBe(
        DEFAULT_MS,
      );
    });

    expect(lines.filter((line) => line.includes('握り潰しの配り直しの期限の設定'))).toEqual([]);
  });

  it('陰性対照: 正常値でも跡を出さない', async () => {
    const lines = await captureStderr(() => {
      expect(resolveWithheldReportFlushMs({ [WITHHELD_REPORT_FLUSH_MS_ENV_KEY]: '600000' })).toBe(
        600_000,
      );
    });

    expect(lines.filter((line) => line.includes('握り潰しの配り直しの期限の設定'))).toEqual([]);
  });
});
