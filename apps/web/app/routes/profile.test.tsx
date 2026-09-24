// @vitest-environment jsdom
/**
 * `/profile` — 実行環境プロファイル本文を Web UI から読む・直す画面（issue #1122）。
 *
 * ここで固定したいのは「本文が無ければそう言う」「在ればバイト数・sha256・更新
 * 時刻を出す」「編集して保存を押しても、確認語（`apply`）を打つまで `PUT
 * /profile` を叩かない」「打てば `PUT /profile` を1回叩き、新しい本文を送る」
 * 「クローン・runner への反映結果を、成否を畳まずに出す」「403（実行環境の
 * 持ち主ではない）はボタンを隠さず `ErrorNote` に出す」の各点。
 *
 * **共有の `stubFetch` は使えない。** `openapi-fetch` は `fetch(new
 * Request(...))` の形で呼ぶので、素朴な `route(url, init)` だと method も
 * 本文も落ちる（`env-vars.test.tsx` の同じ断り書きと同じ理由）。ここでは
 * `globalThis.fetch` を自分で差し替える。
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { json, Providers, storeTestBaseUrl } from '~/test-support';

import Profile from './profile';

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

interface StubProfileView {
  script: string;
  updatedAt?: string;
  sha256?: string;
  bytes?: number;
}

interface StubPutOutcome {
  ok: boolean;
  error?: string;
  output?: string;
}

/**
 * **状態を持つ** `/profile` の stub。`PUT` を受けたら以降の `GET`（再検証も
 * 含む）がその状態を返す——`env-vars.test.tsx` の `stubCrudScreen` と同じ形。
 */
function stubProfileScreen(
  initial: StubProfileView,
  options: {
    getStatus?: number;
    putStatus?: number;
    putErrorBody?: { error: string; detail: string };
    cloneOutcome?: StubPutOutcome;
    runnerOutcomes?: (StubPutOutcome & { runnerId: string })[];
  } = {},
) {
  let current = initial;
  const puts: { script: string }[] = [];
  const { getStatus = 200, putStatus, putErrorBody, cloneOutcome, runnerOutcomes = [] } = options;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : null;
    const url = request?.url ?? (typeof input === 'string' ? input : String(input));
    const method = request?.method ?? init?.method ?? 'GET';

    if (!url.includes('/profile')) {
      return Promise.reject(new TypeError(`Failed to fetch: ${url}`));
    }
    if (method === 'GET') {
      if (getStatus !== 200) return json({ error: '実行環境の持ち主だけが操作できる' }, getStatus);
      return json(current);
    }
    if (method === 'PUT') {
      const body = (request !== null ? await request.json() : JSON.parse(String(init?.body))) as {
        script: string;
      };
      puts.push(body);
      if (putStatus !== undefined && putStatus !== 200) {
        return json(putErrorBody ?? { error: '保存できなかった', detail: '' }, putStatus);
      }
      current = {
        script: body.script,
        updatedAt: '2026-09-24T00:00:00.000Z',
        sha256: 'f'.repeat(12),
        bytes: body.script.length,
      };
      return json({
        updatedAt: current.updatedAt,
        sha256: current.sha256,
        bytes: current.bytes,
        clone: cloneOutcome ?? { ok: true },
        runners: runnerOutcomes,
      });
    }
    return json(current);
  }) as typeof fetch;

  return { puts };
}

async function waitForLoaded(): Promise<void> {
  await screen.findByRole('heading', { name: 'いまの状態' });
}

function textareaValue(): string {
  return (screen.getByLabelText('プロファイル本文') as HTMLTextAreaElement).value;
}

describe('/profile 画面 — いまの状態', () => {
  it('本文が空なら「置かれていません」と言う', async () => {
    stubProfileScreen({ script: '' });

    render(
      <Providers>
        <Profile />
      </Providers>,
    );
    await waitForLoaded();

    expect(await screen.findByText('置かれていません。')).toBeTruthy();
  });

  it('本文が在ればバイト数・sha256・更新時刻を出す', async () => {
    stubProfileScreen({
      script: 'export TZ=Asia/Tokyo',
      updatedAt: '2026-09-14T00:00:00.000Z',
      sha256: 'a'.repeat(12),
      bytes: 21,
    });

    render(
      <Providers>
        <Profile />
      </Providers>,
    );
    await waitForLoaded();

    expect(await screen.findByText(/sha256 a{12}/)).toBeTruthy();
    expect(textareaValue()).toBe('export TZ=Asia/Tokyo');
  });

  it('403（実行環境の持ち主ではない）はボタンを隠さず ErrorNote に出す', async () => {
    stubProfileScreen({ script: '' }, { getStatus: 403 });

    render(
      <Providers>
        <Profile />
      </Providers>,
    );

    expect(await screen.findByText('実行環境の持ち主だけが操作できる')).toBeTruthy();
    // 読めなくても編集画面自体は隠さない（`env-vars.tsx` `access.tsx` と同じ方針）。
    expect(screen.getByLabelText('プロファイル本文')).toBeTruthy();
  });
});

