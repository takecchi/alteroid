// @vitest-environment jsdom
/**
 * `/profile` — 実行環境プロファイル（名前付きの行の集まり）を読む・差し替える画面
 * （issue #1122。行ごとの形は 2026-10-03）。
 *
 * ここで固定したいのは次の各点:
 *
 * 1. **本文は既定で出さない。**「本文を表示する」を押すまで、鍵が入りうる本文を
 *    1文字も描かない（`GET /profile` は本文を丸ごと返すため）
 * 2. **保存は2段。**「保存する」だけでは `PUT /profile/:name` を叩かず、「本当に保存する」
 *    で初めて、編集した本文・渡す先をそのまま送る
 * 3. **400 のときは `detail` まで見せる。** 直すのに要るのは行番号込みの `detail` で、
 *    共有の `unwrap` が拾う `error` だけでは直せない
 * 4. **外すのは行ごとの `DELETE /profile/:name`**（確認を挟む）
 * 5. **403 に宣言の案内を出さない。** 本文が何であれ（かつての `requireOwner` の本文でも）、
 *    持ち主として宣言する手は案内しない（#2862: ログインできる許可済みの人は全員持ち主）
 * 6. **渡す先は環境変数の画面と同じ3値・同じ言い方。** 既定は共通（all）
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, Link, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

interface Row {
  name: string;
  script: string;
  scope: string;
  updatedAt: string;
  sha256: string;
  bytes: number;
}

const BASE: Row = {
  name: 'base',
  script: `${SECRET_LINE}\n`,
  scope: 'all',
  updatedAt: '2026-09-20T00:00:00.000Z',
  sha256: 'a'.repeat(12),
  bytes: 41,
};
const RUST: Row = {
  name: 'rust',
  script: 'export RUSTUP_HOME=/opt/rust/rustup\n',
  scope: 'runner',
  updatedAt: '2026-09-21T00:00:00.000Z',
  sha256: 'r'.repeat(12),
  bytes: 36,
};

function getBody(entries: Row[]) {
  return {
    entries,
    clone: entries.length === 0 ? {} : { sha256: 'c'.repeat(12), bytes: 41 },
    runner: entries.length === 0 ? {} : { sha256: 'd'.repeat(12), bytes: 77 },
    script: entries.map((entry) => entry.script).join('\n'),
  };
}

const UPDATED = {
  updatedAt: '2026-09-24T00:00:00.000Z',
  entries: [
    {
      name: 'base',
      scope: 'all',
      updatedAt: '2026-09-24T00:00:00.000Z',
      sha256: 'b'.repeat(12),
      bytes: 20,
    },
  ],
  composed: { clone: { sha256: 'e'.repeat(12) }, runner: { sha256: 'f'.repeat(12) } },
  clone: { ok: true, names: ['PATH'] },
  runners: [{ runnerId: 'runner-1', ok: true, names: ['PATH'] }],
};

type Reply = { status: number; body: unknown };

/**
 * `/profile` の stub。**共有の `stubFetch` は使えない**（`openapi-fetch` は
 * `fetch(new Request(...))` の形で呼ぶので、method も本文も落ちる。
 * `env-vars.test.tsx` の同じ断り書きと同じ理由）。
 */
function stubProfile(
  options: { rows?: Row[]; get?: Reply; put?: Reply; del?: Reply; putGate?: Promise<void> } = {},
) {
  let rows = options.rows ?? [BASE, RUST];
  const puts: { name: string; body: { script: string; scope?: string } }[] = [];
  const deletes: string[] = [];

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : null;
    const url = request?.url ?? (typeof input === 'string' ? input : String(input));
    const method = request?.method ?? init?.method ?? 'GET';
    const path = new URL(url).pathname;

    if (!path.startsWith('/profile')) {
      return Promise.reject(new TypeError(`Failed to fetch: ${url}`));
    }
    const name = decodeURIComponent(path.slice('/profile/'.length));
    if (method === 'PUT') {
      const body = (request !== null ? await request.json() : JSON.parse(String(init?.body))) as {
        script: string;
        scope?: string;
      };
      puts.push({ name, body });
      // 保存の完了を、テストが好きな時点まで止める（実時間の待ちは使わない）。
      await options.putGate;
      const reply = options.put ?? { status: 200, body: UPDATED };
      if (reply.status === 200) {
        rows = [
          ...rows.filter((row) => row.name !== name),
          { ...BASE, name, script: body.script, scope: body.scope ?? 'all' },
        ];
      }
      return json(reply.body, reply.status);
    }
    if (method === 'DELETE') {
      deletes.push(name);
      const reply = options.del ?? { status: 200, body: { ...UPDATED, entries: [] } };
      if (reply.status === 200) rows = rows.filter((row) => row.name !== name);
      return json(reply.body, reply.status);
    }
    const reply = options.get ?? { status: 200, body: getBody(rows) };
    return json(reply.body, reply.status);
  }) as typeof fetch;

  return { puts, deletes };
}

