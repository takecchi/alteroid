// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { json, Providers, stubFetch, storeTestBaseUrl } from '../test-support';

import { useAttachmentLimits } from './queries';

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

const LIMITS = {
  maxImageBytes: 40,
  maxFileBytes: 200,
  maxPerMessage: 30,
  maxTotalBytes: 400,
  retentionDays: 7,
};

function Probe() {
  const { data, error } = useAttachmentLimits();
  return (
    <span data-testid="state">
      {error !== undefined
        ? 'error'
        : data === undefined
          ? 'loading'
          : data === null
            ? 'none'
            : data.maxFileBytes}
    </span>
  );
}

function Toggle() {
  const [shown, setShown] = useState(true);
  return (
    <>
      <button onClick={() => setShown((v) => !v)}>toggle</button>
      {shown ? <Probe /> : null}
    </>
  );
}

async function remount() {
  await act(async () => screen.getByText('toggle').click());
  await act(async () => screen.getByText('toggle').click());
}

const limitsCalls = (calls: string[]) => calls.filter((url) => url.endsWith('/attachments/limits'));

describe('useAttachmentLimits', () => {
  it('取れた値は覚え、画面を出し直しても取り直さない', async () => {
    const stub = stubFetch((url) =>
      url.endsWith('/attachments/limits') ? json(LIMITS) : undefined,
    );
    render(
      <Providers>
        <Toggle />
      </Providers>,
    );
    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('200'));
    await remount();
    expect(screen.getByTestId('state').textContent).toBe('200');
    expect(limitsCalls(stub.calls)).toHaveLength(1);
  });

  it('404（古いデーモン）は null として覚え、取り直さない', async () => {
    const stub = stubFetch((url) =>
      url.endsWith('/attachments/limits') ? json({ error: 'not found' }, 404) : undefined,
    );
    render(
      <Providers>
        <Toggle />
      </Providers>,
    );
    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('none'));
    await remount();
    expect(screen.getByTestId('state').textContent).toBe('none');
    expect(limitsCalls(stub.calls)).toHaveLength(1);
  });

  it('接続失敗のあとは、次に使われたときに取り直してデーモンの値を使う', async () => {
    const stub = stubFetch(() => undefined);
    render(
      <Providers>
        <Toggle />
      </Providers>,
    );
    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('error'));
    stub.setRoute((url) => (url.endsWith('/attachments/limits') ? json(LIMITS) : undefined));
    await remount();
    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('200'));
    expect(limitsCalls(stub.calls)).toHaveLength(2);
  });

  it('壊れた応答（500）のあとも取り直す', async () => {
    const stub = stubFetch((url) =>
      url.endsWith('/attachments/limits') ? json({ error: 'x' }, 500) : undefined,
    );
    render(
      <Providers>
        <Toggle />
      </Providers>,
    );
    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('error'));
    stub.setRoute((url) => (url.endsWith('/attachments/limits') ? json(LIMITS) : undefined));
    await remount();
    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('200'));
  });
});
