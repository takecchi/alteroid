// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { json, Providers, TestDataRouter, storeTestBaseUrl } from '~/test-support';

import EnvVars from './env-vars';

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

const LONG_NAME = 'ALTEROID_TOKEN_SAVING_FOLD_FIXED_TEXT';

function stubList() {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    if (!request.url.includes('/credentials'))
      throw new TypeError(`Failed to fetch: ${request.url}`);
    return json({
      credentials: [
        {
          name: LONG_NAME,
          sha256: 'a'.repeat(12),
          updatedAt: '2026-09-14T00:00:00.000Z',
          scope: 'app',
          secret: false,
          value: '0',
          restartRequired: true,
        },
        {
          name: 'NPM_TOKEN',
          sha256: 'b'.repeat(12),
          updatedAt: '2026-09-14T00:00:00.000Z',
          scope: 'runner',
          secret: true,
        },
      ],
    });
  }) as typeof fetch;
}

async function renderList() {
  stubList();
  render(
    <Providers>
      <TestDataRouter>
        <EnvVars />
      </TestDataRouter>
    </Providers>,
  );
  await screen.findByText(LONG_NAME);
}

function rowOf(name: string): HTMLElement {
  return screen.getByText(name).closest('[role="listitem"]') as HTMLElement;
}

function classesOf(element: Element): string[] {
  return (element.getAttribute('class') ?? '').split(/\s+/);
}

describe('/env-vars 一覧の行の並び（#5858）', () => {
  it('名前を行の先頭にして、渡す先の札と値は名前より後ろ（下の段）に置く', async () => {
    await renderList();
    const row = rowOf(LONG_NAME);
    const name = within(row).getByText(LONG_NAME);
    for (const later of [within(row).getByText('クローンだけ'), within(row).getByText('0')]) {
      expect(name.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });

  it('名前は切り詰めず折り返せる（truncate を持たず、祖先にも切る指定が無い）', async () => {
    await renderList();
    const row = rowOf(LONG_NAME);
    const name = within(row).getByText(LONG_NAME);
    for (let el: Element | null = name; el !== null && el !== row; el = el.parentElement) {
      const classes = classesOf(el);
      expect(classes).not.toContain('truncate');
      expect(classes).not.toContain('overflow-hidden');
    }
    expect(classesOf(name)).toContain('break-all');
  });

  it('「再起動で効く」の札は縮まず折り返さず、切る指定の中に入っていない', async () => {
    await renderList();
    const row = rowOf(LONG_NAME);
    const note = within(row).getByText('再起動で効く');
    expect(classesOf(note)).toEqual(expect.arrayContaining(['shrink-0', 'whitespace-nowrap']));
    for (let el: Element | null = note; el !== null && el !== row; el = el.parentElement) {
      expect(classesOf(el)).not.toContain('truncate');
    }
    expect(within(rowOf('NPM_TOKEN')).queryByText('再起動で効く')).toBeNull();
  });

  it('渡す先の札・値・操作のメニューが、名前と同じ行にある（伏せ字は ****** のまま）', async () => {
    await renderList();
    const app = rowOf(LONG_NAME);
    expect(within(app).getByText('クローンだけ')).toBeTruthy();
    expect(within(app).getByRole('button', { name: `「${LONG_NAME}」の操作` })).toBeTruthy();

    const secret = rowOf('NPM_TOKEN');
    expect(within(secret).getByText('マネージャーだけ')).toBeTruthy();
    expect(within(secret).getByText('******')).toBeTruthy();
    expect(within(secret).getByRole('button', { name: '「NPM_TOKEN」の操作' })).toBeTruthy();
  });

  it('値だけが長いときの切り詰めは下の段の値にだけ掛かる', async () => {
    await renderList();
    const value = within(rowOf(LONG_NAME)).getByText('0');
    expect(classesOf(value)).toContain('truncate');
  });
});
