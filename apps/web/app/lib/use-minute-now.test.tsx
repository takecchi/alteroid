// @vitest-environment jsdom
/**
 * #3596。相対の時刻（「たった今」「N分前」）を分単位で更新する共通の now。
 * **実時間を待たない**（偽のタイマーで時計を進める）。
 */
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { formatRelative } from '@alteroid/logic';

import { useMinuteNow } from './use-now';

const START = new Date('2026-10-07T12:00:00.000Z').getTime();
const CREATED = new Date(START).toISOString();

function Label({ enabled = true }: { enabled?: boolean }) {
  const now = useMinuteNow(enabled);
  return <p data-testid="label">{formatRelative(CREATED, now)}</p>;
}

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
}

beforeEach(() => {
  vi.useFakeTimers({ now: START });
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const label = () => screen.getByTestId('label').textContent;

describe('useMinuteNow', () => {
  it('分が進むと、相対の表示が作り直される（たった今 → N分前）', () => {
    render(<Label />);
    expect(label()).toBe('たった今');
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(label()).toBe('1分前');
    act(() => {
      vi.advanceTimersByTime(4 * 60_000);
    });
    expect(label()).toBe('5分前');
  });

  it('刻みは1本だけ。購読者が全員いなくなれば止まる', () => {
    const first = render(<Label />);
    const second = render(<Label />);
    expect(vi.getTimerCount()).toBe(1);
    first.unmount();
    expect(vi.getTimerCount()).toBe(1);
    second.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('enabled が偽のあいだは回さない', () => {
    render(<Label enabled={false} />);
    expect(vi.getTimerCount()).toBe(0);
    act(() => {
      vi.advanceTimersByTime(5 * 60_000);
    });
    expect(label()).toBe('たった今');
  });

  it('タブが隠れているあいだは回さず、見えた瞬間に追いつく', () => {
    render(<Label />);
    expect(vi.getTimerCount()).toBe(1);
    act(() => setVisibility('hidden'));
    expect(vi.getTimerCount()).toBe(0);
    act(() => {
      vi.advanceTimersByTime(10 * 60_000);
    });
    // 隠れているあいだは再描画しない。
    expect(label()).toBe('たった今');
    act(() => setVisibility('visible'));
    expect(label()).toBe('10分前');
    expect(vi.getTimerCount()).toBe(1);
  });

  it('隠れた状態で始まったときは、見えるまで回さない', () => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    render(<Label />);
    expect(vi.getTimerCount()).toBe(0);
  });
});
