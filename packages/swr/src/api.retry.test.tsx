// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useConversation, useUsage } from './hooks/queries';
import { json, Providers, stubFetch, storeTestBaseUrl } from './test-support';

function Probe() {
  const { error, mutate } = useUsage();
  return (
    <div>
      <p data-testid="error">{error === undefined ? 'none' : 'failed'}</p>
      <button type="button" onClick={() => void mutate()}>
        retry
      </button>
    </div>
  );
}

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  localStorage.clear();
  storeTestBaseUrl();
  // 固定の時計: SWR の取り直しの間隔は setTimeout で、実時間を待たずに 10 分を進めるため
  vi.useFakeTimers({
    now: new Date('2026-08-14T10:00:00Z'),
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  globalThis.fetch = originalFetch;
});

async function mountAndCount(status: number): Promise<{ afterMount: number; hits: () => number }> {
  let hits = 0;
  stubFetch((url) => {
    if (!url.includes('/usage')) return undefined;
    hits += 1;
    return json({ error: '失敗' }, status);
  });
  render(
    <Providers>
      <Probe />
    </Providers>,
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
  });
  expect(screen.getByTestId('error').textContent).toBe('failed');
  const afterMount = hits;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
  });
  return { afterMount, hits: () => hits };
}

describe('読み込みの失敗の裏の再試行', () => {
  it.each([400, 403, 404, 409, 422])(
    '%i は待っても直らないので、裏で取り直さない',
    async (status) => {
      const { afterMount, hits } = await mountAndCount(status);
      expect(afterMount).toBe(1);
      expect(hits()).toBe(1);
    },
  );

  it.each([500, 503])('%i は一時的な失敗なので、既定どおり裏で取り直す', async (status) => {
    const { afterMount, hits } = await mountAndCount(status);
    expect(hits()).toBeGreaterThan(afterMount);
  });

  describe('会話の読み（useConversation）', () => {
    function ConversationProbe({ retryOnNotFound }: { retryOnNotFound?: boolean }) {
      const { error } = useConversation('c1', { retryOnNotFound });
      return <p data-testid="error">{error === undefined ? 'none' : 'failed'}</p>;
    }

    async function conversationHits(status: number, retryOnNotFound?: boolean) {
      let hits = 0;
      stubFetch((url) => {
        if (!url.includes('/conversations/c1')) return undefined;
        hits += 1;
        return json({ error: '失敗' }, status);
      });
      render(
        <Providers>
          <ConversationProbe retryOnNotFound={retryOnNotFound} />
        </Providers>,
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
      });
      return hits;
    }

    it('404 は既定では取り直す: 作ったばかりの会話は、出来たら現れるため', async () => {
      expect(await conversationHits(404)).toBeGreaterThan(1);
    });

    it('404 でも、retryOnNotFound: false なら取り直さない', async () => {
      expect(await conversationHits(404, false)).toBe(1);
    });

    it('403 は、既定でも取り直さない', async () => {
      expect(await conversationHits(403)).toBe(1);
    });
  });

  it('403 でも、人間が押す「もう一度試す」（mutate）は取り直す', async () => {
    const { hits } = await mountAndCount(403);
    const before = hits();
    await act(async () => {
      screen.getByRole('button', { name: 'retry' }).click();
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(hits()).toBe(before + 1);
  });

  it('403 でも、focus での取り直しは変わらない', async () => {
    const { hits } = await mountAndCount(403);
    const before = hits();
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(hits()).toBe(before + 1);
  });
});
