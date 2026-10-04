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
 *    で初めて、編集した本文・撒く先をそのまま送る
 * 3. **400 のときは `detail` まで見せる。** 直すのに要るのは行番号込みの `detail` で、
 *    共有の `unwrap` が拾う `error` だけでは直せない
 * 4. **外すのは行ごとの `DELETE /profile/:name`**（確認を挟む）
 * 5. **403 は本文で出し分ける。** `requireOwner` の本文のときだけ持ち主の宣言を
 *    案内し、それ以外の 403 には案内を出さない
 * 6. **撒く先は環境変数の画面と同じ3値・同じ言い方。** 既定は共通（all）
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
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
  runners: [{ runnerId: 'runner-1', ok: false, error: 'runner に届かなかった' }],
};

type Reply = { status: number; body: unknown };

/**
 * `/profile` の stub。**共有の `stubFetch` は使えない**（`openapi-fetch` は
 * `fetch(new Request(...))` の形で呼ぶので、method も本文も落ちる。
 * `env-vars.test.tsx` の同じ断り書きと同じ理由）。
 */
function stubProfile(options: { rows?: Row[]; get?: Reply; put?: Reply; del?: Reply } = {}) {
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
  render(
    <Providers>
      <MemoryRouter>
        <Profile />
      </MemoryRouter>
    </Providers>,
  );
}

