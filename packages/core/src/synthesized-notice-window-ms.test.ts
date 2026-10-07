import { describe, expect, it } from 'vitest';

import {
  resolveSynthesizedNoticeWindowMs,
  SYNTHESIZED_NOTICE_WINDOW_MS_ENV_KEY,
} from './manager.js';
import { captureStderr } from './testing.js';

const DEFAULT_MS = 3_000;

describe('resolveSynthesizedNoticeWindowMs', () => {
  it('正常値: 数値文字列をそのまま ms として読む', () => {
    expect(
      resolveSynthesizedNoticeWindowMs({ [SYNTHESIZED_NOTICE_WINDOW_MS_ENV_KEY]: '5000' }),
    ).toBe(5000);
  });

  it('陰性対照: 未設定なら既定3000ms', () => {
    expect(resolveSynthesizedNoticeWindowMs({})).toBe(DEFAULT_MS);
  });

  it('空文字は既定3000msへ倒す', () => {
    expect(resolveSynthesizedNoticeWindowMs({ [SYNTHESIZED_NOTICE_WINDOW_MS_ENV_KEY]: '' })).toBe(
      DEFAULT_MS,
    );
  });

  it('数値でない文字列は既定3000msへ倒す', () => {
    expect(
      resolveSynthesizedNoticeWindowMs({ [SYNTHESIZED_NOTICE_WINDOW_MS_ENV_KEY]: 'abc' }),
    ).toBe(DEFAULT_MS);
  });

  it('0以下（0・負数）は既定3000msへ倒す', () => {
    expect(resolveSynthesizedNoticeWindowMs({ [SYNTHESIZED_NOTICE_WINDOW_MS_ENV_KEY]: '0' })).toBe(
      DEFAULT_MS,
    );
    expect(
      resolveSynthesizedNoticeWindowMs({ [SYNTHESIZED_NOTICE_WINDOW_MS_ENV_KEY]: '-1000' }),
    ).toBe(DEFAULT_MS);
  });
});

describe('resolveSynthesizedNoticeWindowMs の跡（置いたのに読めなかったときだけ鳴る）', () => {
  it('非空だが数値として読めないときは跡を残す（値そのものは載せない）', async () => {
    const lines = await captureStderr(() => {
      expect(
        resolveSynthesizedNoticeWindowMs({ [SYNTHESIZED_NOTICE_WINDOW_MS_ENV_KEY]: 'abc' }),
      ).toBe(DEFAULT_MS);
    });

    const noted = lines.filter((line) => line.includes('機構合成の知らせをまとめる窓の長さの設定'));
    expect(noted).toHaveLength(1);
    expect(noted[0]).toContain('を読み出せませんでした');
    expect(noted[0]).toContain(SYNTHESIZED_NOTICE_WINDOW_MS_ENV_KEY);
    expect(noted[0]).toContain('数値として読めない');
    expect(noted[0]).not.toContain('abc');
  });

  it('非空で数値だが 0 以下のときも跡を残す（読めない側とは別の文言）', async () => {
    const lines = await captureStderr(() => {
      expect(
        resolveSynthesizedNoticeWindowMs({ [SYNTHESIZED_NOTICE_WINDOW_MS_ENV_KEY]: '-1000' }),
      ).toBe(DEFAULT_MS);
    });

    const noted = lines.filter((line) => line.includes('機構合成の知らせをまとめる窓の長さの設定'));
    expect(noted).toHaveLength(1);
    expect(noted[0]).toContain('0 以下は期限にならない');
    expect(noted[0]).not.toContain('数値として読めない');
    expect(noted[0]).not.toContain('-1000');
  });

  it('陰性対照: 未設定・空・空白のみでは跡を1行も出さない（正常な意思表示だから）', async () => {
    const lines = await captureStderr(() => {
      expect(resolveSynthesizedNoticeWindowMs({})).toBe(DEFAULT_MS);
      expect(resolveSynthesizedNoticeWindowMs({ [SYNTHESIZED_NOTICE_WINDOW_MS_ENV_KEY]: '' })).toBe(
        DEFAULT_MS,
      );
      expect(
        resolveSynthesizedNoticeWindowMs({ [SYNTHESIZED_NOTICE_WINDOW_MS_ENV_KEY]: '   ' }),
      ).toBe(DEFAULT_MS);
    });

    expect(
      lines.filter((line) => line.includes('機構合成の知らせをまとめる窓の長さの設定')),
    ).toEqual([]);
  });

  it('陰性対照: 正常値でも跡を出さない', async () => {
    const lines = await captureStderr(() => {
      expect(
        resolveSynthesizedNoticeWindowMs({ [SYNTHESIZED_NOTICE_WINDOW_MS_ENV_KEY]: '5000' }),
      ).toBe(5000);
    });

    expect(
      lines.filter((line) => line.includes('機構合成の知らせをまとめる窓の長さの設定')),
    ).toEqual([]);
  });
});
