// @vitest-environment jsdom
/**
 * task の編集（title / 本文）は、開いた時点の版（`editedAt ?? createdAt`）を `ifMatch` で送る。
 * 開いたあとに裏で変わっていたら 409 で断られ、下書きを残したまま選ばせる（上書きしない）。
 */
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { storeTestBaseUrl } from '~/test-support';

import { CREATED, renderTasksAt, stubTasksServer, task } from './tasks-test-helpers';

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

const BEHIND_AT = '2026-09-03T00:00:00.000Z';
const SELF_AT = '2026-09-04T00:00:00.000Z';

async function openEditor(path = '/tasks/t-1') {
  renderTasksAt(path);
  await screen.findByText('もとの本文');
  fireEvent.click(screen.getByRole('button', { name: 'title / 本文を編集' }));
  return {
    title: (await screen.findByLabelText('title')) as HTMLInputElement,
    body: screen.getByLabelText('本文') as HTMLTextAreaElement,
  };
}

const row = () => task({ id: 't-1', title: 'もとのタイトル', body: 'もとの本文' });

describe('task の編集と版の照合', () => {
  it('開いた時点の版（editedAt が無ければ createdAt）を ifMatch で送り、変えた欄だけを送る', async () => {
    const server = stubTasksServer([row()]);
    const { body } = await openEditor();

    fireEvent.change(body, { target: { value: '直した本文' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => expect(server.writes()).toHaveLength(1));
    expect(server.writes()[0]).toEqual({
      method: 'PATCH',
      path: '/tasks/t-1',
      body: { body: '直した本文', ifMatch: CREATED },
    });
    expect(await screen.findByText('直した本文')).toBeTruthy();
  });

  it('title だけを直すと title だけを送る', async () => {
    const server = stubTasksServer([row()]);
    const { title } = await openEditor();

    fireEvent.change(title, { target: { value: '直したタイトル' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => expect(server.writes()).toHaveLength(1));
    expect(server.writes()[0]?.body).toEqual({ title: '直したタイトル', ifMatch: CREATED });
  });

  it('開いたあとに裏で変わっていたら、書かずに断り、下書きと裏の内容を並べて見せる', async () => {
    const server = stubTasksServer([row()]);
    const { body } = await openEditor();
    server.changeBehind('t-1', { body: '裏で書き換えられた本文' });

    fireEvent.change(body, { target: { value: '自分の下書き' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    expect(await screen.findByText(/開いたあとに、裏でこの task が変わった/)).toBeTruthy();
    const alert = screen.getByRole('alert');
    expect(within(alert).getByText('裏で書き換えられた本文')).toBeTruthy();
    // 上書きしていない・下書きは残っている
    expect(server.rows()[0]?.body).toBe('裏で書き換えられた本文');
    expect(body.value).toBe('自分の下書き');
    expect(server.writes()).toHaveLength(1);
    expect(
      screen.getByRole('button', { name: 'いまの内容の上で、下書きを保存し直す' }),
    ).toBeTruthy();
  });

  it('「保存し直す」は、裏の版を前提にして下書きを送る', async () => {
    const server = stubTasksServer([row()]);
    const { body } = await openEditor();
    server.changeBehind('t-1', { body: '裏の本文' });
    fireEvent.change(body, { target: { value: '自分の下書き' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    fireEvent.click(
      await screen.findByRole('button', { name: 'いまの内容の上で、下書きを保存し直す' }),
    );

    await waitFor(() => expect(server.writes()).toHaveLength(2));
    expect(server.writes()[1]?.body).toEqual({ body: '自分の下書き', ifMatch: BEHIND_AT });
    await waitFor(() => expect(server.rows()[0]?.body).toBe('自分の下書き'));
    expect(server.rows()[0]?.editedAt).toBe(SELF_AT);
  });

  it('「下書きを捨てる」は何も書かず、いまの内容に戻る', async () => {
    const server = stubTasksServer([row()]);
    const { body } = await openEditor();
    server.changeBehind('t-1', { body: '裏の本文' });
    fireEvent.change(body, { target: { value: '自分の下書き' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    fireEvent.click(
      await screen.findByRole('button', { name: '下書きを捨てて、いまの内容にする' }),
    );

    await waitFor(() => expect(body.value).toBe('裏の本文'));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(server.writes()).toHaveLength(1);
  });

  it('閉じ済みの 409（current の鍵が無い）は版の衝突と見なさず、サーバの理由を失敗として出す', async () => {
    const server = stubTasksServer([row()]);
    const { body } = await openEditor();
    server.refuseNext(409, { error: 't-1 は既に閉じている（done）。直せない' });

    fireEvent.change(body, { target: { value: '自分の下書き' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    expect(await screen.findByText(/既に閉じている（done）。直せない/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /保存し直す/ })).toBeNull();
    expect(body.value).toBe('自分の下書き');
  });

  it('human 起点でない行の編集は 403 で断られ、その理由をそのまま見せる（画面で先回りして隠さない）', async () => {
    const server = stubTasksServer([
      task({ id: 't-1', title: 'クローンの task', body: 'もとの本文', origin: 'self' }),
    ]);
    const { body } = await openEditor();
    server.refuseNext(403, {
      error: "t-1 は origin:'self' で、クローンやマネージャーなどが立てた行は人間からは直せない",
    });

    fireEvent.change(body, { target: { value: '直したい' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    expect(await screen.findByText(/人間からは直せない/)).toBeTruthy();
    expect(body.value).toBe('直したい');
  });
});
