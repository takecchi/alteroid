import { describe, expect, it } from 'vitest';

import { MERGED_BATCH_SIZE_LIMIT_ENV_KEY, resolveMergedBatchSizeLimit } from './clone.js';
import { captureStderr } from './testing.js';

/**
 * `resolveMergedBatchSizeLimit`（`ALTEROID_MERGED_BATCH_SIZE_LIMIT`）を固定する。
 * `resolveSynthesizedNoticeWindowMs`（`synthesized-notice-window-ms.test.ts`）と
 * 同じ作法——env は必ず引数で渡し、`process.env` を書き換えない。
 *
 * **既定は動かさない。** `clone.ts` の `MERGED_BATCH_SIZE_LIMIT`（50件）と
 * 同じ値をここでも直書きしている——エクスポートされていない内部定数なので、
 * 試験側で独立して値を持つ（`synthesized-notice-window-ms.test.ts` の
 * `DEFAULT_MS` と同じ理由）。
 */
const DEFAULT_LIMIT = 50;

describe('resolveMergedBatchSizeLimit', () => {
  it('正常値: 数値文字列をそのまま件数として読む', () => {
    expect(resolveMergedBatchSizeLimit({ [MERGED_BATCH_SIZE_LIMIT_ENV_KEY]: '10' })).toBe(10);
  });

  it('陰性対照: 未設定なら既定50件', () => {
    expect(resolveMergedBatchSizeLimit({})).toBe(DEFAULT_LIMIT);
  });

  it('空文字は既定50件へ倒す', () => {
    expect(resolveMergedBatchSizeLimit({ [MERGED_BATCH_SIZE_LIMIT_ENV_KEY]: '' })).toBe(
      DEFAULT_LIMIT,
    );
  });

  it('数値でない文字列は既定50件へ倒す', () => {
    expect(resolveMergedBatchSizeLimit({ [MERGED_BATCH_SIZE_LIMIT_ENV_KEY]: 'abc' })).toBe(
      DEFAULT_LIMIT,
    );
  });

  it('0以下（0・負数）は既定50件へ倒す', () => {
    expect(resolveMergedBatchSizeLimit({ [MERGED_BATCH_SIZE_LIMIT_ENV_KEY]: '0' })).toBe(
      DEFAULT_LIMIT,
    );
    expect(resolveMergedBatchSizeLimit({ [MERGED_BATCH_SIZE_LIMIT_ENV_KEY]: '-5' })).toBe(
      DEFAULT_LIMIT,
    );
  });

  it('小数は切り捨てる（束の件数は整数でなければ数えられない）', () => {
    expect(resolveMergedBatchSizeLimit({ [MERGED_BATCH_SIZE_LIMIT_ENV_KEY]: '10.7' })).toBe(10);
  });
});

/**
 * **「置かなかった」と「置いたのに読めなかった」を同じ沈黙に潰さない**
 * （`resolveSynthesizedNoticeWindowMs` の跡の describe と同じ理由・同じ形）。
 */
describe('resolveMergedBatchSizeLimit の跡（置いたのに読めなかったときだけ鳴る）', () => {
  it('非空だが数値として読めないときは跡を残す（値そのものは載せない）', async () => {
    const lines = await captureStderr(() => {
      expect(resolveMergedBatchSizeLimit({ [MERGED_BATCH_SIZE_LIMIT_ENV_KEY]: 'abc' })).toBe(
        DEFAULT_LIMIT,
      );
    });

    const noted = lines.filter((line) => line.includes('まとめ読みの束の上限件数の設定'));
    expect(noted).toHaveLength(1);
    expect(noted[0]).toContain('を読み出せませんでした');
    expect(noted[0]).toContain(MERGED_BATCH_SIZE_LIMIT_ENV_KEY);
    expect(noted[0]).toContain('数値として読めない');
    expect(noted[0]).not.toContain('abc');
  });

  it('非空で数値だが 0 以下のときも跡を残す（読めない側とは別の文言）', async () => {
    const lines = await captureStderr(() => {
      expect(resolveMergedBatchSizeLimit({ [MERGED_BATCH_SIZE_LIMIT_ENV_KEY]: '-5' })).toBe(
        DEFAULT_LIMIT,
      );
    });

    const noted = lines.filter((line) => line.includes('まとめ読みの束の上限件数の設定'));
    expect(noted).toHaveLength(1);
    expect(noted[0]).toContain('0 以下は上限にならない');
    expect(noted[0]).not.toContain('数値として読めない');
    expect(noted[0]).not.toContain('-5');
  });

  it('陰性対照: 未設定・空・空白のみでは跡を1行も出さない（正常な意思表示だから）', async () => {
    const lines = await captureStderr(() => {
      expect(resolveMergedBatchSizeLimit({})).toBe(DEFAULT_LIMIT);
      expect(resolveMergedBatchSizeLimit({ [MERGED_BATCH_SIZE_LIMIT_ENV_KEY]: '' })).toBe(
        DEFAULT_LIMIT,
      );
      expect(resolveMergedBatchSizeLimit({ [MERGED_BATCH_SIZE_LIMIT_ENV_KEY]: '   ' })).toBe(
        DEFAULT_LIMIT,
      );
    });

    expect(lines.filter((line) => line.includes('まとめ読みの束の上限件数の設定'))).toEqual([]);
  });

  it('陰性対照: 正常値でも跡を出さない', async () => {
    const lines = await captureStderr(() => {
      expect(resolveMergedBatchSizeLimit({ [MERGED_BATCH_SIZE_LIMIT_ENV_KEY]: '10' })).toBe(10);
    });

    expect(lines.filter((line) => line.includes('まとめ読みの束の上限件数の設定'))).toEqual([]);
  });
});