function renderScreen() {
  // `useBlocker` はデータルーターの中でしか動かない。離れる先のリンクも置く。
  const router = createMemoryRouter(
    [
      {
        path: '/profile',
        Component: () => (
          <>
            <Link to="/elsewhere">よその画面</Link>
            <Profile />
          </>
        ),
      },
      { path: '/elsewhere', Component: () => <p>よその画面です</p> },
    ],
    { initialEntries: ['/profile'] },
  );
  render(
    <Providers>
      <RouterProvider router={router} />
    </Providers>,
  );
}

describe('/profile 画面 — 読む', () => {
  it('行の一覧（名前・渡す先・バイト数・識別用の値）と合成後の識別用の値を出すが、本文は「本文を表示する」を押すまで出さない', async () => {
    stubProfile();
    renderScreen();

    expect(await screen.findByText('base')).toBeTruthy();
    expect(screen.getByText('rust')).toBeTruthy();
    // 渡す先は環境変数の画面と同じ言い方。
    expect(screen.getByText('共通')).toBeTruthy();
    expect(screen.getByText('マネージャーだけ')).toBeTruthy();
    expect(screen.getByText('41 バイト')).toBeTruthy();
    expect(screen.getByText(/a{12}/)).toBeTruthy();
    expect(screen.getByText('c'.repeat(12))).toBeTruthy();
    expect(screen.getByText('d'.repeat(12))).toBeTruthy();
    // 名前の辞書順につなげて効くことを画面に書く。
    expect(screen.getByText(/名前の辞書順/)).toBeTruthy();
    expect(document.body.textContent).not.toContain('very-secret-value');

    expect(screen.getByRole('button', { name: 'base の本文を表示する' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'base を編集する' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'base の行を外す' })).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', { name: / の本文を表示する$/ })[0]!);
    expect(screen.getByLabelText('プロファイルの行 base の本文').textContent).toContain(
      SECRET_LINE,
    );

    fireEvent.click(screen.getByRole('button', { name: / の本文を隠す$/ }));
    expect(document.body.textContent).not.toContain('very-secret-value');
  });

  it('置かれていなければ「置かれていない」と出し、行を追加するボタンがある', async () => {
    stubProfile({ rows: [] });
    renderScreen();

    expect(await screen.findByText('置かれていない')).toBeTruthy();
    expect(screen.queryByRole('button', { name: / の本文を表示する$/ })).toBeNull();
    expect(screen.getByRole('button', { name: '行を追加する' })).toBeTruthy();
  });

  it('知らない渡す先でも落ちず、そのまま出す（サーバのほうが新しい窓が在る）', async () => {
    stubProfile({ rows: [{ ...BASE, scope: 'future-scope' }] });
    renderScreen();

    expect(await screen.findByText('未知の渡す先（future-scope）')).toBeTruthy();
  });

  it('かつての requireOwner の本文の 403 でも、持ち主の宣言は案内しない（#2862）', async () => {
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
    expect(screen.queryByText('alteroid access owner <アカウント id>')).toBeNull();
    expect(screen.queryByText(/持ち主として宣言してください/)).toBeNull();
    // 読めていないので、編集の欄も出さない。
    expect(screen.queryByRole('button', { name: '行を追加する' })).toBeNull();
  });

  it('許可の無い 403 にも、持ち主の宣言は案内しない', async () => {
    stubProfile({
      get: { status: 403, body: { error: 'このアカウントには alteroid を使う許可が無い' } },
    });
    renderScreen();

    expect(await screen.findByText('このアカウントには alteroid を使う許可が無い')).toBeTruthy();
    expect(screen.queryByText('alteroid access owner <アカウント id>')).toBeNull();
  });
});

