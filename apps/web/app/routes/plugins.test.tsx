// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { json, Providers, storeTestBaseUrl } from '~/test-support';

import PluginsPage from './plugins';

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

const OLD_SHA = '1'.repeat(40);
const NEW_SHA = '2'.repeat(40);

const INSTALLED = {
  plugins: [
    {
      name: 'demo',
      source: {
        kind: 'url',
        url: 'https://example.com/o/demo.git',
        path: 'plugins/demo',
        sha: OLD_SHA,
      },
      scope: 'runner',
      enableHooks: false,
      enableMcp: true,
      contentSha256: 'c'.repeat(64),
      installedAt: '2026-09-20T00:00:00.000Z',
      installedBy: 'owner-account',
      fileCount: 3,
      totalBytes: 120,
    },
  ],
};

const EMPTY_PRESENCE = { present: false, paths: [] as string[] };

function summary(patch: Record<string, unknown> = {}) {
  return {
    name: 'demo',
    description: '新しいデモ',
    source: { kind: 'url', url: 'https://example.com/o/demo.git', sha: NEW_SHA },
    sha: NEW_SHA,
    fileCount: 2,
    totalBytes: 77,
    files: [
      { path: 'skills/a/SKILL.md', size: 50, executable: false },
      { path: 'skills/a/run.sh', size: 27, executable: true },
    ],
    counts: { skills: 1, agents: 0, commands: 0 },
    hooks: EMPTY_PRESENCE,
    modules: EMPTY_PRESENCE,
    lspServers: EMPTY_PRESENCE,
    mcp: EMPTY_PRESENCE,
    executables: { extracted: ['skills/a/run.sh'], notExtracted: [] },
    shellExecution: EMPTY_PRESENCE,
    skipped: [],
    extractorDrops: [],
    skillExcerpts: [{ path: 'skills/a/SKILL.md', excerpt: '# 見出し\n本文', truncated: false }],
    ...patch,
  };
}

const PREVIEW = {
  previewId: 'preview-1',
  expiresAt: '2026-09-21T00:10:00.000Z',
  summary: summary(),
};

type Reply = { status: number; body: unknown };

interface Calls {
  previews: unknown[];
  installs: unknown[];
  deletes: string[];
}

// 共有の stubFetch を使わない: openapi-fetch は fetch(new Request(...)) の形で呼ぶので method も本文も落ちるため
function stubPlugins(
  options: {
    list?: Reply;
    preview?: Reply;
    install?: Reply;
    remove?: Reply;
  } = {},
): Calls {
  const calls: Calls = { previews: [], installs: [], deletes: [] };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : null;
    const url = new URL(request?.url ?? (typeof input === 'string' ? input : String(input)));
    const method = request?.method ?? init?.method ?? 'GET';
    const read = async () =>
      (request !== null ? await request.json() : JSON.parse(String(init?.body))) as unknown;

    if (url.pathname === '/plugins/preview' && method === 'POST') {
      calls.previews.push(await read());
      const reply = options.preview ?? { status: 200, body: PREVIEW };
      return json(reply.body, reply.status);
    }
    if (url.pathname === '/plugins' && method === 'POST') {
      calls.installs.push(await read());
      const reply = options.install ?? {
        status: 200,
        body: {
          plugin: INSTALLED.plugins[0],
          appliesFrom: 'クローンの次のセッションから',
          runners: [],
        },
      };
      return json(reply.body, reply.status);
    }
    if (url.pathname.startsWith('/plugins/') && method === 'DELETE') {
      calls.deletes.push(decodeURIComponent(url.pathname.slice('/plugins/'.length)));
      const reply = options.remove ?? {
        status: 200,
        body: { name: 'demo', appliesFrom: '次のセッションから', runners: [] },
      };
      return json(reply.body, reply.status);
    }
    if (url.pathname === '/plugins' && method === 'GET') {
      const reply = options.list ?? { status: 200, body: INSTALLED };
      return json(reply.body, reply.status);
    }
    return Promise.reject(new TypeError(`Failed to fetch: ${url.href}`));
  }) as typeof fetch;
  return calls;
}

