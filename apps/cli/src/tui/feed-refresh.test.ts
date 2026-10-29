import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { REFRESH_DEBOUNCE_MS, refreshOnFeed } from './feed-refresh.js';
import type { HeaderFeed } from './header-feed.js';

function setup(options: { idle?: () => boolean; debounceMs?: number } = {}) {
  let listener: ((type: string) => void) | undefined;
  const off = vi.fn(() => {
    listener = undefined;
  });
  const feed = {
    onEvent: (l: (type: string) => void) => {
      listener = l;
      return off;
    },
  } as unknown as HeaderFeed;
  const refresh = vi.fn();
  const detach = refreshOnFeed(feed, {
    affects: (type) => type === 'memory_update',
    idle: options.idle ?? (() => false),
    refresh,
    debounceMs: options.debounceMs,
  });
  return { fire: (type: string) => listener?.(type), refresh, off, detach };
}

describe('refreshOnFeed', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('関係する出来事と open を間を置いて1回にまとめ、関係しない出来事では取り直さない', () => {
    const { fire, refresh } = setup();
    fire('exchange');
    vi.advanceTimersByTime(REFRESH_DEBOUNCE_MS);
    expect(refresh).not.toHaveBeenCalled();

    fire('memory_update');
    fire('open');
    vi.advanceTimersByTime(REFRESH_DEBOUNCE_MS - 1);
    expect(refresh).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('未読込のあいだは予約せず、間のあとにも未読込なら取り直さない', () => {
    let idle = true;
    const { fire, refresh } = setup({ idle: () => idle, debounceMs: 5 });
    fire('memory_update');
    idle = false;
    vi.advanceTimersByTime(5);
    expect(refresh).not.toHaveBeenCalled();

    fire('memory_update');
    idle = true;
    vi.advanceTimersByTime(5);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('外すと購読をやめ、予約済みの取り直しも止める', () => {
    const { fire, refresh, off, detach } = setup({ debounceMs: 5 });
    fire('memory_update');
    detach();
    vi.advanceTimersByTime(5);
    expect(off).toHaveBeenCalledTimes(1);
    expect(refresh).not.toHaveBeenCalled();
  });
});
