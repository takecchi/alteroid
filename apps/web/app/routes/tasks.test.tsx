// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
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

const THREE = () => [
  task({ id: 't-a', title: '先にやる仕事', body: '最初の本文', status: 'queued' }),
  task({ id: 't-b', title: '返事を待っている仕事', body: '二番目の本文', status: 'waiting' }),
  task({ id: 't-c', title: '判断が要る仕事', body: '三番目の本文', status: 'needs_decision' }),
];

function openTitles(): string[] {
  const list = screen.getByRole('list', { name: '開いている task（優先順）' });
  return within(list)
    .getAllByRole('listitem')
    .map((item) => within(item).getAllByRole('link')[0]!.textContent ?? '');
}

describe('/tasks 一覧', () => {
  it('開いている行を優先順（entries の順）に並べ、状態の語を併記する', async () => {
    stubTasksServer(THREE());
    renderTasksAt('/tasks');

    await screen.findByText('先にやる仕事');
    expect(openTitles()).toEqual(['先にやる仕事', '返事を待っている仕事', '判断が要る仕事']);
    expect(screen.getByText('順番待ち（queued）')).toBeTruthy();
    expect(screen.getByText('返事待ち（waiting）')).toBeTruthy();
    expect(screen.getByText('判断待ち（needs_decision）')).toBeTruthy();
  });

  it('閉じた行は押されたときだけ includeClosed=true で取りに行き、状態と理由を出す', async () => {
    const server = stubTasksServer([
      ...THREE(),
      task({
        id: 't-done',
        title: '終わった仕事',
        status: 'done',
        closedAt: '2026-09-02T00:00:00.000Z',
        closedReason: 'PR #99 をマージした',
        closedBy: 'human',
      }),
      task({
        id: 't-cancel',
        title: '取りやめた仕事',
        status: 'cancelled',
        closedAt: '2026-09-02T00:00:00.000Z',
        closedReason: '要らなくなった',
      }),
    ]);
    renderTasksAt('/tasks');

    await screen.findByText('先にやる仕事');
    expect(screen.queryByText('終わった仕事')).toBeNull();
    expect(server.gets.length).toBeGreaterThan(0);
    expect(server.gets.some((url) => url.includes('includeClosed=true'))).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: '閉じたものも見る' }));

    expect(await screen.findByText('終わった仕事')).toBeTruthy();
    expect(server.gets.some((url) => url.includes('includeClosed=true'))).toBe(true);
    expect(screen.getByText(/PR #99 をマージした/)).toBeTruthy();
    expect(screen.getByText('完了（done）')).toBeTruthy();
    expect(screen.getByText('取りやめ（cancelled）')).toBeTruthy();
    expect(screen.getByText(/要らなくなった/)).toBeTruthy();
    // 開いている側の並びは変わらない
    expect(openTitles()).toEqual(['先にやる仕事', '返事を待っている仕事', '判断が要る仕事']);
  });

  it('読めない行があれば、閉じたのではないと断る', async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          entries: [],
          unreadable: [{ id: 'broken-1', reason: '壊れている' }],
        }),
        { headers: { 'content-type': 'application/json' } },
      )) as typeof fetch;
    renderTasksAt('/tasks');

    expect(await screen.findByText(/読めない行が 1 件ある/)).toBeTruthy();
    expect(screen.getByText(/broken-1/)).toBeTruthy();
    expect(screen.getByText('閉じたのではない。')).toBeTruthy();
    expect(screen.getByText('読めた範囲では、開いている task はない。')).toBeTruthy();
  });

  it('各行のタイトルから詳細へ移り、全文と優先順の位置が見える', async () => {
    stubTasksServer([
      task({ id: 't-a', title: '先にやる仕事', body: '最初の本文' }),
      task({ id: 't-b', title: '長い仕事', body: `${'あ'.repeat(300)}\n末尾の一文` }),
    ]);
    const router = renderTasksAt('/tasks');

    fireEvent.click(await screen.findByRole('link', { name: '長い仕事' }));

    await waitFor(() => expect(router.state.location.pathname).toBe('/tasks/t-b'));
    expect(await screen.findByText(/末尾の一文/)).toBeTruthy();
    expect(screen.getByText('優先順 2 / 2')).toBeTruthy();
  });
});