function renderScreen(entry = '/plugins') {
  const router = createMemoryRouter([{ path: '/plugins', Component: PluginsPage }], {
    initialEntries: [entry],
  });
  render(
    <Providers>
      <RouterProvider router={router} />
    </Providers>,
  );
}

function chooseUrl(url: string) {
  fireEvent.change(screen.getByLabelText('取り元の種類'), { target: { value: 'url' } });
  fireEvent.change(screen.getByLabelText('リポジトリの URL'), { target: { value: url } });
}

describe('/plugins 画面 — 一覧', () => {
  it('名前・説明・取り元・SHA の短縮・撒く先・フラグ・入れた人と日時を出す', async () => {
    stubPlugins();
    renderScreen();

    expect(await screen.findByText('demo')).toBeTruthy();
    expect(screen.getByText(/https:\/\/example\.com\/o\/demo\.git/)).toBeTruthy();
    expect(screen.getByText(/plugins\/demo/)).toBeTruthy();
    expect(screen.getByText(new RegExp(OLD_SHA.slice(0, 12)))).toBeTruthy();
    expect(screen.queryByText(new RegExp(OLD_SHA))).toBeNull();
    expect(screen.getByText('撒く先: runner')).toBeTruthy();
    expect(screen.getByText(/hooks: 無効/)).toBeTruthy();
    expect(screen.getByText(/\.mcp\.json: 有効/)).toBeTruthy();
    expect(screen.getByText(/owner-account/)).toBeTruthy();
    expect(screen.getByText(/次に開くまで残る/)).toBeTruthy();
  });

  it('一覧の行に説明を出す。説明の無い行は説明の欄を出さず、崩れない', async () => {
    const base = INSTALLED.plugins[0]!;
    stubPlugins({
      list: {
        status: 200,
        body: {
          plugins: [
            { ...base, name: 'with-desc', description: '画面に出る説明' },
            { ...base, name: 'without-desc' },
          ],
        },
      },
    });
    renderScreen();

    expect(await screen.findByText('with-desc')).toBeTruthy();
    expect(screen.getByText('without-desc')).toBeTruthy();
    expect(screen.getAllByText('画面に出る説明')).toHaveLength(1);
    expect(document.body.textContent).not.toContain('undefined');
  });

  it('一覧の説明は HTML として解釈せず、Markdown としても描かない', async () => {
    const hostile = '<img src=x onerror=alert(1)><script>boom()</script> **強調** # 見出し';
    stubPlugins({
      list: {
        status: 200,
        body: { plugins: [{ ...INSTALLED.plugins[0], description: hostile }] },
      },
    });
    renderScreen();
    await screen.findByText('demo');

    expect(document.querySelector('img')).toBeNull();
    expect(document.querySelector('script')).toBeNull();
    expect(document.querySelector('strong')).toBeNull();
    expect(document.querySelector('em')).toBeNull();
    expect(screen.getByText(hostile)).toBeTruthy();
    expect(screen.getAllByRole('heading', { level: 1 }).length).toBe(1);
  });

  it('入っていなければ「入っていない」と出す', async () => {
    stubPlugins({ list: { status: 200, body: { plugins: [] } } });
    renderScreen();
    expect(await screen.findByText('入っていない')).toBeTruthy();
  });

  it('403 は本文をそのまま出し、画面独自の判定はしない', async () => {
    stubPlugins({ list: { status: 403, body: { error: 'オーナーだけが操作できる' } } });
    renderScreen();
    expect(await screen.findByText('オーナーだけが操作できる')).toBeTruthy();
  });
});

describe('/plugins 画面 — 外す', () => {
  it('確認を出してから DELETE を呼び、「次に開くまで残る」を添える', async () => {
    const calls = stubPlugins();
    renderScreen();

    fireEvent.click(await screen.findByRole('button', { name: 'プラグイン demo を外す' }));
    expect(await screen.findByRole('alertdialog')).toBeTruthy();
    expect(calls.deletes).toEqual([]);

    fireEvent.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: '本当に外す' }),
    );
    await waitFor(() => expect(calls.deletes).toEqual(['demo']));
    expect(await screen.findByText(/プラグイン「demo」を外した/)).toBeTruthy();
  });

  it('確認で「やめる」を押すと呼ばない', async () => {
    const calls = stubPlugins();
    renderScreen();

    fireEvent.click(await screen.findByRole('button', { name: 'プラグイン demo を外す' }));
    fireEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'やめる' }),
    );
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(calls.deletes).toEqual([]);
  });
});

