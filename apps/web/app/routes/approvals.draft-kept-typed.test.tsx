// @vitest-environment jsdom
/**
 * 答えを送って応答を待つ間に打ち足した文は、成功しても消えない（issue #3515）。
 *
 * 成功したとき畳むのは「送った時点の下書きと同じ項目」だけ。違うときは残し、承認が未回答の一覧から
 * 消えたあとも「送らなかった下書きが残っている」として見せる（写す・閉じる）。
 * 応答の時期は、回答の Promise を手で解決して操る（実時間の待ちは書かない）。
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadApprovalDrafts, saveApprovalDrafts, type PendingApproval } from '@alteroid/logic';
import { json, Providers, storeTestBaseUrl } from '~/test-support';

import Approvals from './approvals';

function approval(over: Partial<PendingApproval> = {}): PendingApproval {
  return {
    id: 'a-1',
    createdAt: '2026-08-19T10:00:00.000Z',
    updatedAt: '2026-08-19T10:00:00.000Z',
    question: '本番に出してよいか',
    ...over,
  };
}

const free = approval({ id: 'a-free', question: '自由記述の件' });
const asked = approval({
  id: 'a-ask',
  question: '設問の件',
  questions: [
    {
      id: 'deploy',
      prompt: 'デプロイ先',
      options: [
        { id: 'railway', label: 'Railway' },
        { id: 'fly', label: 'Fly.io' },
      ],
    },
  ],
});

interface Gate {
  resolve: () => void;
}

/**
 * 回答（`POST /approvals/:id/answer`・`POST /approvals/answer`）は `gate.resolve()` を呼ぶまで返さない。
 * 一覧は、回答が返ったあとは `afterAnswer` を返す（一覧の再取得で、答えた承認が消える）。
 */
function stub(listBefore: PendingApproval[], afterAnswer: PendingApproval[]): Gate {
  let answered = false;
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    if (
      url.pathname === '/approvals' &&
      (input instanceof Request ? input.method : 'GET') === 'GET'
    ) {
      return json({ approvals: answered ? afterAnswer : listBefore });
    }
    if (/^\/approvals\/[^/]+\/answer$/.test(url.pathname)) {
      await held;
      answered = true;
      return json({ ok: true });
    }
    if (url.pathname === '/approvals/answer') {
      await held;
      answered = true;
      const body =
        input instanceof Request
          ? ((await input.clone().json()) as { answers: { id: string }[] })
          : { answers: [] };
      return json({ results: body.answers.map((a) => ({ id: a.id, ok: true })) });
    }
    return Promise.reject(new TypeError(`Failed to fetch: ${url.href}`));
  }) as typeof fetch;
  return { resolve: release };
}

function renderPage() {
  const router = createMemoryRouter([{ path: '/approvals', Component: Approvals }], {
    initialEntries: ['/approvals'],
  });
  render(
    <Providers>
      <RouterProvider router={router} />
    </Providers>,
  );
}

let originalFetch: typeof fetch;
beforeEach(() => {
  originalFetch = globalThis.fetch;
  localStorage.clear();
  sessionStorage.clear();
  storeTestBaseUrl();
});
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

const LEFT = '送らなかった下書きが残っている承認';