describe('task を積む', () => {
  it('置き場所を省くと placement を送らず、積んだ行が一覧に出る', async () => {
    const server = stubTasksServer(THREE());
    renderTasksAt('/tasks');
    await screen.findByText('先にやる仕事');

    fireEvent.change(screen.getByLabelText(/^タイトル/), { target: { value: '新しい仕事' } });
    fireEvent.change(screen.getByLabelText('本文'), { target: { value: '新しい本文' } });
    fireEvent.click(screen.getByRole('button', { name: '積む' }));

    expect(await screen.findByText('新しい仕事')).toBeTruthy();
    expect(server.writes()).toEqual([
      { method: 'POST', path: '/tasks', body: { title: '新しい仕事', body: '新しい本文' } },
    ]);
  });

  it('先頭を選ぶと front で積み、先頭に並ぶ', async () => {
    const server = stubTasksServer(THREE());
    renderTasksAt('/tasks');
    await screen.findByText('先にやる仕事');

    fireEvent.change(screen.getByLabelText(/^タイトル/), { target: { value: '割り込み' } });
    fireEvent.change(screen.getByLabelText('本文'), { target: { value: '急ぎ' } });
    fireEvent.change(screen.getByLabelText('置き場所'), { target: { value: 'front' } });
    fireEvent.click(screen.getByRole('button', { name: '積む' }));

    await waitFor(() => expect(openTitles()[0]).toBe('割り込み'));
    expect(server.writes()[0]?.body).toEqual({
      title: '割り込み',
      body: '急ぎ',
      placement: { kind: 'front' },
    });
  });

  it('ある行の後ろは、基準の行を選ぶまで積めず、選ぶと anchorId を送る', async () => {
    const server = stubTasksServer(THREE());
    renderTasksAt('/tasks');
    await screen.findByText('先にやる仕事');

    fireEvent.change(screen.getByLabelText(/^タイトル/), { target: { value: '二番目に' } });
    fireEvent.change(screen.getByLabelText('本文'), { target: { value: '本文' } });
    fireEvent.change(screen.getByLabelText('置き場所'), { target: { value: 'after' } });
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '積む' }).disabled).toBe(true);

    fireEvent.change(screen.getByLabelText('置き場所の基準の行'), { target: { value: 't-a' } });
    fireEvent.click(screen.getByRole('button', { name: '積む' }));

    await waitFor(() =>
      expect(openTitles()).toEqual([
        '先にやる仕事',
        '二番目に',
        '返事を待っている仕事',
        '判断が要る仕事',
      ]),
    );
    expect(server.writes()[0]?.body).toMatchObject({
      placement: { kind: 'after', anchorId: 't-a' },
    });
  });

  it('タイトルか本文が空のあいだは積めない', async () => {
    stubTasksServer(THREE());
    renderTasksAt('/tasks');
    await screen.findByText('先にやる仕事');

    const submit = screen.getByRole<HTMLButtonElement>('button', { name: '積む' });
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/^タイトル/), { target: { value: 'だけ' } });
    expect(submit.disabled).toBe(true);
  });
});

describe('task を閉じる', () => {
  it('理由が空のあいだは閉じられず、理由と閉じ方を送って開いている一覧から外れる', async () => {
    const server = stubTasksServer(THREE());
    renderTasksAt('/tasks');
    await screen.findByText('返事を待っている仕事');

    fireEvent.click(screen.getByRole('button', { name: '「返事を待っている仕事」を閉じる' }));
    const confirm = screen.getByRole<HTMLButtonElement>('button', {
      name: '「返事を待っている仕事」の閉じるを確定',
    });
    expect(confirm.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText('「返事を待っている仕事」の閉じ方'), {
      target: { value: 'cancelled' },
    });
    fireEvent.change(screen.getByLabelText('「返事を待っている仕事」を閉じる理由'), {
      target: { value: '相手から要らないと言われた' },
    });
    fireEvent.click(confirm);

    await waitFor(() => expect(screen.queryByText('返事を待っている仕事')).toBeNull());
    expect(server.writes()).toEqual([
      {
        method: 'POST',
        path: '/tasks/t-b/close',
        body: { status: 'cancelled', reason: '相手から要らないと言われた' },
      },
    ]);
    expect(openTitles()).toEqual(['先にやる仕事', '判断が要る仕事']);
  });

  it('既に閉じていたなどの 409 は、サーバの理由をそのまま見せる', async () => {
    const server = stubTasksServer(THREE());
    renderTasksAt('/tasks');
    await screen.findByText('先にやる仕事');

    server.refuseNext(409, { error: 't-a は既に閉じている（done）。何もしていない' });
    fireEvent.click(screen.getByRole('button', { name: '「先にやる仕事」を閉じる' }));
    fireEvent.change(screen.getByLabelText('「先にやる仕事」を閉じる理由'), {
      target: { value: '終わった' },
    });
    fireEvent.click(screen.getByRole('button', { name: '「先にやる仕事」の閉じるを確定' }));

    expect(await screen.findByText(/既に閉じている（done）/)).toBeTruthy();
  });
});

