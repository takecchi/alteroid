import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { formatDateTime, formatRelative } from '@alteroid/logic';

import { formatEpochMs, formatEpochMsRelative } from './format-epoch-ms';

const MS = Date.parse('2026-08-25T05:00:00.000Z');

beforeEach(() => {
  vi.useFakeTimers({ now: Date.parse('2026-08-25T04:00:00.000Z') });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('formatEpochMs', () => {
  it('ISO 文字列を formatDateTime に渡した文字列と同じ', () => {
    expect(formatEpochMs(MS)).toBe(formatDateTime('2026-08-25T05:00:00.000Z'));
  });
});

describe('formatEpochMsRelative', () => {
  it('ISO 文字列を formatRelative に渡した文字列と同じ', () => {
    expect(formatEpochMsRelative(MS)).toBe(formatRelative('2026-08-25T05:00:00.000Z'));
    expect(formatEpochMsRelative(MS)).toBe('1時間後');
  });
});