describe('/profile 画面 — 編集と確認', () => {
  async function openDialogWithDraft(draft: string): Promise<void> {
    fireEvent.change(screen.getByLabelText('プロファイル本文'), { target: { value: draft } });
    const label = draft.trim().length === 0 ? 'プロファイルを外す' : '保存する';
    fireEvent.click(screen.getByRole('button', { name: label }));
    await screen.findByPlaceholderText('apply');
  }

  it('【歯1】確認語（apply）を打つまで PUT /profile を叩かない', async () => {
    const { puts } = stubProfileScreen({ script: '' });
    render(
      <Providers>
        <Profile />
      </Providers>,
    );
    await waitForLoaded();

    await openDialogWithDraft('export TZ=Asia/Tokyo');
    fireEvent.change(screen.getByPlaceholderText('apply'), { target: { value: 'appl' } });
    const confirmButton = screen.getByRole('button', {
      name: '本当に反映する',
    }) as HTMLButtonElement;
    expect(confirmButton.disabled).toBe(true);

    fireEvent.click(confirmButton);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(puts).toEqual([]);
  });

  it('【歯2】確認語が一致すると押せて、PUT /profile を1回、新しい本文で叩く', async () => {
    const { puts } = stubProfileScreen(
      { script: '' },
      { cloneOutcome: { ok: true }, runnerOutcomes: [{ runnerId: 'runner-primary', ok: true }] },
    );
    render(
      <Providers>
        <Profile />
      </Providers>,
    );
    await waitForLoaded();

    await openDialogWithDraft('export TZ=Asia/Tokyo');
    fireEvent.change(screen.getByPlaceholderText('apply'), { target: { value: 'apply' } });
    const confirmButton = screen.getByRole('button', {
      name: '本当に反映する',
    }) as HTMLButtonElement;
    expect(confirmButton.disabled).toBe(false);
    fireEvent.click(confirmButton);

    await screen.findByText('反映しました。');
    expect(puts).toEqual([{ script: 'export TZ=Asia/Tokyo' }]);
  });

  it('本文を空にすると確認文言が「外す」向きになる', async () => {
    stubProfileScreen({
      script: 'export TZ=Asia/Tokyo',
      updatedAt: '2026-09-14T00:00:00.000Z',
      sha256: 'a'.repeat(12),
      bytes: 21,
    });
    render(
      <Providers>
        <Profile />
      </Providers>,
    );
    await waitForLoaded();

    await openDialogWithDraft('');
    expect(await screen.findByText('本当にプロファイルを外しますか？')).toBeTruthy();
  });

  it('クローン・runner への反映結果を、成否を畳まずに出す（失敗を小さく出さない）', async () => {
    stubProfileScreen(
      { script: '' },
      {
        cloneOutcome: { ok: true },
        runnerOutcomes: [{ runnerId: 'runner-2', ok: false, error: '読めなかった' }],
      },
    );
    render(
      <Providers>
        <Profile />
      </Providers>,
    );
    await waitForLoaded();

    await openDialogWithDraft('export TZ=Asia/Tokyo');
    fireEvent.change(screen.getByPlaceholderText('apply'), { target: { value: 'apply' } });
    fireEvent.click(screen.getByRole('button', { name: '本当に反映する' }));

    await screen.findByText('反映しました。');
    expect(screen.getByText('クローン')).toBeTruthy();
    expect(screen.getByText('runner-2')).toBeTruthy();
    expect(screen.getByText('読めなかった')).toBeTruthy();
    expect(screen.getAllByText('反映できませんでした').length).toBeGreaterThan(0);
  });

  it('400（保存できなかった理由つき）は error と detail の両方を出す', async () => {
    stubProfileScreen(
      { script: '' },
      {
        putStatus: 400,
        putErrorBody: {
          error: 'プロファイルが読めなかったので保存していない',
          detail: 'line 3: unexpected token',
        },
      },
    );
    render(
      <Providers>
        <Profile />
      </Providers>,
    );
    await waitForLoaded();

    await openDialogWithDraft('export BROKEN=(');
    fireEvent.change(screen.getByPlaceholderText('apply'), { target: { value: 'apply' } });
    fireEvent.click(screen.getByRole('button', { name: '本当に反映する' }));

    expect(await screen.findByText(/line 3: unexpected token/)).toBeTruthy();
  });
});
