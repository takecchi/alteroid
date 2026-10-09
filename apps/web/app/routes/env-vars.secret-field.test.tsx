// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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

const PLAIN_ROW = {
  name: 'TZ',
  sha256: 'b'.repeat(12),
  updatedAt: '2026-09-14T00:00:00.000Z',
  scope: 'all',
  secret: false,
  value: 'UTC',
};

const SECRET_ROW = {
  name: 'NPM_TOKEN',
  sha256: 'a'.repeat(12),
  updatedAt: '2026-09-14T00:00:00.000Z',
  scope: 'all',
  secret: true,
};

const PEM = '-----BEGIN KEY-----\nAAAA\nBBBB\n-----END KEY-----';

function stubServer(rows: unknown[]) {
  const puts: unknown[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    if (!request.url.includes('/credentials'))
      throw new TypeError(`Failed to fetch: ${request.url}`);
    if (request.method === 'PUT') {
      puts.push(((await request.json()) as { credentials: unknown[] }).credentials);
      return json({ credentials: rows, runners: [] });
    }
    return json({ credentials: rows });
  }) as typeof fetch;
  return { puts };
}

function renderScreen() {
  render(
    <Providers>
      <TestDataRouter>
        <EnvVars />
      </TestDataRouter>
    </Providers>,
  );
}

async function openEdit(name: string) {
  const trigger = await screen.findByRole('button', { name: `「${name}」の操作` });
  fireEvent.keyDown(trigger, { key: 'Enter' });
  fireEvent.click(await screen.findByRole('menuitem', { name: '編集' }));
  return screen.findByRole('dialog');
}

