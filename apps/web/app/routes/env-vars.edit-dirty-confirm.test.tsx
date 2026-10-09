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

const SECRET_ROW = { ...ROW, name: 'TOKEN', secret: true, value: undefined };

function stubServer(row: typeof ROW | typeof SECRET_ROW) {
  const puts: unknown[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    if (request.method === 'PUT') {
      puts.push(await request.json());
      return json({ credentials: [row], runners: [] });
    }
    return json({ credentials: [row] });
  }) as typeof fetch;
  return { puts };
}

async function openEdit(name: string) {
  render(
    <Providers>
      <TestDataRouter>
        <EnvVars />
      </TestDataRouter>
    </Providers>,
  );
  const trigger = await screen.findByRole('button', { name: `「${name}」の操作` });
  fireEvent.keyDown(trigger, { key: 'Enter' });
  fireEvent.click(await screen.findByRole('menuitem', { name: '編集' }));
  return screen.findByRole('dialog');
}

describe('環境変数の編集の窓 — 書きかけのまま閉じるときは確認する（#3418）', () => {
  it('値を打ちかけて Esc を押すと、確認が出て、窓も打った値も残る', async () => {
    stubServer(ROW);
    const dialog = await openEdit('TZ');
    fireEvent.change(within(dialog).getByLabelText('値'), { target: { value: 'Asia/Tokyo' } });

    fireEvent.keyDown(dialog, { key: 'Escape' });

    const confirm = await screen.findByRole('alertdialog');
    expect(within(confirm).getByText('保存していない変更があります')).not.toBeNull();
    expect(within(confirm).getByRole('button', { name: '戻る' })).not.toBeNull();
    expect((within(dialog).getByLabelText('値') as HTMLInputElement).value).toBe('Asia/Tokyo');
  });

  it('確認で「戻る」を押すと窓へ戻り、値は残る', async () => {
    stubServer(ROW);
    const dialog = await openEdit('TZ');
    fireEvent.change(within(dialog).getByLabelText('値'), { target: { value: 'Asia/Tokyo' } });
    fireEvent.keyDown(dialog, { key: 'Escape' });
    const confirm = await screen.findByRole('alertdialog');

    fireEvent.click(within(confirm).getByRole('button', { name: '戻る' }));

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(screen.queryByRole('dialog')).not.toBeNull();
    expect((within(dialog).getByLabelText('値') as HTMLInputElement).value).toBe('Asia/Tokyo');
  });

  it('確認で「捨てて閉じる」を押すと、窓が閉じ、何も保存されない', async () => {
    const server = stubServer(ROW);
    const dialog = await openEdit('TZ');
    fireEvent.change(within(dialog).getByLabelText('値'), { target: { value: 'Asia/Tokyo' } });
    fireEvent.keyDown(dialog, { key: 'Escape' });
    const confirm = await screen.findByRole('alertdialog');

    fireEvent.click(within(confirm).getByRole('button', { name: '捨てて閉じる' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(server.puts).toHaveLength(0);
  });

  it('渡す先だけを変えかけて「やめる」を押しても、確認が出る', async () => {
    stubServer(ROW);
    const dialog = await openEdit('TZ');
    fireEvent.change(within(dialog).getByLabelText('渡す先'), { target: { value: 'app' } });

    fireEvent.click(within(dialog).getByRole('button', { name: 'やめる' }));

    expect(await screen.findByRole('alertdialog')).not.toBeNull();
    // 確認が前面にある間、窓は支援技術から隠れる
    expect(screen.queryByRole('dialog', { hidden: true })).not.toBeNull();
  });

  it('シークレットの新しい値を打ちかけて閉じるときも、確認が出る', async () => {
    stubServer(SECRET_ROW);
    const dialog = await openEdit('TOKEN');
    fireEvent.change(within(dialog).getByLabelText('新しい値'), { target: { value: 'abc' } });

    fireEvent.keyDown(dialog, { key: 'Escape' });

    expect(await screen.findByRole('alertdialog')).not.toBeNull();
  });

  it('何も変えていなければ、Esc でも「やめる」でも確認なしですぐ閉じる', async () => {
    stubServer(ROW);
    const dialog = await openEdit('TZ');

    fireEvent.keyDown(dialog, { key: 'Escape' });

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('打って元の値へ戻せば、書きかけではなく、確認なしで閉じる', async () => {
    stubServer(ROW);
    const dialog = await openEdit('TZ');
    fireEvent.change(within(dialog).getByLabelText('値'), { target: { value: 'Asia/Tokyo' } });
    fireEvent.change(within(dialog).getByLabelText('値'), { target: { value: 'UTC' } });

    fireEvent.click(within(dialog).getByRole('button', { name: 'やめる' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
});
