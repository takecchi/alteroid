import { describe, expect, it } from 'vitest';

import { chatLayout, CHROME_ROWS, isFullscreenViewport, MIN_FULLSCREEN_ROWS } from './layout.js';

describe('isFullscreenViewport', () => {
  it('閾値未満・行数不明はインライン描画へ縮退する', () => {
    expect(isFullscreenViewport(MIN_FULLSCREEN_ROWS)).toBe(true);
    expect(isFullscreenViewport(MIN_FULLSCREEN_ROWS - 1)).toBe(false);
    expect(isFullscreenViewport(undefined)).toBe(false);
  });
});

describe('chatLayout', () => {
  it('ログ + 状態 1 行 + 入力欄（枠 2 行 + 表示行）で本体を使い切る', () => {
    const l = chatLayout({ rows: 30, composerRows: 1, fullscreen: true });
    expect(l.bodyHeight).toBe(30 - CHROME_ROWS);
    expect(l.logHeight + 1 + (l.composerShown + 2)).toBe(l.bodyHeight);
  });

  it('入力欄は伸びるが上限があり、ログを 1 行は残す', () => {
    expect(chatLayout({ rows: 40, composerRows: 50, fullscreen: true }).composerShown).toBe(6);
    const small = chatLayout({ rows: 12, composerRows: 50, fullscreen: true });
    expect(small.logHeight).toBeGreaterThanOrEqual(1);
    expect(small.logHeight + 1 + small.composerShown + 2).toBe(small.bodyHeight);
  });
});
