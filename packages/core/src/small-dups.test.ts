import { describe, expect, it } from 'vitest';

import { assertNever } from './assert-never.js';
import { readAttachmentLimits, readIntegrationAttachmentNoticeBytes } from './attachment.js';
import { stripNulDeep } from './nul-guard.js';
import { secondsToEpochMs } from './usage-limits.js';

describe('assertNever', () => {
  it('ラベルと JSON 化した値を投げる', () => {
    expect(() => assertNever('未知の状態', 'bogus' as never)).toThrow('未知の状態: "bogus"');
  });
});

describe('secondsToEpochMs', () => {
  it('秒はミリ秒へ、ミリ秒の桁はそのまま、不正は undefined', () => {
    expect(secondsToEpochMs(1_700_000_000)).toBe(1_700_000_000_000);
    expect(secondsToEpochMs(1_700_000_000_123)).toBe(1_700_000_000_123);
    expect(secondsToEpochMs(1e11)).toBe(1e14);
    expect(secondsToEpochMs(1e11 + 1)).toBe(1e11 + 1);
    expect(secondsToEpochMs(0)).toBeUndefined();
    expect(secondsToEpochMs(-1)).toBeUndefined();
    expect(secondsToEpochMs(Number.NaN)).toBeUndefined();
    expect(secondsToEpochMs('1')).toBeUndefined();
  });
});

describe('stripNulDeep', () => {
  it('文字列・鍵・入れ子・配列の NUL を落とし、他の値はそのまま', () => {
    expect(stripNulDeep({ 'a\0b': ['x\0', { 'k\0': 'v\0' }, 1, null, true], n: null })).toEqual({
      ab: ['x', { k: 'v' }, 1, null, true],
      n: null,
    });
    expect(stripNulDeep('\0')).toBe('');
    expect(stripNulDeep(null)).toBeNull();
  });
});

describe('環境変数の正の整数の読み', () => {
  it('不正・超過は既定へ倒して同じ文を添える', () => {
    const { limits, notes } = readAttachmentLimits({
      ALTEROID_ATTACHMENT_MAX_IMAGE_BYTES: 'abc',
      ALTEROID_ATTACHMENT_RETENTION_DAYS: '99999999',
    });
    expect(limits.maxImageBytes).toBeGreaterThan(0);
    expect(notes).toHaveLength(2);
    expect(notes[0]).toMatch(
      /^ALTEROID_ATTACHMENT_MAX_IMAGE_BYTES="abc" は正の整数として読めないので既定 \d+ を使う$/,
    );
    expect(notes[1]).toMatch(
      /^ALTEROID_ATTACHMENT_RETENTION_DAYS="99999999" は上限 \d+ を超えているので既定 \d+ を使う$/,
    );
  });

  it('連携の知らせの閾値', () => {
    expect(readIntegrationAttachmentNoticeBytes({}).notes).toEqual([]);
    expect(
      readIntegrationAttachmentNoticeBytes({ ALTEROID_ATTACHMENT_INTEGRATION_NOTICE_BYTES: ' 5 ' }),
    ).toEqual({ bytes: 5, notes: [] });
    const bad = readIntegrationAttachmentNoticeBytes({
      ALTEROID_ATTACHMENT_INTEGRATION_NOTICE_BYTES: '-1',
    });
    expect(bad.bytes).toBe(1024 * 1024 * 1024);
    expect(bad.notes).toEqual([
      `ALTEROID_ATTACHMENT_INTEGRATION_NOTICE_BYTES="-1" は正の整数として読めないので既定 ${1024 ** 3} を使う`,
    ]);
  });
});
