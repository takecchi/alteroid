// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
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

interface Row {
  name: string;
  sha256: string;
  updatedAt: string;
  scope: 'all' | 'app' | 'runner';
  secret: boolean;
  value?: string;
  restartRequired?: true;
}

// 共有の stubFetch を使わない: openapi-fetch は fetch(new Request(...)) の形で呼ぶので、route(url, init) では method も本文も落ちるため
function stubScreen(rows: Row[], restartRequired: string[] | undefined) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : null;
    const url = request?.url ?? (typeof input === 'string' ? input : String(input));
    const method = request?.method ?? init?.method ?? 'GET';
    if (!url.includes('/credentials')) {
      return Promise.reject(new TypeError(`Failed to fetch: ${url}`));
    }
    if (method === 'PUT') {
      return json({
        credentials: rows,
        runners: [],
        ...(restartRequired === undefined ? {} : { restartRequired }),
      });
    }
    return json({ credentials: rows });
  }) as typeof fetch;
}

function renderScreen(): void {
  render(
    <Providers>
      <TestDataRouter>
        <EnvVars />
      </TestDataRouter>
    </Providers>,
  );
}

const NOTE = 'はデーモンの再起動で効く（それまでは前の値のまま動く）';

async function putVar(name: string, value: string): Promise<void> {
  await screen.findByRole('heading', { name: '一覧' });
  fireEvent.change(screen.getByPlaceholderText('TZ'), { target: { value: name } });
  fireEvent.change(screen.getByLabelText('値'), { target: { value } });
  fireEvent.click(screen.getByRole('button', { name: '置く' }));
}

describe('/env-vars 画面 — デーモンの再起動で効く名前（#4830）', () => {
  const ROW: Row = {
    name: 'ALTEROID_DAILY_REPORT_AT',
    sha256: 'f'.repeat(12),
    updatedAt: '2026-09-14T00:00:00.000Z',
    scope: 'app',
    secret: false,
    value: '22:00',
    restartRequired: true,
  };

  it('置いた結果に restartRequired が在れば、warn の色で「再起動で効く」と出す', async () => {
    stubScreen([], ['ALTEROID_DAILY_REPORT_AT']);
    renderScreen();

    await putVar('ALTEROID_DAILY_REPORT_AT', '09:00');

    const found = await screen.findAllByRole('status');
    const note = found.find((el) => el.textContent?.includes(NOTE));
    expect(note?.textContent).toContain('ALTEROID_DAILY_REPORT_AT');
    expect(note?.className).toContain('text-warn');
  });

  it('普通の名前（restartRequired が空・欄なし）では注記を出さない', async () => {
    stubScreen([{ ...ROW, name: 'GH_TOKEN', restartRequired: undefined }], []);
    renderScreen();
    await putVar('GH_TOKEN', 'x');
    await screen.findAllByText('GH_TOKEN');
    expect(screen.queryByText(new RegExp(NOTE.slice(0, 8)))).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();

    cleanup();
    stubScreen([{ ...ROW, name: 'GH_TOKEN', restartRequired: undefined }], undefined);
    renderScreen();
    await putVar('GH_TOKEN', 'y');
    await screen.findAllByText('GH_TOKEN');
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('削除の結果にも注記が出る', async () => {
    stubScreen([ROW], ['ALTEROID_DAILY_REPORT_AT']);
    renderScreen();
    const trigger = await screen.findByRole('button', {
      name: '「ALTEROID_DAILY_REPORT_AT」の操作',
    });
    fireEvent.keyDown(trigger, { key: 'Enter' });
    fireEvent.click(await screen.findByRole('menuitem', { name: '削除' }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: '削除' }));

    const note = await screen.findByRole('status');
    expect(note.textContent).toContain(NOTE);
  });

  it('一覧の該当の行に控えめに「再起動で効く」を出し、普通の行には出さない', async () => {
    stubScreen([ROW, { ...ROW, name: 'GH_TOKEN', restartRequired: undefined }], []);
    renderScreen();

    await screen.findAllByText('再起動で効く');
    const rows = await screen.findAllByRole('listitem');
    const flagged = rows.filter((row) => row.textContent?.includes('再起動で効く'));
    expect(flagged).toHaveLength(1);
    expect(flagged[0]?.textContent).toContain('ALTEROID_DAILY_REPORT_AT');
  });
});