describe('task を開き直す', () => {
  it('理由を送って、閉じた行が開いている一覧の最後へ戻る', async () => {
    const server = stubTasksServer([
      ...THREE(),
      task({
        id: 't-done',
        title: '終わった仕事',
        status: 'done',
        closedAt: '2026-09-02T00:00:00.000Z',
        closedReason: '終わったと思った',
        closedBy: 'human',
      }),
    ]);
    renderTasksAt('/tasks?closed=1');
    await screen.findByText('終わった仕事');

    fireEvent.click(screen.getByRole('button', { name: '「終わった仕事」を開き直す' }));
    const confirm = screen.getByRole<HTMLButtonElement>('button', {
      name: '「終わった仕事」の開き直しを確定',
    });
    expect(confirm.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('「終わった仕事」を開き直す理由'), {
      target: { value: 'まだ終わっていなかった' },
    });
    fireEvent.click(confirm);

    await waitFor(() =>
      expect(openTitles()).toEqual([
        '先にやる仕事',
        '返事を待っている仕事',
        '判断が要る仕事',
        '終わった仕事',
      ]),
    );
    expect(server.writes()).toEqual([
      {
        method: 'POST',
        path: '/tasks/t-done/reopen',
        body: { reason: 'まだ終わっていなかった' },
      },
    ]);
  });
});

describe('task を並べ替える', () => {
  it('末尾へ・先頭へ・ある行の前へ、それぞれ placement を送って並びが変わる', async () => {
    const server = stubTasksServer(THREE());
    renderTasksAt('/tasks');
    await screen.findByText('先にやる仕事');

    fireEvent.click(screen.getByRole('button', { name: '「先にやる仕事」を末尾へ' }));
    await waitFor(() =>
      expect(openTitles()).toEqual(['返事を待っている仕事', '判断が要る仕事', '先にやる仕事']),
    );

    fireEvent.click(screen.getByRole('button', { name: '「判断が要る仕事」を先頭へ' }));
    await waitFor(() =>
      expect(openTitles()).toEqual(['判断が要る仕事', '返事を待っている仕事', '先にやる仕事']),
    );

    fireEvent.change(screen.getByLabelText('「先にやる仕事」を動かす基準の行'), {
      target: { value: 't-b' },
    });
    fireEvent.click(screen.getByRole('button', { name: '「先にやる仕事」を選んだ行の前へ動かす' }));
    await waitFor(() =>
      expect(openTitles()).toEqual(['判断が要る仕事', '先にやる仕事', '返事を待っている仕事']),
    );

    expect(server.writes()).toEqual([
      { method: 'POST', path: '/tasks/t-a/move', body: { placement: { kind: 'back' } } },
      { method: 'POST', path: '/tasks/t-c/move', body: { placement: { kind: 'front' } } },
      {
        method: 'POST',
        path: '/tasks/t-a/move',
        body: { placement: { kind: 'before', anchorId: 't-b' } },
      },
    ]);
  });

  it('後ろへを選ぶと after を送る。基準の行を選ぶまでは動かせない', async () => {
    const server = stubTasksServer(THREE());
    renderTasksAt('/tasks');
    await screen.findByText('先にやる仕事');

    const move = screen.getByRole<HTMLButtonElement>('button', {
      name: /「先にやる仕事」を選んだ行の.*動かす/,
    });
    expect(move.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('「先にやる仕事」を動かす向き'), {
      target: { value: 'after' },
    });
    fireEvent.change(screen.getByLabelText('「先にやる仕事」を動かす基準の行'), {
      target: { value: 't-b' },
    });
    fireEvent.click(
      screen.getByRole('button', { name: '「先にやる仕事」を選んだ行の後ろへ動かす' }),
    );

    await waitFor(() =>
      expect(openTitles()).toEqual(['返事を待っている仕事', '先にやる仕事', '判断が要る仕事']),
    );
    expect(server.writes()[0]?.body).toEqual({
      placement: { kind: 'after', anchorId: 't-b' },
    });
  });

  it('基準の行の候補に、動かす行自身は入らない', async () => {
    stubTasksServer(THREE());
    renderTasksAt('/tasks');
    await screen.findByText('先にやる仕事');

    const select = screen.getByLabelText('「先にやる仕事」を動かす基準の行');
    const options = within(select)
      .getAllByRole('option')
      .map((o) => o.textContent);
    expect(options).toEqual(['基準の行を選ぶ', '2. 返事を待っている仕事', '3. 判断が要る仕事']);
  });
});
