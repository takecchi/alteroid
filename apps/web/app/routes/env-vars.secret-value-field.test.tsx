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

const PEM =
  '-----BEGIN PRIVATE KEY-----\nMIIBVQIBADANBgkq\nhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----';

const SECRET_ROW = {
  name: 'TOKEN',
  sha256: 'a'.repeat(12),
  updatedAt: '2026-09-14T00:00:00.000Z',
  scope: 'all',
  secret: true,
};
const PLAIN_ROW = { ...SECRET_ROW, name: 'TZ', secret: false, value: 'UTC' };

function stubServer(rows: object[]) {
  const puts: { name: string; value: string; secret?: boolean }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    if (request.method === 'PUT') {
      const body = (await request.json()) as { credentials: (typeof puts)[number][] };
      puts.push(...body.credentials);
      return json({ credentials: rows, runners: [] });
    }
    return json({ credentials: rows });
  }) as typeof fetch;
  return { puts };
}

async function renderScreen() {
  render(
    <Providers>
      <TestDataRouter>
        <EnvVars />
      </TestDataRouter>
    </Providers>,
  );
  await screen.findByRole('heading', { name: '一覧' });
}

async function openEdit(name: string) {
  const trigger = await screen.findByRole('button', { name: `「${name}」の操作` });
  fireEvent.keyDown(trigger, { key: 'Enter' });
  fireEvent.click(await screen.findByRole('menuitem', { name: '編集' }));
  return screen.findByRole('dialog');
}

function fieldOf(scope: HTMLElement, label: string): HTMLInputElement | HTMLTextAreaElement {
  return within(scope).getByLabelText(label);
}

describe('環境変数の登録 — 秘密の値の欄（#3352）', () => {
  it('既定（シークレット）では伏せた1行で、「表示する」を押すまで複数行の欄ではない', async () => {
    stubServer([]);
    await renderScreen();

    const field = fieldOf(document.body, '値') as HTMLInputElement;

    expect(field.tagName).toBe('INPUT');
    expect(field.type).toBe('password');
    expect(screen.queryByRole('button', { name: '表示する' })).not.toBeNull();
  });

  it('「表示する」で複数行の欄になり、改行を含む値を打てて、そのまま送られる', async () => {
    const server = stubServer([]);
    await renderScreen();
    fireEvent.change(screen.getByPlaceholderText('TZ'), { target: { value: 'tls_key' } });

    fireEvent.click(screen.getByRole('button', { name: '表示する' }));
    const field = fieldOf(document.body, '値');
    expect(field.tagName).toBe('TEXTAREA');
    fireEvent.change(field, { target: { value: PEM } });
    expect((fieldOf(document.body, '値') as HTMLTextAreaElement).value).toBe(PEM);
    fireEvent.click(screen.getByRole('button', { name: '置く' }));

    await waitFor(() => expect(server.puts).toHaveLength(1));
    expect(server.puts[0]).toMatchObject({ name: 'TLS_KEY', value: PEM, secret: true });
  });

  it('「隠す」で伏せた1行へ戻り、複数行の値は壊れずに残って、そのまま送られる', async () => {
    const server = stubServer([]);
    await renderScreen();
    fireEvent.change(screen.getByPlaceholderText('TZ'), { target: { value: 'tls_key' } });
    fireEvent.click(screen.getByRole('button', { name: '表示する' }));
    fireEvent.change(fieldOf(document.body, '値'), { target: { value: PEM } });

    fireEvent.click(screen.getByRole('button', { name: '隠す' }));

    const masked = fieldOf(document.body, '値') as HTMLInputElement;
    expect(masked.type).toBe('password');
    // 伏せた欄で打ち足しても、改行を落とした値で状態を上書かない
    expect(masked.readOnly).toBe(true);
    fireEvent.change(masked, { target: { value: PEM.replace(/\n/g, '') + 'x' } });
    fireEvent.click(screen.getByRole('button', { name: '置く' }));

    await waitFor(() => expect(server.puts).toHaveLength(1));
    expect(server.puts[0]?.value).toBe(PEM);
  });

  it('伏せた欄へ複数行を貼り付けても、改行ごと取り込まれる', async () => {
    const server = stubServer([]);
    await renderScreen();
    fireEvent.change(screen.getByPlaceholderText('TZ'), { target: { value: 'tls_key' } });

    fireEvent.paste(fieldOf(document.body, '値'), {
      clipboardData: { getData: () => PEM },
    });
    fireEvent.click(screen.getByRole('button', { name: '置く' }));

    await waitFor(() => expect(server.puts).toHaveLength(1));
    expect(server.puts[0]?.value).toBe(PEM);
  });

  it('シークレット扱いを外すと、値の欄は今までどおりの1行で、「表示する」も無い', async () => {
    stubServer([]);
    await renderScreen();

    fireEvent.click(screen.getByRole('checkbox'));

    const field = fieldOf(document.body, '値') as HTMLInputElement;
    expect(field.tagName).toBe('INPUT');
    expect(field.type).toBe('text');
    expect(screen.queryByRole('button', { name: '表示する' })).toBeNull();
  });
});

describe('環境変数の編集の窓 — 秘密の値の欄（#3352）', () => {
  it('シークレットの「新しい値」は伏せた1行で、「表示する」で複数行を打て、そのまま送られる', async () => {
    const server = stubServer([SECRET_ROW]);
    await renderScreen();
    const dialog = await openEdit('TOKEN');

    expect((fieldOf(dialog, '新しい値') as HTMLInputElement).type).toBe('password');
    fireEvent.click(within(dialog).getByRole('button', { name: '表示する' }));
    const field = fieldOf(dialog, '新しい値');
    expect(field.tagName).toBe('TEXTAREA');
    fireEvent.change(field, { target: { value: PEM } });
    fireEvent.click(within(dialog).getByRole('button', { name: '保存' }));

    await waitFor(() => expect(server.puts).toHaveLength(1));
    expect(server.puts[0]).toMatchObject({ name: 'TOKEN', value: PEM });
  });

  it('シークレットでない値の欄は今までどおりの1行で、「表示する」も無い', async () => {
    stubServer([PLAIN_ROW]);
    await renderScreen();
    const dialog = await openEdit('TZ');

    const field = fieldOf(dialog, '値') as HTMLInputElement;
    expect(field.tagName).toBe('INPUT');
    expect(field.type).toBe('text');
    expect(field.value).toBe('UTC');
    expect(within(dialog).queryByRole('button', { name: '表示する' })).toBeNull();
  });
});