describe('/profile 画面 — 読む', () => {
  it('行の一覧（名前・撒く先・バイト数・指紋）と合成後の指紋を出すが、本文は「本文を表示する」を押すまで出さない', async () => {
    stubProfile();
    renderScreen();

    expect(await screen.findByText('base')).toBeTruthy();
    expect(screen.getByText('rust')).toBeTruthy();
    // 撒く先は環境変数の画面と同じ言い方。
    expect(screen.getByText('共通')).toBeTruthy();
    expect(screen.getByText('manager')).toBeTruthy();
    expect(screen.getByText('41 バイト')).toBeTruthy();
    expect(screen.getByText(/sha256=a{12}/)).toBeTruthy();
    expect(screen.getByText('c'.repeat(12))).toBeTruthy();
    expect(screen.getByText('d'.repeat(12))).toBeTruthy();
    // 名前の辞書順につなげて効くことを画面に書く。
    expect(screen.getByText(/名前の辞書順/)).toBeTruthy();
    expect(document.body.textContent).not.toContain('very-secret-value');

    fireEvent.click(screen.getAllByRole('button', { name: '本文を表示する' })[0]!);
    expect(screen.getByLabelText('プロファイルの行 base の本文').textContent).toContain(
      SECRET_LINE,
    );

    fireEvent.click(screen.getByRole('button', { name: '本文を隠す' }));
    expect(document.body.textContent).not.toContain('very-secret-value');
  });

  it('置かれていなければ「置かれていない」と出し、行を追加するボタンがある', async () => {
    stubProfile({ rows: [] });
    renderScreen();

    expect(await screen.findByText('置かれていない')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '本文を表示する' })).toBeNull();
    expect(screen.getByRole('button', { name: '行を追加する' })).toBeTruthy();
  });

  it('知らない撒く先でも落ちず、そのまま出す（サーバのほうが新しい窓が在る）', async () => {
    stubProfile({ rows: [{ ...BASE, scope: 'future-scope' }] });
    renderScreen();

    expect(await screen.findByText('未知の撒く先（future-scope）')).toBeTruthy();
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
    expect(screen.queryByRole('button', { name: '行を追加する' })).toBeNull();
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

describe('/profile 画面 — 行を置く', () => {
  it('「編集する」は、その行の本文・撒く先を流し込み、名前は変えられない', async () => {
    stubProfile();
    renderScreen();

    fireEvent.click((await screen.findAllByRole('button', { name: '編集する' }))[1]!);

    expect(screen.getByLabelText<HTMLTextAreaElement>('プロファイルの新しい本文').value).toBe(
      RUST.script,
    );
    expect(screen.getByLabelText<HTMLSelectElement>('プロファイルの撒く先').value).toBe('runner');
    const name = screen.getByLabelText<HTMLInputElement>('プロファイルの行の名前');
    expect(name.value).toBe('rust');
    expect(name.disabled).toBe(true);
  });

  it('「保存する」だけでは PUT を叩かず、「本当に保存する」で名前・撒く先・本文をそのまま送る', async () => {
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
    fireEvent.change(screen.getByLabelText('プロファイルの撒く先'), {
      target: { value: 'runner' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存する' }));
    expect(puts).toEqual([]);
    expect(screen.getByText(/マネージャー・作業者だけへ配る/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '本当に保存する' }));

    expect(await screen.findByText(/プロファイルの行 rust を更新した。/)).toBeTruthy();
    expect(puts).toEqual([{ name: 'rust', body: { script: next, scope: 'runner' } }]);
    // 合成後の指紋と、反映できなかった runner を小さく出さない。
    expect(screen.getByText(/クローン用 e{12} \/ runner 用 f{12}/)).toBeTruthy();
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

  it('本文を変えなくても、撒く先を変えれば保存できる（外れる側が出るので更新である）', async () => {
    stubProfile();
    renderScreen();

    fireEvent.click((await screen.findAllByRole('button', { name: '編集する' }))[0]!);
    expect(screen.getByRole('button', { name: '保存する' }).hasAttribute('disabled')).toBe(true);

    fireEvent.change(screen.getByLabelText('プロファイルの撒く先'), { target: { value: 'app' } });

    expect(screen.getByRole('button', { name: '保存する' }).hasAttribute('disabled')).toBe(false);
  });

  it('確認で「保存をやめる」を押せば PUT を叩かない', async () => {
    const { puts } = stubProfile();
    renderScreen();

    fireEvent.click((await screen.findAllByRole('button', { name: '編集する' }))[0]!);
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

    fireEvent.click((await screen.findAllByRole('button', { name: '編集する' }))[0]!);
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

  it('PUT が requireOwner の 403 なら、持ち主として宣言する手を案内する', async () => {
    stubProfile({
      put: {
        status: 403,
        body: { error: '実行環境の持ち主として宣言されたアカウントだけが操作できる' },
      },
    });
    renderScreen();

    fireEvent.click((await screen.findAllByRole('button', { name: '編集する' }))[0]!);
    fireEvent.change(screen.getByLabelText('プロファイルの新しい本文'), {
      target: { value: 'export A=1\n' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存する' }));
    fireEvent.click(screen.getByRole('button', { name: '本当に保存する' }));

    expect(await screen.findAllByText('alteroid access owner <アカウント id>')).toBeTruthy();
  });
});

describe('/profile 画面 — 行を外す', () => {
  it('「この行を外す」は確認を挟んでから、その行だけの DELETE を送る', async () => {
    const { deletes } = stubProfile();
    renderScreen();

    fireEvent.click((await screen.findAllByRole('button', { name: 'この行を外す' }))[1]!);
    expect(deletes).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: '本当に外す' }));

    expect(await screen.findByText(/プロファイルの行 rust を外した。/)).toBeTruthy();
    expect(deletes).toEqual(['rust']);
  });

  it('確認で「外すのをやめる」を押せば DELETE を叩かない', async () => {
    const { deletes } = stubProfile();
    renderScreen();

    fireEvent.click((await screen.findAllByRole('button', { name: 'この行を外す' }))[0]!);
    fireEvent.click(screen.getByRole('button', { name: '外すのをやめる' }));

    expect(deletes).toEqual([]);
    expect(screen.queryByRole('button', { name: '本当に外す' })).toBeNull();
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

  it('落ちずに default 1行として本文が見え、デーモンが古い旨を出す。指紋・撒く先は消さない', async () => {
    stubOldDaemon();
    renderScreen();

    expect(await screen.findByText('default')).toBeTruthy();
    expect(screen.getByText(/デーモンが古い/)).toBeTruthy();
    expect(screen.getByText('共通')).toBeTruthy();
    expect(screen.getByText('41 バイト')).toBeTruthy();
    expect(screen.getByText(/sha256=o{12}/)).toBeTruthy();
    // 本文は今までどおり、押すまで出さない。押せば1文字も欠けずに見える。
    expect(document.body.textContent).not.toContain('very-secret-value');
    fireEvent.click(screen.getByRole('button', { name: '本文を表示する' }));
    expect(screen.getByLabelText('プロファイルの行 default の本文').textContent).toContain(
      SECRET_LINE,
    );
  });

  it('行ごとの書き込み（外す・追加）は出さない', async () => {
    stubOldDaemon();
    renderScreen();

    await screen.findByText('default');
    expect(screen.queryByRole('button', { name: 'この行を外す' })).toBeNull();
    // default が既に在るので、行の追加ボタンも出ない。
    expect(screen.queryByRole('button', { name: '行を追加する' })).toBeNull();
  });

  it('本文の編集は従来の PUT /profile {script} へ倒れる（名前・撒く先は固定）', async () => {
    const { calls } = stubOldDaemon();
    renderScreen();

    fireEvent.click(await screen.findByRole('button', { name: '編集する' }));
    expect(screen.getByLabelText<HTMLInputElement>('プロファイルの行の名前').disabled).toBe(true);
    expect(screen.getByLabelText<HTMLSelectElement>('プロファイルの撒く先').disabled).toBe(true);
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
