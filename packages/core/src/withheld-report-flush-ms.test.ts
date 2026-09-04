import { describe, expect, it } from 'vitest';

import { resolveWithheldReportFlushMs, WITHHELD_REPORT_FLUSH_MS_ENV_KEY } from './manager.js';
import { captureStderr } from './testing.js';

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

/**
 * **「置かなかった」と「置いたのに読めなかった」を同じ沈黙に潰さない**
 * （依頼者の決裁 2026-09-04）。
 *
 * 直上の describe が固定しているのは**返す値**（どの経路でも既定30分）で、
 * ここが固定するのは**跡**である。**2つの軸を1本の歯で混ぜない** —— 値の
 * 側は「全部既定へ倒す」で正しく、跡の側だけが4状態のうち2つでしか鳴らない。
 *
 * **なぜ跡が要るか。** 跡が無いと「置いたのに効いていない」ことが置いた本人
 * から見えない（`resolveWithheldReportFlushMs` の doc）。**なぜ全部では
 * 鳴らさないか。** 正常な状態（未設定・空）に跡を出すと跡の側がノイズで
 * 埋まり、本物の跡が見えなくなる —— 分ける基準は「次の一手が変わるか」で
 * あって、未設定・空の側には次の一手が無い。
 */
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
    // **値そのものは載せない**（`noteUnreadableRecord` の doc、#52 と同じ理由）。
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
    // **「数値として読めない」とは言い分ける**（どちらも「読めなかった」だが、
    // 置いた本人が直す先が違う —— 綴りを直すのか、値の大小を直すのか）。
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
