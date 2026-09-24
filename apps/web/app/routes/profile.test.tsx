// @vitest-environment jsdom
/**
 * `/profile` — 実行環境プロファイルを読む・差し替える画面（issue #1122）。
 *
 * ここで固定したいのは次の各点:
 *
 * 1. **本文は既定で出さない。**「本文を表示する」を押すまで、鍵が入りうる本文を
 *    1文字も描かない（`GET /profile` は本文を丸ごと返すため）
 * 2. **保存は2段。**「保存する」だけでは `PUT /profile` を叩かず、「本当に保存する」
 *    で初めて、編集した本文をそのまま送る
 * 3. **400 のときは `detail` まで見せる。** 直すのに要るのは行番号込みの `detail` で、
 *    共有の `unwrap` が拾う `error` だけでは直せない
 * 4. **外すのは空文字の `PUT /profile`**（`alteroid profile clear` と同じ）
 * 5. **403 は本文で出し分ける。** `requireOwner` の本文のときだけ持ち主の宣言を
 *    案内し、それ以外の 403 には案内を出さない（2026-09-24 に門を `requireOperator`
 *    から `requireOwner` へ移したので、案内も「端末でプロファイルを編集する」から
 *    「持ち主として宣言する」へ差し替えた）
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

const SECRET_LINE = 'export SOME_API_TOKEN=very-secret-value';

const STORED = {
  script: `${SECRET_LINE}\n`,
  updatedAt: '2026-09-20T00:00:00.000Z',
  sha256: 'a'.repeat(12),
  bytes: 41,
};

const UPDATED = {
  updatedAt: '2026-09-24T00:00:00.000Z',
  sha256: 'b'.repeat(12),
  bytes: 20,
  clone: { ok: true, names: ['PATH'] },
  runners: [{ runnerId: 'runner-1', ok: false, error: 'runner に届かなかった' }],
};

type PutReply = { status: number; body: unknown };

/**
 * `/profile` の stub。**共有の `stubFetch` は使えない**（`openapi-fetch` は
 * `fetch(new Request(...))` の形で呼ぶので、method も本文も落ちる。
 * `env-vars.test.tsx` の同じ断り書きと同じ理由）。
 *
 * `get` / `put` に 200 以外を返させれば、403・400 の分岐を作れる。
 */
function stubProfile(options: { get?: PutReply; put?: PutReply } = {}) {
  let stored: unknown = STORED;
  const puts: string[] = [];

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : null;
    const url = request?.url ?? (typeof input === 'string' ? input : String(input));
    const method = request?.method ?? init?.method ?? 'GET';

    if (!url.includes('/profile')) {
      return Promise.reject(new TypeError(`Failed to fetch: ${url}`));
    }
    if (method === 'PUT') {
      const body = (request !== null ? await request.json() : JSON.parse(String(init?.body))) as {
        script: string;
      };
      puts.push(body.script);
      const reply = options.put ?? { status: 200, body: UPDATED };
      if (reply.status === 200) {
        stored =
          body.script.length === 0
            ? { script: '' }
            : { script: body.script, updatedAt: UPDATED.updatedAt, sha256: UPDATED.sha256 };
      }
      return json(reply.body, reply.status);
    }
    const reply = options.get ?? { status: 200, body: stored };
    return json(reply.body, reply.status);
  }) as typeof fetch;

  return { puts };
}

function renderScreen() {
  render(
    <Providers>
      <Profile />
    </Providers>,
  );
}

describe('/profile 画面 — 読む', () => {
  it('状態（バイト数・指紋）は出すが、本文は「本文を表示する」を押すまで出さない', async () => {
    stubProfile();
    renderScreen();

    expect(await screen.findByText('41 バイト')).toBeTruthy();
    expect(screen.getByText(/sha256=a{12}/)).toBeTruthy();
    expect(document.body.textContent).not.toContain('very-secret-value');

    fireEvent.click(screen.getByRole('button', { name: '本文を表示する' }));
    expect(screen.getByLabelText('プロファイルの本文').textContent).toContain(SECRET_LINE);

    fireEvent.click(screen.getByRole('button', { name: '本文を隠す' }));
    expect(document.body.textContent).not.toContain('very-secret-value');
  });

  it('置かれていなければ「置かれていない」と出し、表示・外すボタンを出さない', async () => {
    stubProfile({ get: { status: 200, body: { script: '' } } });
    renderScreen();

    expect(await screen.findByText('置かれていない')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '本文を表示する' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'プロファイルを外す' })).toBeNull();
    expect(screen.getByRole('button', { name: '編集する' })).toBeTruthy();
  });

  it('requireOwner の 403 なら、持ち主として宣言する手を案内する', async () => {
    stubProfile({
      get: {
        status: 403,
        body: { error: '実行環境の持ち主として宣言されたアカウントだけが操作できる' },
      },
    });
    renderScreen();

    expect(
      await screen.findByText('実行環境の持ち主として宣言されたアカウントだけが操作できる'),
    ).toBeTruthy();
    expect(screen.getByText('alteroid access owner <アカウント id>')).toBeTruthy();
    // 読めていないので、編集の欄も出さない。
    expect(screen.queryByRole('button', { name: '編集する' })).toBeNull();
  });

  it('本文から理由が判別できない 403 には案内を出さない', async () => {
    stubProfile({
      get: { status: 403, body: { error: 'このアカウントには alteroid を使う許可が無い' } },
    });
    renderScreen();

    expect(await screen.findByText('このアカウントには alteroid を使う許可が無い')).toBeTruthy();
    expect(screen.queryByText('alteroid access owner <アカウント id>')).toBeNull();
  });
});

