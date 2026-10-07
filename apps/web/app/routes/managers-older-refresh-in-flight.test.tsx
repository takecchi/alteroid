// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { useJournalLive, MANAGERS_PAGE } from '@alteroid/swr';
import type { ManagerSummary } from '@alteroid/logic';
import { json, Providers, sse, stubFetch, storeTestBaseUrl } from '~/test-support';

import Managers from './managers';

// getByRole('list') にしない: ロール照会は全要素の役割・可視性を計算し、100 行規模では1回が数十 ms かかって、waitFor の繰り返しごとに払うと器が混んだ時にテストの5秒の枠を食い潰すため
function row() {
  const list = document.querySelector('ul');
  if (list === null) throw new Error('一覧（ul）がまだ描かれていない');
  return within(list);
}

function pageText(): string {
  return document.body.textContent ?? '';
}

function buttonByText(label: RegExp): HTMLButtonElement {
  const button = screen.getByText(label).closest('button');
  if (button === null) throw new Error('ボタンとして描かれていない: ' + String(label));
  return button;
}

const BASE: ManagerSummary = {
  managerId: 'mgr-1',
  status: 'running',
  live: true,
  cwd: '/work/project',
  request: 'PR を出して',
  startedAt: '2026-08-16T03:00:00.000Z',
  updatedAt: '2026-08-16T03:15:00.000Z',
  waiting: [],
};

function firstPage(count: number): ManagerSummary[] {
  return Array.from({ length: count }, (_, index) => ({
    ...BASE,
    managerId: `mgr-${index}`,
    request: `req-mgr-${index}`,
    status: 'running',
    startedAt: new Date(Date.UTC(2026, 7, 16, 3, 0, 0) - index * 60_000).toISOString(),
  }));
}

function page2Body(status: ManagerSummary['status'], live: boolean) {
  return {
    managers: [
      {
        ...BASE,
        managerId: `mgr-${MANAGERS_PAGE}`,
        request: `req-mgr-${MANAGERS_PAGE}`,
        status,
        live,
        startedAt: new Date(Date.UTC(2026, 7, 16, 3, 0, 0) - MANAGERS_PAGE * 60_000).toISOString(),
      },
    ],
  };
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

function Sentinel() {
  useJournalLive();
  return null;
}

describe('背景の取り直しが走っている間の分は取りこぼさない（issue #1624 のレビュー指摘）', () => {
  it('R1 が保留の間に届いた②のぶんも、R1 が終わったら追い撃ち（R2）で拾う', async () => {
    let page2Status: ManagerSummary['status'] = 'running';
    let page2Live = true;

    let resolveTrigger1: () => void = () => undefined;
    const trigger1 = new Promise<void>((resolve) => {
      resolveTrigger1 = resolve;
    });
    let resolveTrigger2: () => void = () => undefined;
    const trigger2 = new Promise<void>((resolve) => {
      resolveTrigger2 = resolve;
    });

    let afterIdCallCount = 0;
    let resolveR1: (() => void) | undefined;
    const r1Gate = new Promise<void>((resolve) => {
      resolveR1 = resolve;
    });

    const stub = stubFetch((url, init) => {
      if (url.endsWith('/journal/stream')) {
        return sse(
          [
            { event: 'open', data: { ok: true } },
            {
              event: 'exchange',
              data: {
                type: 'exchange',
                id: 'e1',
                at: '2026-08-16T04:00:00.000Z',
                with: 'manager',
                role: 'inbound',
                text: 'マネージャーからの発言 その1',
              },
              after: trigger1,
            },
            {
              event: 'exchange',
              data: {
                type: 'exchange',
                id: 'e2',
                at: '2026-08-16T04:05:00.000Z',
                with: 'manager',
                role: 'inbound',
                text: 'マネージャーからの発言 その2',
              },
              after: trigger2,
            },
          ],
          { keepOpen: true, signal: init?.signal },
        );
      }
      if (!url.includes('/managers')) return undefined;
      if (url.includes('afterId=')) {
        afterIdCallCount += 1;
        if (afterIdCallCount === 2) {
          const frozen = json(page2Body(page2Status, page2Live));
          return r1Gate.then(() => frozen);
        }
        return json(page2Body(page2Status, page2Live));
      }
      return json({ managers: firstPage(MANAGERS_PAGE) });
    });

    const router = createMemoryRouter([{ path: '/', Component: Managers }], {
      initialEntries: ['/'],
    });
    render(
      <Providers>
        <Sentinel />
        <RouterProvider router={router} />
      </Providers>,
    );

    await waitFor(() => {
      expect(pageText()).toContain('req-mgr-0');
    });

    fireEvent.click(buttonByText(/^もっと見る（いま \d+ 件）$/));
    await waitFor(() => {
      expect(pageText()).toContain(`req-mgr-${MANAGERS_PAGE}`);
    });
    expect(afterIdCallCount).toBe(1);

    resolveTrigger1();
    await waitFor(() => {
      expect(
        stub.calls.filter((url) => url.includes('/managers') && !url.includes('afterId=')).length,
      ).toBeGreaterThan(1);
    });
    await waitFor(() => {
      expect(afterIdCallCount).toBe(2);
    });

    page2Status = 'lost';
    page2Live = false;

    resolveTrigger2();
    await waitFor(() => {
      expect(
        stub.calls.filter((url) => url.includes('/managers') && !url.includes('afterId=')).length,
      ).toBeGreaterThan(2);
    });

    resolveR1?.();

    await waitFor(() => {
      expect(afterIdCallCount).toBeGreaterThan(2);
    });

    await waitFor(() => {
      const page2RowAfter = row().getByText(`req-mgr-${MANAGERS_PAGE}`).closest('li');
      expect(page2RowAfter).not.toBeNull();
      expect(within(page2RowAfter as HTMLElement).getByText('セッションへ戻れず')).toBeTruthy();
    });
  });
});