describe('応答を待つ間に打ち足した文（issue #3515）', () => {
  it('個別送信: 打ち足さなければ、通ったあとに下書きも残りの案内も無い', async () => {
    const gate = stub([free], []);
    renderPage();
    fireEvent.change(await screen.findByPlaceholderText(/答える/), { target: { value: '答え' } });
    fireEvent.click(screen.getByRole('button', { name: '回答する' }));
    gate.resolve();

    await waitFor(() => expect(screen.queryByPlaceholderText(/答える/)).toBeNull());
    expect(screen.queryByRole('list', { name: LEFT })).toBeNull();
    await waitFor(() => expect(loadApprovalDrafts()).toEqual({ texts: {}, questions: {} }));
  });

  it('個別送信: 応答を待つ間に打ち足した文は残り、決着したあとも見えて、写す・閉じるができる', async () => {
    const gate = stub([free], []);
    renderPage();
    const box = (await screen.findByPlaceholderText(/答える/)) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: '答え' } });
    fireEvent.click(screen.getByRole('button', { name: '回答する' }));
    // 応答はまだ返っていない。待つ間に打ち足す。
    fireEvent.change(box, { target: { value: '答え。追記です' } });
    gate.resolve();

    const left = await screen.findByRole('list', { name: LEFT });
    expect(within(left).getByText(/対象: 自由記述の件/)).toBeTruthy();
    expect(within(left).getByText('答え。追記です')).toBeTruthy();
    expect(within(left).getByRole('button', { name: /写す|写した|写せなかった/ })).toBeTruthy();
    // 承認が一覧から消えても、下書きは保存先に残る。
    expect(loadApprovalDrafts().texts).toEqual({ 'a-free': '答え。追記です' });

    fireEvent.click(within(left).getByRole('button', { name: '閉じる（捨てる）' }));
    await waitFor(() => expect(screen.queryByRole('list', { name: LEFT })).toBeNull());
    await waitFor(() => expect(loadApprovalDrafts()).toEqual({ texts: {}, questions: {} }));
  });

  it('個別送信: 応答の前に消した文字も、控えと違えば「いまの下書き」を残す（空なら残さない）', async () => {
    const gate = stub([free], []);
    renderPage();
    const box = (await screen.findByPlaceholderText(/答える/)) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: '答え' } });
    fireEvent.click(screen.getByRole('button', { name: '回答する' }));
    fireEvent.change(box, { target: { value: '' } });
    gate.resolve();

    await waitFor(() => expect(screen.queryByPlaceholderText(/答える/)).toBeNull());
    expect(screen.queryByRole('list', { name: LEFT })).toBeNull();
    expect(loadApprovalDrafts()).toEqual({ texts: {}, questions: {} });
  });

  it('設問のフォーム: 待つ間に「その他」へ打ち足した分が残り、選択肢の名前つきで見える', async () => {
    const gate = stub([asked], []);
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: '選択肢を開いて答える' }));
    fireEvent.click(screen.getByRole('radio', { name: /Fly\.io/ }));
    fireEvent.click(screen.getByRole('button', { name: '回答' }));
    // 待つ間に補足を打ち足す。
    fireEvent.change(screen.getByLabelText(/補足/), { target: { value: '補足を足した' } });
    gate.resolve();

    const left = await screen.findByRole('list', { name: LEFT });
    expect(within(left).getByText(/デプロイ先/)).toBeTruthy();
    expect(within(left).getByText(/選んだ: Fly\.io/)).toBeTruthy();
    expect(within(left).getByText(/補足: 補足を足した/)).toBeTruthy();
  });

  it('まとめ送信: 待つ間に打ち足した文は残り、打ち足さなかった件は畳まれる', async () => {
    const second = approval({ id: 'a-two', question: '二件目' });
    const gate = stub([free, second], []);
    renderPage();
    const boxes = await screen.findAllByPlaceholderText(/答える/);
    fireEvent.change(boxes[0]!, { target: { value: '一件目の答え' } });
    fireEvent.change(boxes[1]!, { target: { value: '二件目の答え' } });
    fireEvent.click(await screen.findByRole('button', { name: 'まとめて送る' }));
    fireEvent.change(boxes[1]!, { target: { value: '二件目の答え、あとから' } });
    gate.resolve();

    const left = await screen.findByRole('list', { name: LEFT });
    expect(within(left).getAllByRole('listitem')).toHaveLength(1);
    expect(within(left).getByText(/対象: 二件目/)).toBeTruthy();
    expect(within(left).getByText('二件目の答え、あとから')).toBeTruthy();
    expect(loadApprovalDrafts().texts).toEqual({ 'a-two': '二件目の答え、あとから' });
  });

  it('再読み込み（保存した下書きと控え）でも、残った文が見える', async () => {
    const gate = stub([free], []);
    renderPage();
    const box = (await screen.findByPlaceholderText(/答える/)) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: '答え' } });
    fireEvent.click(screen.getByRole('button', { name: '回答する' }));
    fireEvent.change(box, { target: { value: '答え+' } });
    gate.resolve();
    await screen.findByRole('list', { name: LEFT });
    cleanup();

    stub([], []);
    renderPage();
    const left = await screen.findByRole('list', { name: LEFT });
    expect(within(left).getByText('答え+')).toBeTruthy();
  });
});

describe('送っていない欄の下書きは、送った経路によらず残る（issue #3625）', () => {
  it('定型の答え（許可）: 回答欄の書きかけは送っていないので残り、上部のブロックに出る', async () => {
    const gate = stub([free], []);
    renderPage();
    fireEvent.change(await screen.findByPlaceholderText(/答える/), {
      target: { value: '条件つきなら進めてよい' },
    });
    fireEvent.click(screen.getByRole('button', { name: '許可' }));
    gate.resolve();

    const left = await screen.findByRole('list', { name: LEFT });
    expect(within(left).getByText(/対象: 自由記述の件/)).toBeTruthy();
    expect(within(left).getByText('条件つきなら進めてよい')).toBeTruthy();
    expect(loadApprovalDrafts().texts).toEqual({ 'a-free': '条件つきなら進めてよい' });
  });

  it('設問のフォームで答える: 送っていない自由記述が残り、上部のブロックに出る', async () => {
    // 設問の承認の自由記述は、画面からは打てない。保存済みの下書きとして持っている場合を作る。
    saveApprovalDrafts({ texts: { 'a-ask': '別に書いておいた文' }, questions: {} });
    const gate = stub([asked], []);
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: '選択肢を開いて答える' }));
    fireEvent.click(screen.getByRole('radio', { name: /Fly\.io/ }));
    fireEvent.click(screen.getByRole('button', { name: '回答' }));
    gate.resolve();

    const left = await screen.findByRole('list', { name: LEFT });
    expect(within(left).getByText(/対象: 設問の件/)).toBeTruthy();
    expect(within(left).getByText('別に書いておいた文')).toBeTruthy();
    // 設問のフォームは送ったので畳まれ、残った文に選択肢は出ない。
    expect(within(left).queryByText(/選んだ/)).toBeNull();
    expect(loadApprovalDrafts()).toEqual({ texts: { 'a-ask': '別に書いておいた文' }, questions: {} });
  });

  it('自由記述をそのまま送ったときは、従来どおり畳まれる', async () => {
    const gate = stub([free], []);
    renderPage();
    fireEvent.change(await screen.findByPlaceholderText(/答える/), { target: { value: '答え' } });
    fireEvent.click(screen.getByRole('button', { name: '回答する' }));
    gate.resolve();

    await waitFor(() => expect(screen.queryByPlaceholderText(/答える/)).toBeNull());
    expect(screen.queryByRole('list', { name: LEFT })).toBeNull();
    await waitFor(() => expect(loadApprovalDrafts()).toEqual({ texts: {}, questions: {} }));
  });
});
