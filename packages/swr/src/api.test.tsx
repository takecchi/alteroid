// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StrictMode, useState } from 'react';

import { useHealth } from './hooks/queries';
import { json, Providers, stubFetch, storeTestBaseUrl, TEST_BASE_URL } from './test-support';

import { ApiError, unwrap, useApiContext } from './api';

const OTHER_BASE_URL = 'http://daemon-2.test';

function health(pid: number, storage: string) {
  return { ok: true, pid, operator: false, storage, auth: { enabled: false, providers: [] } };
}

function Probe() {
  const { baseUrl, setBaseUrl } = useApiContext();
  const { data } = useHealth();
  return (
    <div>
      <p data-testid="base-url">{baseUrl}</p>
      <p data-testid="pid">{data?.pid ?? 'loading'}</p>
      <button type="button" onClick={() => setBaseUrl(OTHER_BASE_URL)}>
        switch
      </button>
    </div>
  );
}

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  localStorage.clear();
  storeTestBaseUrl();
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

describe('接続先を切り替えたら、キャッシュに残った古い応答を捨てて引き直す（本4）', () => {
  it('health の pid が新しい接続先の値に変わる（読み込み直しは要らない）', async () => {
    const stub = stubFetch((url) => {
      if (url.startsWith(TEST_BASE_URL) && url.includes('/health')) {
        return json(health(1, '/old'));
      }
      if (url.startsWith(OTHER_BASE_URL) && url.includes('/health')) {
        return json(health(2, '/new'));
      }
      return undefined;
    });

    render(
      <Providers>
        <Probe />
      </Providers>,
    );

    await waitFor(() => expect(screen.getByTestId('pid').textContent).toBe('1'));

    screen.getByRole('button', { name: 'switch' }).click();

    await waitFor(() => expect(screen.getByTestId('base-url').textContent).toBe(OTHER_BASE_URL));
    await waitFor(() => expect(screen.getByTestId('pid').textContent).toBe('2'));

    expect(stub.calls.some((url) => url === `${OTHER_BASE_URL}/health`)).toBe(true);
  });

  it('新しい接続先で読み直しに失敗しても、前の接続先の値は残らない（#4078）', async () => {
    stubFetch((url) => {
      if (url.startsWith(TEST_BASE_URL) && url.includes('/health')) {
        return json(health(1, '/old'));
      }
      if (url.startsWith(OTHER_BASE_URL) && url.includes('/health')) {
        return json({ error: 'down' }, 503);
      }
      return undefined;
    });

    render(
      <Providers>
        <Probe />
      </Providers>,
    );

    await waitFor(() => expect(screen.getByTestId('pid').textContent).toBe('1'));

    screen.getByRole('button', { name: 'switch' }).click();

    await waitFor(() => expect(screen.getByTestId('base-url').textContent).toBe(OTHER_BASE_URL));
    await waitFor(() => expect(screen.getByTestId('pid').textContent).toBe('loading'));
  });

  it('書きかけの入力（画面の state）は、切り替えでキャッシュを捨てても残る', async () => {
    stubFetch((url) => {
      if (url.includes('/health')) return json(health(1, '/old'));
      return undefined;
    });

    function Draft() {
      const { baseUrl, setBaseUrl } = useApiContext();
      const { data } = useHealth();
      const [text, setText] = useState('');
      return (
        <div>
          <p data-testid="base-url">{baseUrl}</p>
          <p data-testid="pid">{data?.pid ?? 'loading'}</p>
          <input aria-label="draft" value={text} onChange={(e) => setText(e.target.value)} />
          <button type="button" onClick={() => setBaseUrl(OTHER_BASE_URL)}>
            switch
          </button>
        </div>
      );
    }

    render(
      <Providers>
        <Draft />
      </Providers>,
    );
    await waitFor(() => expect(screen.getByTestId('pid').textContent).toBe('1'));
    fireEvent.change(screen.getByLabelText('draft'), { target: { value: '書きかけ' } });

    screen.getByRole('button', { name: 'switch' }).click();
    await waitFor(() => expect(screen.getByTestId('base-url').textContent).toBe(OTHER_BASE_URL));
    await waitFor(() => expect(screen.getByTestId('pid').textContent).toBe('1'));

    expect((screen.getByLabelText('draft') as HTMLInputElement).value).toBe('書きかけ');
  });
});

describe('ApiError の message の伏せ字（issue #2600）', () => {
  it('トークンが消える', async () => {
    const { ApiError } = await import('./api');
    const token = `ghp_${'A1b2C3d4E5'.repeat(4)}`;
    expect(new ApiError(500, `failed ${token}`).message).not.toContain(token);
  });
});

describe('世代の紐（issue #2768）', () => {
  it('StrictMode で包んでも、通信が中断済みの紐で始まらない', async () => {
    stubFetch((url, init) => {
      if (url !== `${TEST_BASE_URL}/health`) return undefined;
      return new Promise<Response>((resolve, reject) => {
        setTimeout(() => {
          if (init?.signal?.aborted === true) {
            reject(new DOMException('signal is aborted without reason', 'AbortError'));
          } else {
            resolve(json(health(1, '/old')));
          }
        }, 5);
      });
    });

    render(
      <StrictMode>
        <Providers>
          <Probe />
        </Providers>
      </StrictMode>,
    );

    await waitFor(() => expect(screen.getByTestId('pid').textContent).toBe('1'));
  });

  it('接続先を切り替えたら、前の接続先への通信は打ち切られ、新しい側は生きている', async () => {
    const signals: Record<string, AbortSignal | null | undefined> = {};
    stubFetch((url, init) => {
      if (url === `${TEST_BASE_URL}/health`) {
        signals.old = init?.signal;
        return new Promise<Response>(() => {});
      }
      if (url === `${OTHER_BASE_URL}/health`) {
        signals.next = init?.signal;
        return json(health(2, '/new'));
      }
      return undefined;
    });

    render(
      <StrictMode>
        <Providers>
          <Probe />
        </Providers>
      </StrictMode>,
    );
    await waitFor(() => expect(signals.old).toBeDefined());
    expect(signals.old?.aborted).toBe(false);

    screen.getByRole('button', { name: 'switch' }).click();

    await waitFor(() => expect(screen.getByTestId('pid').textContent).toBe('2'));
    expect(signals.old?.aborted).toBe(true);
    expect(signals.next?.aborted).toBe(false);
  });
});

describe('ApiError の code（#2886）', () => {
  const response = (status: number) => new Response(null, { status });

  it('本文の code（文字列）を運ぶ。文言は error のまま', () => {
    try {
      unwrap({
        error: {
          error: '記録（日誌）が書けなかったので、変更していません',
          code: 'journal_write_failed',
        },
        response: response(500),
      });
      expect.unreachable();
    } catch (caught) {
      expect(caught).toBeInstanceOf(ApiError);
      expect((caught as ApiError).code).toBe('journal_write_failed');
      expect((caught as ApiError).message).toBe('記録（日誌）が書けなかったので、変更していません');
      expect((caught as ApiError).status).toBe(500);
    }
  });

  it('code が無い・文字列でない応答では undefined（既存の呼び出しは変わらない）', () => {
    for (const error of [{ error: '保存できなかった' }, { error: 'x', code: 42 }, 'text']) {
      try {
        unwrap({ error, response: response(500) });
        expect.unreachable();
      } catch (caught) {
        expect((caught as ApiError).code).toBeUndefined();
      }
    }
  });
});
