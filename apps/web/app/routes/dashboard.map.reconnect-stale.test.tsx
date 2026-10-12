// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Providers, sse, stubFetch, storeTestBaseUrl } from '~/test-support';

import { topologySnapshot } from './dashboard-test-helpers';
import { LiveMap } from './dashboard-map';

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

const mapCard = () => screen.getByText('稼働状況').closest<HTMLElement>('[data-slot="card"]')!;

describe('張り直している間の地図（#4567）', () => {
  it('切れたあと張り直している最中（まだ次の snapshot が来ていない）も、古い地図だと断る', async () => {
    let streams = 0;
    stubFetch((url, init) => {
      if (!url.includes('/topology/stream')) return undefined;
      streams += 1;
      if (streams === 1) {
        // 1本目: snapshot を1つ流して閉じる（デーモンの再起動・経路の切断）
        return sse(
          [
            {
              event: 'snapshot',
              data: topologySnapshot({ observedAt: '2026-08-14T09:00:00.000Z' }),
            },
          ],
          { signal: init?.signal },
        );
      }
      // 2本目: 繋がったが最初の snapshot がまだ来ない
      return sse(
        [
          {
            event: 'snapshot',
            data: topologySnapshot(),
            after: new Promise(() => undefined),
          },
        ],
        { keepOpen: true, signal: init?.signal },
      );
    });

    render(
      <Providers>
        <MemoryRouter>
          <LiveMap />
        </MemoryRouter>
      </Providers>,
    );

    // 切れた: 古いと断る（既存の挙動）
    await within(mapCard()).findByText(/稼働状況の図への接続が切れている/);

    // 張り直しが始まる（2本目）
    await waitFor(() => expect(streams).toBeGreaterThan(1), { timeout: 4000 });

    // 張り直している間も、出ているのは最後に受け取った状態であって、いまの状態ではない
    await act(async () => {
      await Promise.resolve();
    });
    // 古い地図（最後の snapshot の札）は出続け、その上に「いまの状態ではない」の帯が出る
    expect(within(mapCard()).getAllByRole('button').length).toBeGreaterThan(0);
    expect(within(mapCard()).getByRole('status').textContent).toMatch(/いまの状態ではない/);
  });
});