describe('/profile 画面 — 行を置く', () => {
  it('「編集する」は、その行の本文・渡す先を流し込み、名前は変えられない', async () => {
    stubProfile();
    renderScreen();

    fireEvent.click((await screen.findAllByRole('button', { name: / を編集する$/ }))[1]!);

    expect(screen.getByLabelText<HTMLTextAreaElement>('プロファイルの新しい本文').value).toBe(
      RUST.script,
    );
    expect(screen.getByLabelText<HTMLSelectElement>('プロファイルの渡す先').value).toBe('runner');
    const name = screen.getByLabelText<HTMLInputElement>('プロファイルの行の名前');
    expect(name.value).toBe('rust');
    expect(name.disabled).toBe(true);
  });

  it('「保存する」だけでは PUT を叩かず、「本当に保存する」で名前・渡す先・本文をそのまま送る', async () => {
    const { puts } = stubProfile({ rows: [] });
    renderScreen();

    fireEvent.click(await screen.findByRole('button', { name: '行を追加する' }));
    fireEvent.change(screen.getByLabelText('プロファイルの行の名前'), {
      target: { value: 'rust' },
    });
    const next = 'export PATH="/opt/rust/bin:$PATH"\n';
    fireEvent.change(screen.getByLabelText('プロファイルの新しい本文'), {
      target: { value: next },
    });
    fireEvent.change(screen.getByLabelText('プロファイルの渡す先'), {
      target: { value: 'runner' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存する' }));
    expect(puts).toEqual([]);
    expect(screen.getByText(/マネージャー・作業者だけへ渡す/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '本当に保存する' }));

    expect(await screen.findByText(/プロファイルの行 rust を更新した。/)).toBeTruthy();
    expect(puts).toEqual([{ name: 'rust', body: { script: next, scope: 'runner' } }]);
    // 合成後の識別用の値と、runner ごとの結果を出す。全部届いたので成功の見出し（警告ではない）。
    expect(screen.getByText(/クローン用 e{12} \/ マネージャー用 f{12}/)).toBeTruthy();
    expect(screen.getAllByText(/反映した（PATH）/)).toHaveLength(2);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('本文で Ctrl + Enter は「保存する」と同じ（確認へ進むだけ）。確認の段では PUT しない', async () => {
    const { puts } = stubProfile({ rows: [] });
    renderScreen();

    fireEvent.click(await screen.findByRole('button', { name: '行を追加する' }));
    const body = screen.getByLabelText('プロファイルの新しい本文');
    // 名前が空・本文が空のあいだは進まない（保存ボタンも disabled）。
    fireEvent.keyDown(body, { key: 'Enter', ctrlKey: true });
    expect(screen.queryByRole('button', { name: '本当に保存する' })).toBeNull();

    fireEvent.change(screen.getByLabelText('プロファイルの行の名前'), {
      target: { value: 'rust' },
    });
    fireEvent.change(body, { target: { value: 'export A=1\n' } });
    fireEvent.keyDown(body, { key: 'Enter' });
    expect(screen.queryByRole('button', { name: '本当に保存する' })).toBeNull();
    fireEvent.keyDown(body, { key: 'Enter', ctrlKey: true });
    expect(screen.getByRole('button', { name: '本当に保存する' })).toBeTruthy();
    fireEvent.keyDown(body, { key: 'Enter', metaKey: true });
    expect(puts).toEqual([]);
  });

  it('一部の runner へ反映できなかったら、成功の見出しを出さず警告（warn 色）にして、失敗の行も出す（#3157）', async () => {
    stubProfile({
      rows: [],
      put: {
        status: 200,
        body: {
          ...UPDATED,
          runners: [
            { runnerId: 'runner-1', ok: true },
            { runnerId: 'runner-2', ok: false, error: 'runner に届かなかった' },
          ],
        },
      },
    });
    renderScreen();

    fireEvent.click(await screen.findByRole('button', { name: '行を追加する' }));
    fireEvent.change(screen.getByLabelText('プロファイルの行の名前'), {
      target: { value: 'rust' },
    });
    fireEvent.change(screen.getByLabelText('プロファイルの新しい本文'), {
      target: { value: 'export A=1\n' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存する' }));
    fireEvent.click(screen.getByRole('button', { name: '本当に保存する' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(
      'プロファイルの行 rust を更新したが、一部の実行環境へ反映できていない',
    );
    expect(alert.className).toContain('text-warn');
    expect(screen.queryByText(/プロファイルの行 rust を更新した。/)).toBeNull();
    expect(screen.getByText(/反映できなかった — runner に届かなかった/)).toBeTruthy();
  });

  it('名前の形が不正・本文が空なら保存できない', async () => {
    stubProfile({ rows: [] });
    renderScreen();

    fireEvent.click(await screen.findByRole('button', { name: '行を追加する' }));
    const save = () => screen.getByRole('button', { name: '保存する' }).hasAttribute('disabled');
    expect(save()).toBe(true);

    fireEvent.change(screen.getByLabelText('プロファイルの新しい本文'), {
      target: { value: 'export A=1\n' },
    });
    fireEvent.change(screen.getByLabelText('プロファイルの行の名前'), {
      target: { value: '../x' },
    });
    expect(save()).toBe(true);
    expect(screen.getByText('名前の形が不正。')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('プロファイルの行の名前'), { target: { value: 'ok' } });
    expect(save()).toBe(false);

    fireEvent.change(screen.getByLabelText('プロファイルの新しい本文'), {
      target: { value: '  \n' },
    });
    expect(save()).toBe(true);
  });

  it('本文を変えなくても、渡す先を変えれば保存できる（外れる側が出るので更新である）', async () => {
    stubProfile();
    renderScreen();

    fireEvent.click((await screen.findAllByRole('button', { name: / を編集する$/ }))[0]!);
    expect(screen.getByRole('button', { name: '保存する' }).hasAttribute('disabled')).toBe(true);

    fireEvent.change(screen.getByLabelText('プロファイルの渡す先'), { target: { value: 'app' } });

    expect(screen.getByRole('button', { name: '保存する' }).hasAttribute('disabled')).toBe(false);
  });

  it('確認で「保存をやめる」を押せば PUT を叩かない', async () => {
    const { puts } = stubProfile();
    renderScreen();

    fireEvent.click((await screen.findAllByRole('button', { name: / を編集する$/ }))[0]!);
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

    fireEvent.click((await screen.findAllByRole('button', { name: / を編集する$/ }))[0]!);
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
    expect(puts.map((entry) => entry.body.script)).toEqual(['export (\n']);
    // 編集中の本文は消さない（直してもう一度送るため）。確認は畳む。
    expect(screen.getByLabelText<HTMLTextAreaElement>('プロファイルの新しい本文').value).toBe(
      'export (\n',
    );
    expect(screen.queryByRole('button', { name: '本当に保存する' })).toBeNull();
  });

  it('PUT がかつての requireOwner の本文の 403 でも、持ち主の宣言は案内しない', async () => {
    stubProfile({
      put: {
        status: 403,
        body: { error: '実行環境の持ち主として宣言されたアカウントだけが操作できる' },
      },
    });
    renderScreen();

    fireEvent.click((await screen.findAllByRole('button', { name: / を編集する$/ }))[0]!);
    fireEvent.change(screen.getByLabelText('プロファイルの新しい本文'), {
      target: { value: 'export A=1\n' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存する' }));
    fireEvent.click(screen.getByRole('button', { name: '本当に保存する' }));

    expect(
      (await screen.findAllByText('実行環境の持ち主として宣言されたアカウントだけが操作できる'))
        .length,
    ).toBeGreaterThan(0);
    expect(screen.queryByText('alteroid access owner <アカウント id>')).toBeNull();
    expect(screen.queryByText(/持ち主として宣言してください/)).toBeNull();
  });
});

/**
 * 別の行の「編集する」へ切り替えたとき、前の行の確認の枠と失敗の表示を残さない（issue #3073）。
 * 確認・失敗は `ProfileEditor` の中の state なので、親の `setEditor` だけでは畳まれなかった。
 */
describe('/profile 画面 — 編集する行を切り替える', () => {
  it('確認の枠が出たまま別の行の「編集する」を押すと、確認は畳まれ、PUT は走らない', async () => {
    const { puts } = stubProfile();
    renderScreen();

    fireEvent.click((await screen.findAllByRole('button', { name: / を編集する$/ }))[0]!);
    fireEvent.change(screen.getByLabelText('プロファイルの新しい本文'), {
      target: { value: 'export A=1\n' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存する' }));
    expect(screen.getByRole('button', { name: '本当に保存する' })).toBeTruthy();

    fireEvent.click(screen.getAllByRole('button', { name: / を編集する$/ })[1]!);
    fireEvent.click(await screen.findByRole('button', { name: '破棄して切り替える' }));

    expect(screen.queryByRole('button', { name: '本当に保存する' })).toBeNull();
    expect(screen.getByRole('button', { name: '保存する' })).toBeTruthy();
    expect(puts).toEqual([]);
  });

  it('保存の失敗が出たまま別の行の「編集する」を押すと、前の行の失敗は消える', async () => {
    stubProfile({
      put: { status: 400, body: { error: 'プロファイルが読めなかったので保存していない' } },
    });
    renderScreen();

    fireEvent.click((await screen.findAllByRole('button', { name: / を編集する$/ }))[0]!);
    fireEvent.change(screen.getByLabelText('プロファイルの新しい本文'), {
      target: { value: 'export (\n' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存する' }));
    fireEvent.click(screen.getByRole('button', { name: '本当に保存する' }));
    expect(await screen.findByText('プロファイルが読めなかったので保存していない')).toBeTruthy();

    fireEvent.click(screen.getAllByRole('button', { name: / を編集する$/ })[1]!);
    fireEvent.click(await screen.findByRole('button', { name: '破棄して切り替える' }));

    expect(screen.queryByText('プロファイルが読めなかったので保存していない')).toBeNull();
  });
});

describe('/profile 画面 — 保存中に別の行へ切り替える', () => {
  function gate() {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    return { promise, release };
  }

  it('保存中に別の行の「編集する」を押すと、前の行の保存が終わっても新しい行の編集欄と書きかけは残る', async () => {
    const { promise, release } = gate();
    const { puts } = stubProfile({ putGate: promise });
    renderScreen();

    fireEvent.click((await screen.findAllByRole('button', { name: / を編集する$/ }))[0]!);
    fireEvent.change(screen.getByLabelText('プロファイルの新しい本文'), {
      target: { value: 'export A=1\n' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存する' }));
    fireEvent.click(screen.getByRole('button', { name: '本当に保存する' }));
    await vi.waitFor(() => expect(puts).toHaveLength(1));

    fireEvent.click(screen.getAllByRole('button', { name: / を編集する$/ })[1]!);
    fireEvent.click(await screen.findByRole('button', { name: '破棄して切り替える' }));
    fireEvent.change(screen.getByLabelText('プロファイルの新しい本文'), {
      target: { value: 'export DRAFT=2\n' },
    });
    release();

    // 前の行の保存の結果は、行の名前つきで出る（書き込み自体は起きたので隠さない）。
    expect(await screen.findByText('プロファイルの行 base を更新した。')).toBeTruthy();
    expect(screen.getByLabelText<HTMLTextAreaElement>('プロファイルの新しい本文').value).toBe(
      'export DRAFT=2\n',
    );
    expect(screen.getByLabelText<HTMLInputElement>('プロファイルの行の名前').value).toBe('rust');
  });

  it('新しい行（「行を追加する」）を保存中に別の行の「編集する」を押しても、同じく書きかけは残る', async () => {
    const { promise, release } = gate();
    const { puts } = stubProfile({ putGate: promise });
    renderScreen();

    fireEvent.click(await screen.findByRole('button', { name: '行を追加する' }));
    fireEvent.change(screen.getByLabelText('プロファイルの行の名前'), { target: { value: 'new' } });
    fireEvent.change(screen.getByLabelText('プロファイルの新しい本文'), {
      target: { value: 'export N=1\n' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存する' }));
    fireEvent.click(screen.getByRole('button', { name: '本当に保存する' }));
    await vi.waitFor(() => expect(puts).toHaveLength(1));

    fireEvent.click(screen.getAllByRole('button', { name: / を編集する$/ })[0]!);
    fireEvent.click(await screen.findByRole('button', { name: '破棄して切り替える' }));
    fireEvent.change(screen.getByLabelText('プロファイルの新しい本文'), {
      target: { value: 'export DRAFT=3\n' },
    });
    release();

    expect(await screen.findByText('プロファイルの行 new を更新した。')).toBeTruthy();
    expect(screen.getByLabelText<HTMLTextAreaElement>('プロファイルの新しい本文').value).toBe(
      'export DRAFT=3\n',
    );
  });

  it('切り替えずに保存が終われば、従来どおり編集欄は閉じる', async () => {
    stubProfile();
    renderScreen();

    fireEvent.click((await screen.findAllByRole('button', { name: / を編集する$/ }))[0]!);
    fireEvent.change(screen.getByLabelText('プロファイルの新しい本文'), {
      target: { value: 'export A=1\n' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存する' }));
    fireEvent.click(screen.getByRole('button', { name: '本当に保存する' }));

    expect(await screen.findByText('プロファイルの行 base を更新した。')).toBeTruthy();
    expect(screen.queryByLabelText('プロファイルの新しい本文')).toBeNull();
  });
});

describe('/profile 画面 — 行を外す', () => {
  it('「この行を外す」は確認を挟んでから、その行だけの DELETE を送る', async () => {
    const { deletes } = stubProfile();
    renderScreen();

    fireEvent.click((await screen.findAllByRole('button', { name: / の行を外す$/ }))[1]!);
    expect(deletes).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: / の行を本当に外す$/ }));

    expect(await screen.findByText(/プロファイルの行 rust を外した。/)).toBeTruthy();
    expect(deletes).toEqual(['rust']);
  });

  it('確認で「外すのをやめる」を押せば DELETE を叩かない', async () => {
    const { deletes } = stubProfile();
    renderScreen();

    fireEvent.click((await screen.findAllByRole('button', { name: / の行を外す$/ }))[0]!);
    fireEvent.click(screen.getByRole('button', { name: '外すのをやめる' }));

    expect(deletes).toEqual([]);
    expect(screen.queryByRole('button', { name: / の行を本当に外す$/ })).toBeNull();
  });
});

/**
 * **古いデーモン（`entries` 無しの応答）に新しい画面が繋がった窓。** Web は Vercel でマージ直後に
 * 入り、デーモンは `release/prod` 経由で1日1回夜に入るので、この窓は必ず生じる。型は新しい形を
 * 約束するので、**ここが測るのは実行時の倒れ先だけ**（型の側は `typecheck` が守る）。
 * 古いデーモンは `{ script, updatedAt?, sha256?, bytes? }` だけを返し、行ごとの口は持たない。
 */
describe('/profile 画面 — 古いデーモン（旧形式の応答）', () => {
  const OLD = {
    script: `${SECRET_LINE}\n`,
    updatedAt: '2026-09-20T00:00:00.000Z',
    sha256: 'o'.repeat(12),
    bytes: 41,
  };

  /** 旧形式だけを返すデーモンの stub。`PUT /profile` は旧来の応答（`entries` / `composed` 無し）。 */
  function stubOldDaemon(initial: unknown = OLD) {
    const calls: { method: string; path: string; body?: unknown }[] = [];
    let current = initial;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : null;
      const url = request?.url ?? String(input);
      const method = request?.method ?? init?.method ?? 'GET';
      const path = new URL(url).pathname;
      if (method === 'PUT' && path === '/profile') {
        const body = (request !== null ? await request.json() : JSON.parse(String(init?.body))) as {
          script: string;
        };
        calls.push({ method, path, body });
        current = body.script.length === 0 ? { script: '' } : { ...OLD, script: body.script };
        return json(
          { updatedAt: 'T', sha256: 'n'.repeat(12), bytes: 5, clone: { ok: true }, runners: [] },
          200,
        );
      }
      calls.push({ method, path });
      if (method === 'GET' && path === '/profile') return json(current, 200);
      // 古いデーモンには行ごとの口が無い。
      return json({ error: 'Not Found' }, 404);
    }) as typeof fetch;
    return { calls };
  }

  it('落ちずに default 1行として本文が見え、デーモンが古い旨を出す。識別用の値・渡す先は消さない', async () => {
    stubOldDaemon();
    renderScreen();

    expect(await screen.findByText('default')).toBeTruthy();
    expect(screen.getByText(/サーバが古いので/)).toBeTruthy();
    expect(screen.getByText('共通')).toBeTruthy();
    expect(screen.getByText('41 バイト')).toBeTruthy();
    expect(screen.getByText(/o{12}/)).toBeTruthy();
    // 本文は今までどおり、押すまで出さない。押せば1文字も欠けずに見える。
    expect(document.body.textContent).not.toContain('very-secret-value');
    fireEvent.click(screen.getByRole('button', { name: / の本文を表示する$/ }));
    expect(screen.getByLabelText('プロファイルの行 default の本文').textContent).toContain(
      SECRET_LINE,
    );
  });

  it('行ごとの書き込み（外す・追加）は出さない', async () => {
    stubOldDaemon();
    renderScreen();

    await screen.findByText('default');
    expect(screen.queryByRole('button', { name: / の行を外す$/ })).toBeNull();
    // default が既に在るので、行の追加ボタンも出ない。
    expect(screen.queryByRole('button', { name: '行を追加する' })).toBeNull();
  });

  it('本文の編集は従来の PUT /profile {script} へ倒れる（名前・渡す先は固定）', async () => {
    const { calls } = stubOldDaemon();
    renderScreen();

    fireEvent.click(await screen.findByRole('button', { name: / を編集する$/ }));
    expect(screen.getByLabelText<HTMLInputElement>('プロファイルの行の名前').disabled).toBe(true);
    expect(screen.getByLabelText<HTMLSelectElement>('プロファイルの渡す先').disabled).toBe(true);
    const next = 'export NEW=1\n';
    fireEvent.change(screen.getByLabelText('プロファイルの新しい本文'), {
      target: { value: next },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存する' }));
    fireEvent.click(screen.getByRole('button', { name: '本当に保存する' }));

    // 古いデーモンの応答（`composed` 無し）でも落ちない。
    expect(await screen.findByText(/プロファイルの行 default を更新した。/)).toBeTruthy();
    expect(calls.filter((call) => call.method === 'PUT')).toEqual([
      { method: 'PUT', path: '/profile', body: { script: next } },
    ]);
    expect(calls.some((call) => call.path.startsWith('/profile/'))).toBe(false);
  });

  it('何も置かれていない旧形式（script が空）は「置かれていない」。追加は default 1行だけ', async () => {
    const { calls } = stubOldDaemon({ script: '' });
    renderScreen();

    expect(await screen.findByText('置かれていない')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '行を追加する' }));
    expect(screen.getByLabelText<HTMLInputElement>('プロファイルの行の名前').value).toBe('default');
    fireEvent.change(screen.getByLabelText('プロファイルの新しい本文'), {
      target: { value: 'export A=1\n' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存する' }));
    fireEvent.click(screen.getByRole('button', { name: '本当に保存する' }));

    expect(await screen.findByText(/プロファイルの行 default を更新した。/)).toBeTruthy();
    expect(calls.filter((call) => call.method === 'PUT').map((call) => call.path)).toEqual([
      '/profile',
    ]);
  });
});

/**
 * 書きかけ（元の行から変わっている）があるときだけ、切り替える・閉じる・離れる前に確認する
 * （#3349 / #3370）。書きかけが無ければ今までどおり確認なしで動く。
 */
describe('/profile 画面 — 書きかけを確認なしで捨てない', () => {
  async function startDirty() {
    stubProfile();
    renderScreen();
    fireEvent.click((await screen.findAllByRole('button', { name: / を編集する$/ }))[0]!);
    fireEvent.change(screen.getByLabelText('プロファイルの新しい本文'), {
      target: { value: 'export DRAFT=1\n' },
    });
  }
  const body = () => screen.getByLabelText<HTMLTextAreaElement>('プロファイルの新しい本文');

  it('書きかけのまま別の行の「編集する」を押すと確認が出る。やめれば書きかけが残る', async () => {
    await startDirty();
    fireEvent.click(screen.getAllByRole('button', { name: / を編集する$/ })[1]!);

    expect(await screen.findByRole('alertdialog')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'やめる' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(body().value).toBe('export DRAFT=1\n');
    expect(screen.getByLabelText<HTMLInputElement>('プロファイルの行の名前').value).toBe('base');
  });

  it('確認で「破棄して切り替える」を押すと、その行に切り替わる', async () => {
    await startDirty();
    fireEvent.click(screen.getAllByRole('button', { name: / を編集する$/ })[1]!);
    fireEvent.click(await screen.findByRole('button', { name: '破棄して切り替える' }));

    expect(body().value).toBe(RUST.script);
    expect(screen.getByLabelText<HTMLInputElement>('プロファイルの行の名前').value).toBe('rust');
  });

  it('書きかけが無ければ、確認なしで切り替わる', async () => {
    stubProfile();
    renderScreen();
    fireEvent.click((await screen.findAllByRole('button', { name: / を編集する$/ }))[0]!);
    fireEvent.click(screen.getAllByRole('button', { name: / を編集する$/ })[1]!);

    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.getByLabelText<HTMLInputElement>('プロファイルの行の名前').value).toBe('rust');
  });

  it('書きかけのまま「編集を閉じる」を押すと確認が出る。破棄すると閉じる', async () => {
    await startDirty();
    fireEvent.click(screen.getByRole('button', { name: '編集を閉じる' }));

    expect(await screen.findByRole('alertdialog')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'やめる' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(body().value).toBe('export DRAFT=1\n');

    fireEvent.click(screen.getByRole('button', { name: '編集を閉じる' }));
    fireEvent.click(await screen.findByRole('button', { name: '破棄して閉じる' }));
    expect(screen.queryByLabelText('プロファイルの新しい本文')).toBeNull();
  });

  it('書きかけが無ければ「編集を閉じる」は確認なしで閉じる', async () => {
    stubProfile();
    renderScreen();
    fireEvent.click((await screen.findAllByRole('button', { name: / を編集する$/ }))[0]!);
    fireEvent.click(screen.getByRole('button', { name: '編集を閉じる' }));

    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.queryByLabelText('プロファイルの新しい本文')).toBeNull();
  });

  it('書きかけのまま画面を離れると確認が出る。破棄すると移動する', async () => {
    await startDirty();
    fireEvent.click(screen.getByRole('link', { name: 'よその画面' }));

    expect(await screen.findByText('保存していない変更があります')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'やめる' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(body().value).toBe('export DRAFT=1\n');

    fireEvent.click(screen.getByRole('link', { name: 'よその画面' }));
    fireEvent.click(await screen.findByRole('button', { name: '破棄して離れる' }));
    expect(await screen.findByText('よその画面です')).toBeTruthy();
  });

  it('書きかけが無ければ確認なしで離れる', async () => {
    stubProfile();
    renderScreen();
    await screen.findByText('base');
    fireEvent.click(screen.getByRole('link', { name: 'よその画面' }));

    expect(await screen.findByText('よその画面です')).toBeTruthy();
  });

  it('beforeunload は書きかけのときだけ止める', async () => {
    stubProfile();
    renderScreen();
    fireEvent.click((await screen.findAllByRole('button', { name: / を編集する$/ }))[0]!);
    const clean = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(clean);
    expect(clean.defaultPrevented).toBe(false);

    fireEvent.change(screen.getByLabelText('プロファイルの新しい本文'), {
      target: { value: 'export DRAFT=1\n' },
    });
    const dirty = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(dirty);
    expect(dirty.defaultPrevented).toBe(true);
  });
});
