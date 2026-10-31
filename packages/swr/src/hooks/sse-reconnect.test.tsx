// @vitest-environment jsdom
// SSE を繋ぎ直すループの振る舞い（待ちの長さ・伸び方・戻り・止まる条件）を、2つのフックで同じに測る
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Providers, sse, stubFetch, storeTestBaseUrl, type FetchStub } from '../test-support';

import { useJournalLive } from './use-journal-live';
import { useTopology } from './use-topology';

const SNAPSHOT = {
  observedAt: '2026-10-04T00:00:00.000Z',
  clone: { state: 'idle' },
  storage: { state: 'ok' },
  runners: [],
  managers: [],
  links: [],
};

const cases = [
  {
    name: 'useJournalLive',
    path: '/journal/stream',
    frame: { event: 'open', data: { ok: true } },
    Probe: function JournalProbe() {
      useJournalLive();
      return null;
    },
  },
  {
    name: 'useTopology',
    path: '/topology/stream',
    frame: { event: 'snapshot', data: SNAPSHOT },
    Probe: function TopologyProbe() {
      useTopology();
      return null;
    },
  },
];

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  localStorage.clear();
  storeTestBaseUrl();
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  globalThis.fetch = originalFetch;
});

describe.each(cases)('$name の再接続', ({ path, frame, Probe }) => {
  const streams = (stub: FetchStub) => stub.calls.filter((url) => url.endsWith(path)).length;

  function mount() {
    return render(
      <Providers>
        <Probe />
      </Providers>,
    );
  }

  it('繋がらない間は 1・2・4・8・16 秒と伸ばし、30 秒で頭打ちにする', async () => {
    const stub = stubFetch(() => undefined);
    mount();
    await vi.advanceTimersByTimeAsync(0);
    expect(streams(stub)).toBe(1);

    // 1 回目の待ちは 1 秒ちょうど
    await vi.advanceTimersByTimeAsync(999);
    expect(streams(stub)).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(streams(stub)).toBe(2);

    // 以降の累計: 3・7・15・31 秒で 3〜6 回目
    await vi.advanceTimersByTimeAsync(2000);
    expect(streams(stub)).toBe(3);
    await vi.advanceTimersByTimeAsync(4000);
    expect(streams(stub)).toBe(4);
    await vi.advanceTimersByTimeAsync(8000);
    expect(streams(stub)).toBe(5);
    await vi.advanceTimersByTimeAsync(16000);
    expect(streams(stub)).toBe(6);

    // 頭打ち: 以降は 30 秒ごと
    await vi.advanceTimersByTimeAsync(29_999);
    expect(streams(stub)).toBe(6);
    await vi.advanceTimersByTimeAsync(1);
    expect(streams(stub)).toBe(7);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(streams(stub)).toBe(8);
  });

  it('メッセージが届くと待ちを 1 秒に戻す', async () => {
    let count = 0;
    const stub = stubFetch((url, init) => {
      if (!url.endsWith(path)) return undefined;
      count += 1;
      // 1・2 回目は失敗（待ちは 1 秒→2 秒）、3 回目以降は 1 枠届いて閉じる
      if (count < 3) return undefined;
      return sse([frame], { signal: init?.signal });
    });
    mount();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(2000);
    expect(streams(stub)).toBe(3);

    // 戻らなければ次の待ちは 4 秒。戻るなら 1 秒（枠の遅延 5ms を足して 2 秒以内）
    await vi.advanceTimersByTimeAsync(2000);
    expect(streams(stub)).toBe(4);
  });

  it('待っている間にアンマウントすると、もう繋ぎ直さない', async () => {
    const stub = stubFetch(() => undefined);
    const { unmount } = mount();
    await vi.advanceTimersByTimeAsync(0);
    expect(streams(stub)).toBe(1);
    unmount();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(streams(stub)).toBe(1);
  });

  it('アンマウントで接続を中断し、そのあと繋ぎ直さない', async () => {
    let signal: AbortSignal | null | undefined;
    const stub = stubFetch((url, init) => {
      if (!url.endsWith(path)) return undefined;
      signal = init?.signal;
      return sse([], { keepOpen: true, signal: init?.signal });
    });
    const { unmount } = mount();
    await vi.advanceTimersByTimeAsync(10);
    expect(signal?.aborted).toBe(false);
    unmount();
    expect(signal?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(streams(stub)).toBe(1);
  });
});
