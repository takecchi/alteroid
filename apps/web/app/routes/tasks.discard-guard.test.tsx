// @vitest-environment jsdom
/**
 * task の編集欄をやめるときの確認と、画面を離れるときの見張りは、同じ「書きかけ」を見る。
 * 確認が出る条件（変えた分だけ・元へ戻せば出ない）と、閉じたあとに見張りが外れることを縛る。
 */
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { storeTestBaseUrl } from '~/test-support';

import { renderTasksAt, stubTasksServer, task } from './tasks-test-helpers';

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

async function openEditor() {
  stubTasksServer([task({ id: 't-1', title: 'もとのタイトル', body: 'もとの本文' })]);
  const router = renderTasksAt('/tasks/t-1');
  await screen.findByText('もとの本文');
  fireEvent.click(screen.getByRole('button', { name: 'タイトルと本文を編集' }));
  const title = (await screen.findByLabelText('タイトル')) as HTMLInputElement;
  return { router, title };
}

const cancel = () => screen.getByRole('button', { name: 'やめる' });

describe('仕事の編集をやめる確認', () => {
  it('書きかけが無ければ確認なしで閉じる', async () => {
    await openEditor();

    fireEvent.click(cancel());

    await waitFor(() => expect(screen.queryByLabelText('タイトル')).toBeNull());
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('書きかけがあれば確認を挟み、「破棄して閉じる」で閉じて下書きを捨てる', async () => {
    const { title } = await openEditor();
    fireEvent.change(title, { target: { value: '直したタイトル' } });

    fireEvent.click(cancel());
    expect(await screen.findByText('編集をやめると、書きかけの内容は失われます。')).toBeTruthy();
    expect(screen.getByLabelText('タイトル')).toBe(title);

    fireEvent.click(screen.getByRole('button', { name: '破棄して閉じる' }));
    await waitFor(() => expect(screen.queryByLabelText('タイトル')).toBeNull());

    fireEvent.click(screen.getByRole('button', { name: 'タイトルと本文を編集' }));
    const reopened = (await screen.findByLabelText('タイトル')) as HTMLInputElement;
    expect(reopened.value).toBe('もとのタイトル');
    fireEvent.click(cancel());
    await waitFor(() => expect(screen.queryByLabelText('タイトル')).toBeNull());
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('元の値へ戻せば書きかけではなく、確認なしで閉じる', async () => {
    const { title } = await openEditor();
    fireEvent.change(title, { target: { value: '直したタイトル' } });
    fireEvent.change(title, { target: { value: 'もとのタイトル' } });

    fireEvent.click(cancel());

    await waitFor(() => expect(screen.queryByLabelText('タイトル')).toBeNull());
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
});

describe('task の編集と、画面を離れる見張り', () => {
  it('書きかけのあいだは離れる確認が出て、破棄して閉じたあとは出ない', async () => {
    const { router, title } = await openEditor();
    fireEvent.change(title, { target: { value: '直したタイトル' } });

    await router.navigate('/tasks');
    expect(await screen.findByRole('button', { name: '破棄して離れる' })).toBeTruthy();
    expect(router.state.location.pathname).toBe('/tasks/t-1');
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: '破棄して離れる' })).toBeNull(),
    );

    fireEvent.click(cancel());
    fireEvent.click(await screen.findByRole('button', { name: '破棄して閉じる' }));
    await waitFor(() => expect(screen.queryByLabelText('タイトル')).toBeNull());

    await router.navigate('/tasks');
    await waitFor(() => expect(router.state.location.pathname).toBe('/tasks'));
    expect(screen.queryByRole('button', { name: '破棄して離れる' })).toBeNull();
  });
});