describe('/profile 画面 — 差し替える', () => {
  it('「保存する」だけでは PUT を叩かず、「本当に保存する」で編集した本文をそのまま送る', async () => {
    const { puts } = stubProfile();
    renderScreen();

    fireEvent.click(await screen.findByRole('button', { name: '編集する' }));
    const editor = screen.getByLabelText<HTMLTextAreaElement>('プロファイルの新しい本文');
    // 「編集する」を押すと、いま置かれている本文が流し込まれる（`alteroid profile edit` と同じ）。
    expect(editor.value).toBe(STORED.script);

    const next = 'export PATH="$HOME/.local/bin:$PATH"\n';
    fireEvent.change(editor, { target: { value: next } });
    fireEvent.click(screen.getByRole('button', { name: '保存する' }));
    expect(puts).toEqual([]);

    fireEvent.click(screen.getByRole('button', { name: '本当に保存する' }));
    expect(await screen.findByText(/プロファイルを更新した（sha256 b{12}）/)).toBeTruthy();
    expect(puts).toEqual([next]);
    // 反映できなかった runner を小さく出さない。
    expect(screen.getByText(/反映できなかった — runner に届かなかった/)).toBeTruthy();
  });

  it('確認で「保存をやめる」を押せば PUT を叩かない', async () => {
    const { puts } = stubProfile();
    renderScreen();

    fireEvent.click(await screen.findByRole('button', { name: '編集する' }));
    fireEvent.change(screen.getByLabelText('プロファイルの新しい本文'), {
      target: { value: 'export A=1\n' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存する' }));
    fireEvent.click(screen.getByRole('button', { name: '保存をやめる' }));

    expect(screen.queryByRole('button', { name: '本当に保存する' })).toBeNull();
    expect(puts).toEqual([]);
  });

  it('400 なら error と detail（評価の失敗の中身）を出し、前のものが残ると言う', async () => {
    const { puts } = stubProfile({
      put: {
        status: 400,
        body: {
          error: 'プロファイルが読めなかったので保存していない',
          detail: "profile.sh: line 1: syntax error near unexpected token `('",
        },
      },
    });
    renderScreen();

    fireEvent.click(await screen.findByRole('button', { name: '編集する' }));
    fireEvent.change(screen.getByLabelText('プロファイルの新しい本文'), {
      target: { value: 'export (\n' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存する' }));
    fireEvent.click(screen.getByRole('button', { name: '本当に保存する' }));

    expect(await screen.findByText('プロファイルが読めなかったので保存していない')).toBeTruthy();
    expect(screen.getByLabelText('評価の失敗の詳細').textContent).toContain(
      'syntax error near unexpected token',
    );
    expect(screen.getByText('前のプロファイルがそのまま残っている。')).toBeTruthy();
    expect(puts).toEqual(['export (\n']);
    // 編集中の本文は消さない（直してもう一度送るため）。確認は畳む。
    expect(screen.getByLabelText<HTMLTextAreaElement>('プロファイルの新しい本文').value).toBe(
      'export (\n',
    );
    expect(screen.queryByRole('button', { name: '本当に保存する' })).toBeNull();
  });

  it('PUT が requireOwner の 403 なら、持ち主として宣言する手を案内する', async () => {
    stubProfile({
      put: {
        status: 403,
        body: { error: '実行環境の持ち主として宣言されたアカウントだけが操作できる' },
      },
    });
    renderScreen();

    fireEvent.click(await screen.findByRole('button', { name: '編集する' }));
    fireEvent.change(screen.getByLabelText('プロファイルの新しい本文'), {
      target: { value: 'export A=1\n' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存する' }));
    fireEvent.click(screen.getByRole('button', { name: '本当に保存する' }));

    expect(await screen.findByText('alteroid access owner <アカウント id>')).toBeTruthy();
  });

  it('「プロファイルを外す」は確認を挟んでから空文字の PUT を送る（alteroid profile clear と同じ）', async () => {
    const { puts } = stubProfile();
    renderScreen();

    fireEvent.click(await screen.findByRole('button', { name: 'プロファイルを外す' }));
    expect(puts).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: '本当に外す' }));

    expect(await screen.findByText('プロファイルを外した。')).toBeTruthy();
    expect(puts).toEqual(['']);
  });
});
