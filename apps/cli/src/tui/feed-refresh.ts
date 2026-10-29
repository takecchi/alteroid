import type { JournalEntry } from '@alteroid/core';

import type { HeaderFeed } from './header-feed.js';

export const REFRESH_DEBOUNCE_MS = 700;

export interface RefreshOnFeedOptions {
  readonly affects: (type: string, entry: JournalEntry | null) => boolean;
  readonly idle: () => boolean;
  readonly refresh: () => void;
  readonly debounceMs?: number;
}

export function refreshOnFeed(feed: HeaderFeed, options: RefreshOnFeedOptions): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const off = feed.onEvent((type, entry) => {
    // `open`（張り直し）は取りこぼしがありうるので必ず取り直す
    if (type !== 'open' && !options.affects(type, entry)) return;
    if (options.idle() || timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (!options.idle()) options.refresh();
    }, options.debounceMs ?? REFRESH_DEBOUNCE_MS);
  });
  return () => {
    off();
    clearTimeout(timer);
    timer = undefined;
  };
}
