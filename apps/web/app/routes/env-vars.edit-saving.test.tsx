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

const ROW = {
  name: 'TZ',
  sha256: 'b'.repeat(12),
  updatedAt: '2026-09-14T00:00:00.000Z',
  scope: 'all',
  secret: false,
  value: 'UTC',
};

// PUT の応答を手で解決する: 実時間の待ちを使わずに「保存中」の状態を作るため
function stubServer() {
  const puts: unknown[] = [];
  const pending: (() => void)[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    if (!request.url.includes('/credentials'))
      throw new TypeError(`Failed to fetch: ${request.url}`);
    if (request.method === 'PUT') {
      puts.push(await request.json());
      return new Promise<Response>((resolve) => {
        pending.push(() => resolve(json({ credentials: [ROW], runners: [] })));
      });
    }
    return json({ credentials: [ROW] });
  }) as typeof fetch;
  return {
    puts,
    releaseNextPut: () => {
      const release = pending.shift();
      if (release === undefined) throw new Error('待っている PUT が無い');
      release();
    },
  };
}

async function startSavingEdit(server: ReturnType<typeof stubServer>) {
  render(
    <Providers>
      <TestDataRouter>
        <EnvVars />
      </TestDataRouter>
    </Providers>,
  );
  const trigger = await screen.findByRole('button', { name: '「TZ」の操作' });
  fireEvent.keyDown(trigger, { key: 'Enter' });
  fireEvent.click(await screen.findByRole('menuitem', { name: '編集' }));
  const dialog = await screen.findByRole('dialog');
  fireEvent.change(within(dialog).getByLabelText('値'), { target: { value: 'Asia/Tokyo' } });
  fireEvent.click(within(dialog).getByRole('button', { name: '保存' }));
  await waitFor(() => expect(server.puts).toHaveLength(1));
  return dialog;
}

describe('環境変数の編集の窓 — 保存中は閉じさせない（#3418）', () => {
  it('保存の応答が返る前の Esc では閉じず、打った値も残る', async () => {
    const server = stubServer();
    const dialog = await startSavingEdit(server);

    fireEvent.keyDown(dialog, { key: 'Escape' });

    expect(screen.queryByRole('dialog')).not.toBeNull();
    expect((within(dialog).getByLabelText('値') as HTMLInputElement).value).toBe('Asia/Tokyo');
  });

  it('保存中は「やめる」も押せず、押しても閉じない', async () => {
    const server = stubServer();
    const dialog = await startSavingEdit(server);

    const cancel = within(dialog).getByRole('button', { name: 'やめる' }) as HTMLButtonElement;
    expect(cancel.disabled).toBe(true);
    fireEvent.click(cancel);

    expect(screen.queryByRole('dialog')).not.toBeNull();
  });

  it('保存の応答が返れば、窓は閉じる', async () => {
    const server = stubServer();
    await startSavingEdit(server);

    server.releaseNextPut();

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('保存が失敗して応答が返れば、窓は開いたまま失敗を見せ、そのあとは Esc で閉じられる', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (request.method === 'PUT') return json({ error: 'こわれた' }, 500);
      return json({ credentials: [ROW] });
    }) as typeof fetch;
    render(
      <Providers>
        <TestDataRouter>
          <EnvVars />
        </TestDataRouter>
      </Providers>,
    );
    const trigger = await screen.findByRole('button', { name: '「TZ」の操作' });
    fireEvent.keyDown(trigger, { key: 'Enter' });
    fireEvent.click(await screen.findByRole('menuitem', { name: '編集' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: '保存' }));
    await within(dialog).findByRole('alert');

    fireEvent.keyDown(dialog, { key: 'Escape' });

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});