describe('環境変数の編集の窓 — 書きかけを確認なしに捨てない（#3418）', () => {
  it('値を変えて Esc を押すと閉じずに確認を出し、「編集に戻る」で打った値のまま戻る', async () => {
    stubServer([PLAIN_ROW]);
    renderScreen();
    const dialog = await openEdit('TZ');
    fireEvent.change(within(dialog).getByLabelText('値'), { target: { value: 'Asia/Tokyo' } });

    fireEvent.keyDown(dialog, { key: 'Escape' });

    const confirm = await screen.findByRole('alertdialog');
    expect(within(confirm).getByText('書きかけの編集があります')).toBeTruthy();
    fireEvent.click(within(confirm).getByRole('button', { name: '編集に戻る' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(screen.getByRole('dialog')).toBe(dialog);
    expect((within(dialog).getByLabelText('値') as HTMLInputElement).value).toBe('Asia/Tokyo');
  });

  it('渡す先だけを変えても書きかけと数え、「破棄して閉じる」で何も送らずに閉じる', async () => {
    const { puts } = stubServer([PLAIN_ROW]);
    renderScreen();
    const dialog = await openEdit('TZ');
    fireEvent.change(within(dialog).getByLabelText('渡す先'), { target: { value: 'runner' } });

    fireEvent.click(within(dialog).getByRole('button', { name: 'やめる' }));
    fireEvent.click(await screen.findByRole('button', { name: '破棄して閉じる' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(puts).toEqual([]);
  });

  it('何も変えていなければ、確認なしにそのまま閉じる', async () => {
    stubServer([PLAIN_ROW]);
    renderScreen();
    const dialog = await openEdit('TZ');

    fireEvent.keyDown(dialog, { key: 'Escape' });

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('変えた値を元に戻したら書きかけと数えず、確認なしに閉じる', async () => {
    stubServer([PLAIN_ROW]);
    renderScreen();
    const dialog = await openEdit('TZ');
    const input = within(dialog).getByLabelText('値');
    fireEvent.change(input, { target: { value: 'Asia/Tokyo' } });
    fireEvent.change(input, { target: { value: 'UTC' } });

    fireEvent.click(within(dialog).getByRole('button', { name: 'やめる' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('保存して反映の警告で開いたままの窓は、保存済みなので確認なしに閉じる', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (request.method === 'PUT')
        return json({
          credentials: [PLAIN_ROW],
          runners: [{ runnerId: 'runner-2', ok: false, error: 'つながらない' }],
        });
      return json({ credentials: [PLAIN_ROW] });
    }) as typeof fetch;
    renderScreen();
    const dialog = await openEdit('TZ');
    fireEvent.change(within(dialog).getByLabelText('値'), { target: { value: 'Asia/Tokyo' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '保存' }));
    await within(dialog).findByText(/反映できていない/);

    fireEvent.keyDown(dialog, { key: 'Escape' });

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
});

describe('環境変数のシークレットの値の欄 — 普段は伏せた1行、「表示する」で複数行（#3352）', () => {
  it('登録の欄は、シークレットなら伏せた1行で始まり、「表示する」で同じ値の複数行の欄になる', async () => {
    stubServer([]);
    renderScreen();
    await screen.findByRole('heading', { name: '一覧' });

    const hidden = screen.getByLabelText('値') as HTMLInputElement;
    expect(hidden.tagName).toBe('INPUT');
    expect(hidden.type).toBe('password');
    fireEvent.change(hidden, { target: { value: 'abc' } });

    fireEvent.click(screen.getByRole('button', { name: '表示する' }));

    const shown = screen.getByLabelText('値') as HTMLTextAreaElement;
    expect(shown.tagName).toBe('TEXTAREA');
    expect(shown.value).toBe('abc');

    fireEvent.click(screen.getByRole('button', { name: '隠す' }));
    expect((screen.getByLabelText('値') as HTMLInputElement).type).toBe('password');
  });

  it('シークレットにしないなら、値の欄は今までどおりの平文の1行で、「表示する」は出ない', async () => {
    stubServer([]);
    renderScreen();
    await screen.findByRole('heading', { name: '一覧' });

    fireEvent.click(screen.getByRole('checkbox'));

    const input = screen.getByLabelText('値') as HTMLInputElement;
    expect(input.tagName).toBe('INPUT');
    expect(input.type).toBe('text');
    expect(screen.queryByRole('button', { name: '表示する' })).toBeNull();
  });

  it('複数行の欄で入れた値は、改行を保ったまま送られる', async () => {
    const { puts } = stubServer([]);
    renderScreen();
    await screen.findByRole('heading', { name: '一覧' });
    fireEvent.change(screen.getByPlaceholderText('TZ'), { target: { value: 'TLS_KEY' } });
    fireEvent.click(screen.getByRole('button', { name: '表示する' }));
    fireEvent.change(screen.getByLabelText('値'), { target: { value: PEM } });

    fireEvent.click(screen.getByRole('button', { name: '置く' }));

    await waitFor(() =>
      expect(puts).toEqual([[{ name: 'TLS_KEY', value: PEM, scope: 'all', secret: true }]]),
    );
  });

  it('伏せた1行の欄へ改行を含む値を貼っても、改行を落とさない', async () => {
    const { puts } = stubServer([]);
    renderScreen();
    await screen.findByRole('heading', { name: '一覧' });
    fireEvent.change(screen.getByPlaceholderText('TZ'), { target: { value: 'TLS_KEY' } });

    fireEvent.paste(screen.getByLabelText('値'), {
      clipboardData: { getData: () => PEM },
    });
    fireEvent.click(screen.getByRole('button', { name: '置く' }));

    await waitFor(() =>
      expect(puts).toEqual([[{ name: 'TLS_KEY', value: PEM, scope: 'all', secret: true }]]),
    );
  });

  it('複数行の値を伏せている間は書き換えさせず、行数と「表示する」で開くことを言う', async () => {
    stubServer([]);
    renderScreen();
    await screen.findByRole('heading', { name: '一覧' });
    fireEvent.click(screen.getByRole('button', { name: '表示する' }));
    fireEvent.change(screen.getByLabelText('値'), { target: { value: PEM } });

    fireEvent.click(screen.getByRole('button', { name: '隠す' }));

    expect((screen.getByLabelText('値') as HTMLInputElement).readOnly).toBe(true);
    expect(screen.getByText('4 行の値。書き換えるには「表示する」で開く。')).toBeTruthy();
  });

  it('シークレットの行の編集の「新しい値」も、伏せた1行で始まり「表示する」で複数行になる', async () => {
    const { puts } = stubServer([SECRET_ROW]);
    renderScreen();
    const dialog = await openEdit('NPM_TOKEN');

    expect((within(dialog).getByLabelText('新しい値') as HTMLInputElement).type).toBe('password');
    fireEvent.click(within(dialog).getByRole('button', { name: '表示する' }));
    const shown = within(dialog).getByLabelText('新しい値') as HTMLTextAreaElement;
    expect(shown.tagName).toBe('TEXTAREA');
    fireEvent.change(shown, { target: { value: PEM } });
    fireEvent.click(within(dialog).getByRole('button', { name: '保存' }));

    await waitFor(() => expect(puts).toEqual([[{ name: 'NPM_TOKEN', value: PEM, scope: 'all' }]]));
  });
});
