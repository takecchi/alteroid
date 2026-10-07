// @vitest-environment jsdom
import { cleanup, render, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ApiError } from '../api';
import { useCloseCommitment, useEditCommitment, usePushCommitment } from './mutations';
import { useCommitments, useProgress } from './queries';
import { writeThenRefresh } from './write-then-refresh';
import { json, Providers, stubFetch, storeTestBaseUrl } from '../test-support';

type Writes = {
  push: ReturnType<typeof usePushCommitment>;
  close: ReturnType<typeof useCloseCommitment>;
  edit: ReturnType<typeof useEditCommitment>;
};

let writes: Writes | undefined;

function Probe({ onWrites }: { onWrites: (next: Writes) => void }) {
  useCommitments(false);
  useCommitments(true);
  const push = usePushCommitment();
  const close = useCloseCommitment();
  const edit = useEditCommitment();
  useEffect(() => {
    onWrites({ push, close, edit });
  }, [onWrites, push, close, edit]);
  return null;
}

function receiveWrites(next: Writes): void {
  writes = next;
}

const REJECTION = 'c-1 は既に done に片付いている';

function stubRejectingWrites() {
  return stubFetch((url) => {
    const parsed = new URL(url);
    if (!parsed.pathname.startsWith('/commitments')) return undefined;
    if (parsed.pathname === '/commitments' && parsed.searchParams.has('includeClosed')) {
      return json({ entries: [] });
    }
    return json({ error: REJECTION }, 409);
  });
}

function getCount(calls: string[], includeClosed: boolean): number {
  return calls.filter((url) => {
    const parsed = new URL(url);
    return (
      parsed.pathname === '/commitments' &&
      parsed.searchParams.get('includeClosed') === String(includeClosed)
    );
  }).length;
}

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  localStorage.clear();
  storeTestBaseUrl();
  writes = undefined;
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

const CASES: { name: string; run: (w: Writes) => Promise<void> }[] = [
  { name: 'close', run: (w) => w.close('c-1', 'もう済んだ') },
  { name: '編集', run: (w) => w.edit('c-1', '直した本文') },
  { name: '積む', run: (w) => w.push('新しい約束') },
];

describe('台帳の書き込みが 409 で断られたとき（issue #2455）', () => {
  it.each(CASES)('$name: 失敗は投げたまま、台帳の両方のキーを取り直す', async ({ run }) => {
    const { calls } = stubRejectingWrites();
    render(
      <Providers>
        <Probe onWrites={receiveWrites} />
      </Providers>,
    );
    await waitFor(() => {
      expect(getCount(calls, false)).toBe(1);
      expect(getCount(calls, true)).toBe(1);
      expect(writes).toBeDefined();
    });

    const error: unknown = await run(writes!).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(409);
    expect((error as ApiError).message).toContain(REJECTION);

    expect(getCount(calls, false)).toBeGreaterThanOrEqual(2);
    expect(getCount(calls, true)).toBeGreaterThanOrEqual(2);
  });
});

describe('writeThenRefresh', () => {
  it('書き込みも取り直しも失敗したら、書き込みの失敗を投げる', async () => {
    const writeError = new Error('書き込みの失敗');
    const refreshError = new Error('取り直しの失敗');
    let refreshed = 0;
    const thrown: unknown = await writeThenRefresh(
      () => Promise.reject(writeError),
      () => {
        refreshed += 1;
        return Promise.reject(refreshError);
      },
    ).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(refreshed).toBe(1);
    expect(thrown).toBe(writeError);
  });

  it('書き込みが失敗しても取り直しを回し、書き込みの失敗を投げる', async () => {
    const writeError = new Error('書き込みの失敗');
    let refreshed = 0;
    const thrown: unknown = await writeThenRefresh(
      () => Promise.reject(writeError),
      () => {
        refreshed += 1;
        return Promise.resolve();
      },
    ).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(refreshed).toBe(1);
    expect(thrown).toBe(writeError);
  });

  it('書き込みが通って取り直しだけが失敗したら、取り直しの失敗を投げる', async () => {
    const refreshError = new Error('取り直しの失敗');
    const thrown: unknown = await writeThenRefresh(
      () => Promise.resolve(),
      () => Promise.reject(refreshError),
    ).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(thrown).toBe(refreshError);
  });

  it('どちらも通れば何も投げない', async () => {
    let refreshed = 0;
    await writeThenRefresh(
      () => Promise.resolve(),
      () => {
        refreshed += 1;
        return Promise.resolve();
      },
    );
    expect(refreshed).toBe(1);
  });
});

function progressCount(calls: string[], windowHours: string | null): number {
  return calls.filter((url) => {
    const parsed = new URL(url);
    return (
      parsed.pathname === '/progress' && parsed.searchParams.get('windowHours') === windowHours
    );
  }).length;
}

function ProgressProbe({ onWrites }: { onWrites: (next: Writes) => void }) {
  useProgress();
  useProgress(24);
  return <Probe onWrites={onWrites} />;
}

describe('台帳の書き込みが通ったあと、進捗を取り直す（issue #3747）', () => {
  it.each(CASES)('$name: 窓の違う進捗のキーをどちらも取り直す', async ({ run }) => {
    const { calls } = stubFetch((url) => {
      const parsed = new URL(url);
      if (parsed.pathname === '/progress') return json({});
      if (!parsed.pathname.startsWith('/commitments')) return undefined;
      if (parsed.pathname === '/commitments' && parsed.searchParams.has('includeClosed')) {
        return json({ entries: [] });
      }
      return json({});
    });
    render(
      <Providers>
        <ProgressProbe onWrites={receiveWrites} />
      </Providers>,
    );
    await waitFor(() => {
      expect(progressCount(calls, null)).toBe(1);
      expect(progressCount(calls, '24')).toBe(1);
      expect(writes).toBeDefined();
    });

    await run(writes!);

    expect(progressCount(calls, null)).toBeGreaterThanOrEqual(2);
    expect(progressCount(calls, '24')).toBeGreaterThanOrEqual(2);
  });
});
