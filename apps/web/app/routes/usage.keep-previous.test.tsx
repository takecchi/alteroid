// @vitest-environment jsdom
/**
 * `/usage` 画面で絞り込みを替えても、読めていた中身を消さない（issue #3419）。
 *
 * 絞り込みを替えると SWR のキーが変わり、新しいキーの `data` が無い間、中身が全部
 * スピナーに入れ替わっていた。`useCommitments`（#3074）と同じく前の中身を残し、
 * 前の条件の数字を見せている間は、数字のそばで「読み込み中」と言う。
 * 初回（まだ何も読めていない）はこれまでどおりスピナーである。
 */
import { USAGE_ESTIMATE_NOTICE, ZERO_USAGE } from '@alteroid/core/usage';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { json, Providers, stubFetch, storeTestBaseUrl } from '~/test-support';

import Usage from './usage';

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

function usageBody(costUsd: number) {
  return {
    rows: [
      {
        date: '2026-08-14',
        managerId: 'm1',
        model: 'claude-opus-4',
        layer: 'manager',
        site: 'session',
        updatedAt: '2026-08-14T10:00:00.000Z',
        totals: { ...ZERO_USAGE, costUsd },
      },
    ],
    since: '2026-08-01T00:00:00.000Z',
    layersSince: '2026-08-01T00:00:00.000Z',
    beforeLedger: false,
    beforeLayers: false,
    notice: USAGE_ESTIMATE_NOTICE,
    breakdown: null,
    unrecordedManagers: [],
    turnRows: [],
    account: { state: 'unknown' },
  };
}

/** `layer` を付けた要求だけ、`release()` まで応答を止める。 */
function stubHeldLayer() {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  stubFetch((url) => {
    if (url.includes('/managers')) return json({ managers: [] });
    if (url.includes('/tokens')) return json({ tokens: [] });
    if (!url.includes('/usage')) return undefined;
    if (new URL(url).searchParams.has('layer')) {
      return gate.then(() => json(usageBody(34)));
    }
    return json(usageBody(12));
  });
  return release;
}

function renderUsage() {
  const router = createMemoryRouter([{ path: '/', Component: Usage }], { initialEntries: ['/'] });
  render(
    <Providers>
      <RouterProvider router={router} />
    </Providers>,
  );
}

const MARK = /前の条件の数字/;

describe('/usage 画面 — 絞り込みを替えても前の中身を残す（#3419）', () => {
  it('替えたあと新しい応答が来るまで、前の数字が見え、そばに読み込み中の印がある', async () => {
    stubHeldLayer();
    renderUsage();
    expect((await screen.findAllByText('$12.00')).length).toBeGreaterThan(0);
    expect(screen.queryByText(MARK)).toBeNull();

    fireEvent.change(screen.getByLabelText('誰が'), { target: { value: 'manager' } });

    expect(await screen.findByText(MARK)).toBeTruthy();
    // 前の数字はスピナーに入れ替わらず残っている。
    expect(screen.getAllByText('$12.00').length).toBeGreaterThan(0);
  });

  it('新しい応答が来たら印が消え、新しい数字になる', async () => {
    const release = stubHeldLayer();
    renderUsage();
    await screen.findAllByText('$12.00');
    fireEvent.change(screen.getByLabelText('誰が'), { target: { value: 'manager' } });
    await screen.findByText(MARK);

    await act(async () => {
      release();
    });

    await waitFor(() => {
      expect(screen.queryByText(MARK)).toBeNull();
    });
    expect(screen.getAllByText('$34.00').length).toBeGreaterThan(0);
    expect(screen.queryByText('$12.00')).toBeNull();
  });

  it('初回（まだ何も読めていない）は印ではなくスピナーである', async () => {
    stubFetch((url) => {
      if (url.includes('/managers')) return json({ managers: [] });
      if (url.includes('/tokens')) return json({ tokens: [] });
      if (url.includes('/usage')) return new Promise<Response>(() => {});
      return undefined;
    });
    renderUsage();

    expect(await screen.findByText('読み込み中')).toBeTruthy();
    expect(screen.queryByText(MARK)).toBeNull();
  });
});