describe('/plugins 画面 — 入れる（プレビュー → 確定）', () => {
  it('「プレビュー」では入れず、要約を見せ、「入れる」で previewId・scope・フラグを送る（既定は all / false / false）', async () => {
    const calls = stubPlugins({ list: { status: 200, body: { plugins: [] } } });
    renderScreen();
    await screen.findByText('入っていない');

    fireEvent.change(screen.getByLabelText('plugin 名'), { target: { value: 'demo' } });
    fireEvent.click(screen.getByRole('button', { name: 'プレビュー' }));

    expect(await screen.findByText(/2 個 \/ 77 バイト/)).toBeTruthy();
    expect(calls.previews).toEqual([{ kind: 'marketplace', plugin: 'demo' }]);
    expect(calls.installs).toEqual([]);
    expect(screen.getByText(NEW_SHA)).toBeTruthy();
    expect(screen.getByText(/skills 1/)).toBeTruthy();
    expect(screen.getByText(/skills\/a\/run\.sh/, { selector: 'li' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '入れる' }));
    await waitFor(() => expect(calls.installs.length).toBe(1));
    expect(calls.installs[0]).toEqual({
      previewId: 'preview-1',
      scope: 'all',
      enableHooks: false,
      enableMcp: false,
    });
    expect(await screen.findByText(/プラグイン「demo」を入れた/)).toBeTruthy();
  });

  it('選んだ撒く先とフラグを送る', async () => {
    const calls = stubPlugins({ list: { status: 200, body: { plugins: [] } } });
    renderScreen();
    await screen.findByText('入っていない');

    fireEvent.change(screen.getByLabelText('plugin 名'), { target: { value: 'demo' } });
    fireEvent.click(screen.getByRole('button', { name: 'プレビュー' }));
    await screen.findByText(NEW_SHA);

    fireEvent.change(screen.getByLabelText('撒く先'), { target: { value: 'app' } });
    fireEvent.click(screen.getByLabelText(/hooks を有効にする/));
    fireEvent.click(screen.getByLabelText(/\.mcp\.json を有効にする/));
    fireEvent.click(screen.getByRole('button', { name: '入れる' }));
    await waitFor(() => expect(calls.installs.length).toBe(1));
    expect(calls.installs[0]).toEqual({
      previewId: 'preview-1',
      scope: 'app',
      enableHooks: true,
      enableMcp: true,
    });
  });

  it('hooks を含むときは目立つ警告を出し、有効にしても展開されないと書く', async () => {
    stubPlugins({
      preview: {
        status: 200,
        body: {
          ...PREVIEW,
          summary: summary({
            hooks: { present: true, paths: ['hooks/hooks.json'] },
            mcp: { present: true, paths: ['.mcp.json'] },
            shellExecution: { present: true, paths: ['skills/a/SKILL.md'] },
            executables: { extracted: [], notExtracted: ['bin/tool'] },
          }),
        },
      },
    });
    renderScreen();
    await screen.findByText('demo');

    fireEvent.change(screen.getByLabelText('plugin 名'), { target: { value: 'demo' } });
    fireEvent.click(screen.getByRole('button', { name: 'プレビュー' }));

    const warning = await screen.findByRole('alert', { name: /hooks/ });
    expect(warning.textContent).toContain('hooks/hooks.json');
    expect(warning.textContent).toMatch(/有効にしても展開されない/);
    expect(screen.getByText(/シェルを実行する記法/)).toBeTruthy();
    expect(screen.getByText(/bin\/tool/)).toBeTruthy();
  });

  it('同名がすでに入っていれば、置き換え（旧 SHA → 新 SHA）を出す', async () => {
    stubPlugins();
    renderScreen();
    await screen.findByText('demo');

    fireEvent.change(screen.getByLabelText('plugin 名'), { target: { value: 'demo' } });
    fireEvent.click(screen.getByRole('button', { name: 'プレビュー' }));

    expect(await screen.findByText(`置き換え: ${OLD_SHA} → ${NEW_SHA}`)).toBeTruthy();
  });

  it('預かりの期限切れ（404）では、プレビューからやり直す案内を出す', async () => {
    stubPlugins({
      list: { status: 200, body: { plugins: [] } },
      install: { status: 404, body: { error: 'プレビューが見つからない' } },
    });
    renderScreen();
    await screen.findByText('入っていない');

    fireEvent.change(screen.getByLabelText('plugin 名'), { target: { value: 'demo' } });
    fireEvent.click(screen.getByRole('button', { name: 'プレビュー' }));
    await screen.findByText(NEW_SHA);
    fireEvent.click(screen.getByRole('button', { name: '入れる' }));

    expect(await screen.findByText(/預かりの期限が切れた.*プレビューからやり直/)).toBeTruthy();
  });

  it('409（名前の衝突）と 5xx は本文をそのまま出す', async () => {
    stubPlugins({
      list: { status: 200, body: { plugins: [] } },
      install: { status: 409, body: { error: '同じ名前の plugin がある' } },
    });
    renderScreen();
    await screen.findByText('入っていない');

    fireEvent.change(screen.getByLabelText('plugin 名'), { target: { value: 'demo' } });
    fireEvent.click(screen.getByRole('button', { name: 'プレビュー' }));
    await screen.findByText(NEW_SHA);
    fireEvent.click(screen.getByRole('button', { name: '入れる' }));

    expect(await screen.findByText('同じ名前の plugin がある')).toBeTruthy();
  });

  it('runner への配布に失敗があれば、保存は済んでいることを添える', async () => {
    stubPlugins({
      list: { status: 200, body: { plugins: [] } },
      install: {
        status: 200,
        body: {
          plugin: INSTALLED.plugins[0],
          appliesFrom: '次のセッションから',
          runners: [
            { runnerId: 'runner-1', ok: true },
            { runnerId: 'runner-2', ok: false, error: '届かなかった' },
          ],
        },
      },
    });
    renderScreen();
    await screen.findByText('入っていない');

    fireEvent.change(screen.getByLabelText('plugin 名'), { target: { value: 'demo' } });
    fireEvent.click(screen.getByRole('button', { name: 'プレビュー' }));
    await screen.findByText(NEW_SHA);
    fireEvent.click(screen.getByRole('button', { name: '入れる' }));

    const note = await screen.findByRole('alert', { name: /一部の実行環境/ });
    expect(note.textContent).toMatch(/保存は済んでいる/);
    expect(screen.getByText(/runner-2/)).toBeTruthy();
  });

  it('外部由来の文字列は HTML として解釈しない', async () => {
    const hostile = '<img src=x onerror=alert(1)><script>boom()</script>';
    stubPlugins({
      preview: {
        status: 200,
        body: {
          ...PREVIEW,
          summary: summary({
            description: hostile,
            files: [{ path: `a/${hostile}`, size: 1, executable: false }],
            skillExcerpts: [
              { path: 'skills/a/SKILL.md', excerpt: `# ${hostile}`, truncated: true },
            ],
          }),
        },
      },
    });
    renderScreen();
    await screen.findByText('demo');

    fireEvent.change(screen.getByLabelText('plugin 名'), { target: { value: 'demo' } });
    fireEvent.click(screen.getByRole('button', { name: 'プレビュー' }));
    await screen.findByText(NEW_SHA);

    expect(document.querySelector('img')).toBeNull();
    expect(document.querySelector('script')).toBeNull();
    expect(document.body.textContent).toContain(hostile);
    // Markdown として描画しない: 「# 」は見出しにならず pre の素の文字で残る
    expect(screen.getByText(/^# </, { selector: 'pre' })).toBeTruthy();
    expect(screen.getAllByRole('heading', { level: 1 }).length).toBe(1);
  });
});

describe('/plugins 画面 — 入力の検査', () => {
  it('http・git@・owner/repo の取り元はプレビューへ送らない', async () => {
    const calls = stubPlugins({ list: { status: 200, body: { plugins: [] } } });
    renderScreen();
    await screen.findByText('入っていない');

    for (const bad of ['http://example.com/o/r', 'git@github.com:o/r.git', 'owner/repo']) {
      chooseUrl(bad);
      fireEvent.click(screen.getByRole('button', { name: 'プレビュー' }));
      expect(await screen.findByRole('alert', { name: '入力の誤り' })).toBeTruthy();
    }
    expect(calls.previews).toEqual([]);
  });

  it('marketplace では path・sha・ref を受けない', async () => {
    const calls = stubPlugins({ list: { status: 200, body: { plugins: [] } } });
    renderScreen('/plugins?marketplace=demo&sha=' + 'a'.repeat(40));
    await screen.findByText('入っていない');

    fireEvent.click(screen.getByRole('button', { name: 'プレビュー' }));
    expect(await screen.findByRole('alert', { name: '入力の誤り' })).toBeTruthy();
    expect(calls.previews).toEqual([]);
  });

  it('url の入力は path・ref・sha を添えて送る', async () => {
    const calls = stubPlugins({ list: { status: 200, body: { plugins: [] } } });
    renderScreen();
    await screen.findByText('入っていない');

    chooseUrl('https://example.com/o/r');
    fireEvent.change(screen.getByLabelText('path'), { target: { value: 'plugins/a' } });
    fireEvent.change(screen.getByLabelText('ref'), { target: { value: 'main' } });
    fireEvent.click(screen.getByRole('button', { name: 'プレビュー' }));

    await waitFor(() => expect(calls.previews.length).toBe(1));
    expect(calls.previews[0]).toEqual({
      kind: 'url',
      url: 'https://example.com/o/r',
      path: 'plugins/a',
      ref: 'main',
    });
  });
});

describe('/plugins 画面 — クエリでの事前入力', () => {
  it('?marketplace= は入力欄を埋めるだけで、プレビューも確定もしない', async () => {
    const calls = stubPlugins({ list: { status: 200, body: { plugins: [] } } });
    renderScreen('/plugins?marketplace=demo-plugin');
    await screen.findByText('入っていない');

    expect(screen.getByLabelText<HTMLInputElement>('plugin 名').value).toBe('demo-plugin');
    // 一覧の取得が済んだ後に確かめる: 自動で走るなら、取得と同じ流れで送られているはずのため
    expect(calls.previews).toEqual([]);
    expect(calls.installs).toEqual([]);
  });

  it('?url=&path=&ref=&sha= は url の入力欄を埋め、押すまで送らず、押せば同じ検査を通って送る', async () => {
    const calls = stubPlugins({ list: { status: 200, body: { plugins: [] } } });
    const sha = 'b'.repeat(40);
    renderScreen(
      `/plugins?url=${encodeURIComponent('https://example.com/o/r')}&path=p&ref=main&sha=${sha}`,
    );
    await screen.findByText('入っていない');

    expect(screen.getByLabelText<HTMLInputElement>('リポジトリの URL').value).toBe(
      'https://example.com/o/r',
    );
    expect(screen.getByLabelText<HTMLInputElement>('path').value).toBe('p');
    expect(screen.getByLabelText<HTMLInputElement>('ref').value).toBe('main');
    expect(screen.getByLabelText<HTMLInputElement>('sha').value).toBe(sha);
    expect(calls.previews).toEqual([]);

    fireEvent.click(screen.getByRole('button', { name: 'プレビュー' }));
    await waitFor(() => expect(calls.previews.length).toBe(1));
    expect(calls.installs).toEqual([]);
  });

  it('?url= が http なら、事前入力でも検査に落ちて送らない', async () => {
    const calls = stubPlugins({ list: { status: 200, body: { plugins: [] } } });
    renderScreen(`/plugins?url=${encodeURIComponent('http://example.com/o/r')}`);
    await screen.findByText('入っていない');

    fireEvent.click(screen.getByRole('button', { name: 'プレビュー' }));
    expect(await screen.findByRole('alert', { name: '入力の誤り' })).toBeTruthy();
    expect(calls.previews).toEqual([]);
  });
});
