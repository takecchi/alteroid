// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { storeCredential, type Credential } from '@alteroid/logic';
import type { DaemonRevision, RunnerSummary } from '@alteroid/logic';
import { json, Providers, stubFetch, storeTestBaseUrl, TEST_BASE_URL } from '~/test-support';

import Settings, { RESET_CONFIRM_GROUPS_FOR_TEST, RESET_SUMMARY_LABELS } from './settings';

const BASE: RunnerSummary = {
  label: 'http://runner:4518',
  state: 'connected',
  since: '2026-08-22T00:00:00.000Z',
  runnerId: 'runner-primary',
  workspacePath: '/workspace',
  credentials: [],
  // 既定は「聞けた」に置く: instanceId 側の試験の結果を鍵欄の状態が動かさないため
  credentialsProbe: { status: 'asked' },
  profileProbe: { status: 'asked' },
  revision: { status: 'unheard' },
};

// instanceId の試験でも省略しない: 省ける形にすると「画面が読んでいない」と「デーモンが返していない」が試料の側で混ざるため
const DAEMON_UNKNOWN: DaemonRevision = { status: 'unknown' };

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

// 応答の形は生成 spec から導出する: 手で書いた形にすると、経路が変わってもこのテストだけが古いまま通るため
interface RunnersResponse {
  runners: RunnerSummary[];
  daemonRevision: DaemonRevision;
}

function renderSettings(response: RunnersResponse) {
  stubFetch((url) => {
    if (url.includes('/runners')) return json(response);
    if (url.includes('/auth/providers')) return json({ providers: [] });
    if (url.includes('/me')) return json({ status: 'open' });
    if (url.includes('/health')) return json({ ok: true });
    return json({});
  });
  const router = createMemoryRouter([{ path: '/', Component: Settings }], {
    initialEntries: ['/'],
  });
  render(
    <Providers>
      <RouterProvider router={router} />
    </Providers>,
  );
}

describe('runner の札は、いま応えているプロセスを出す', () => {
  it('名乗っているプロセスと、それを見始めた時刻を出す', async () => {
    renderSettings({
      runners: [{ ...BASE, instanceId: 'boot-2', instanceSince: '2026-08-22T03:04:00.000Z' }],
      daemonRevision: DAEMON_UNKNOWN,
    });

    const line = await screen.findByText(/プロセス: boot-2/);
    // 日付だけを見る: 時分は器の時間帯で変わり（手元は JST、CI は UTC）、この試料は JST でも UTC でも同じ日に落ちるため
    expect(line.textContent).toMatch(/08\/22.*から/);
  });

  it('名乗らない器では「判定できない」と書く', async () => {
    renderSettings({ runners: [BASE], daemonRevision: DAEMON_UNKNOWN });

    expect(
      await screen.findByText(/名乗っていない（入れ替わったかどうか判定できない）/),
    ).toBeTruthy();
  });
});

describe('runner の peer（Codex に作業を頼めるか。#3940）', () => {
  it('名乗った peer を「Codex に作業を頼める」とモデルつきで出す', async () => {
    renderSettings({
      runners: [
        {
          ...BASE,
          managerPeers: { status: 'named', peers: [{ provider: 'codex', models: ['gpt-5.5'] }] },
        },
      ],
      daemonRevision: DAEMON_UNKNOWN,
    });
    expect(await screen.findByText(/Codex に作業を頼める（モデル: gpt-5.5）/)).toBeTruthy();
  });

  it('名乗らない旧い runner は「不明」と出す', async () => {
    renderSettings({
      runners: [{ ...BASE, managerPeers: { status: 'unknown' } }],
      daemonRevision: DAEMON_UNKNOWN,
    });
    expect(await screen.findByText(/作業を頼めるか: 不明/)).toBeTruthy();
  });

  it('閉じている peer は理由つきで出す（#4118。ログイン済みなのに開いていない器の理由を見せる）', async () => {
    renderSettings({
      runners: [
        {
          ...BASE,
          managerPeers: {
            status: 'named',
            peers: [],
            closed: [{ provider: 'codex', reason: 'Codex の資格がこの器に届いていない' }],
          },
        },
      ],
      daemonRevision: DAEMON_UNKNOWN,
    });
    expect(
      await screen.findByText(
        /Codex に作業を頼めない（閉じている）: Codex の資格がこの器に届いていない/,
      ),
    ).toBeTruthy();
  });

  it('開閉のどちらも名乗らない器・欄の無い応答では何も出さない', async () => {
    renderSettings({
      runners: [
        { ...BASE, runnerId: 'runner-empty', managerPeers: { status: 'named', peers: [] } },
        { ...BASE, label: 'http://runner:4519', runnerId: 'runner-old-daemon' },
      ],
      daemonRevision: DAEMON_UNKNOWN,
    });
    await screen.findByText('runner-empty');
    await screen.findByText('runner-old-daemon');
    expect(screen.queryByText(/作業を頼める/)).toBeNull();
  });
});

describe('runner の since（この状態になった時刻）', () => {
  // 「この状態になった: 」とコロン込みで探す: ヘッダの注記が同じ語をコロン無しで使っており、findByText が2件ヒットして曖昧になるため
  it('since を出す', async () => {
    renderSettings({
      runners: [{ ...BASE, since: '2026-09-01T00:00:00.000Z' }],
      daemonRevision: DAEMON_UNKNOWN,
    });

    const line = await screen.findByText(/この状態になった: /);
    expect(line.textContent).toMatch(/09\/01/);
  });

  it('「作成」「更新」とは書かない', async () => {
    renderSettings({ runners: [BASE], daemonRevision: DAEMON_UNKNOWN });

    await screen.findByText(/この状態になった: /);
    expect(screen.queryByText(/作成/)).toBeNull();
    expect(screen.queryByText(/更新/)).toBeNull();
  });

  // getByText('再起動') を使わない: この画面には無関係な「再起動」が他にも在り、曖昧になるため
  it('名簿は保存されず、再起動で作り直されることを添える', async () => {
    renderSettings({ runners: [BASE], daemonRevision: DAEMON_UNKNOWN });

    expect(
      await screen.findByText(
        /「この状態になった」の時刻は保存されない.*再起動すると記録し直される/,
      ),
    ).toBeTruthy();
  });
});

const KNOWN_DAEMON: DaemonRevision = {
  status: 'known',
  commit: 'b'.repeat(40),
  short: 'b'.repeat(12),
  source: 'build',
};

describe('版の表示 — 人間もクローンと同じ材料を読める', () => {
  it('デーモンの版と runner の版を、同じ画面に並べて出す', async () => {
    renderSettings({
      runners: [
        {
          ...BASE,
          revision: {
            status: 'known',
            commit: 'a'.repeat(40),
            short: 'a'.repeat(12),
            source: 'platform',
          },
        },
      ],
      daemonRevision: KNOWN_DAEMON,
    });

    expect(await screen.findByText(new RegExp('a'.repeat(40)))).toBeTruthy();
    expect(screen.getByText(new RegExp('b'.repeat(40)))).toBeTruthy();
  });

  it('クローンの provider を出さない（層は常に Claude。2026-10-07 の決定）', async () => {
    renderSettings({ runners: [], daemonRevision: KNOWN_DAEMON });
    expect(await screen.findByText(new RegExp('b'.repeat(40)))).toBeTruthy();
    expect(screen.queryByText(/クローンが使うモデル提供元/)).toBeNull();
  });

  it('runner が0台でも、デーモンの版は出す', async () => {
    renderSettings({ runners: [], daemonRevision: KNOWN_DAEMON });

    expect(await screen.findByText(new RegExp('b'.repeat(40)))).toBeTruthy();
  });

  it('版の「不明」と「未確認」を、別の言葉で出す', async () => {
    renderSettings({
      runners: [
        { ...BASE, label: 'runner-knows-nothing', revision: { status: 'unknown' } },
        { ...BASE, label: 'runner-silent', state: 'unreachable', revision: { status: 'unheard' } },
      ],
      daemonRevision: DAEMON_UNKNOWN,
    });

    expect(await screen.findByText(/未確認/)).toBeTruthy();
    expect(screen.getAllByText(/不明/).length).toBeGreaterThan(0);
  });

  it('版が取れていないとき、sha らしきものを作らない', async () => {
    renderSettings({ runners: [], daemonRevision: DAEMON_UNKNOWN });

    const line = await screen.findByText(/^版: /);
    expect(line.textContent).not.toMatch(/[0-9a-f]{7,}/);
  });
});

describe('runner の鍵欄は、聞けた分しか言わない', () => {
  it('聞いていないときは『無い』と言わない', async () => {
    renderSettings({
      runners: [{ ...BASE, credentials: [], credentialsProbe: { status: 'unheard' } }],
      daemonRevision: DAEMON_UNKNOWN,
    });

    expect(await screen.findByText(/確かめていない/)).toBeTruthy();
    expect(screen.queryByText('渡している鍵は無い')).toBeNull();
  });

  it('失敗したときは理由が出る', async () => {
    renderSettings({
      runners: [
        {
          ...BASE,
          credentials: [],
          credentialsProbe: { status: 'failed', error: 'ECONNRESET: 途中で切れた' },
        },
      ],
      daemonRevision: DAEMON_UNKNOWN,
    });

    expect(await screen.findByText(/ECONNRESET: 途中で切れた/)).toBeTruthy();
    expect(screen.queryByText('渡している鍵は無い')).toBeNull();
  });

  it('聞いて0件なら『無い』と言う', async () => {
    renderSettings({
      runners: [{ ...BASE, credentials: [], credentialsProbe: { status: 'asked' } }],
      daemonRevision: DAEMON_UNKNOWN,
    });

    expect(await screen.findByText('渡している鍵は無い')).toBeTruthy();
  });
});

describe('runner のプロファイル欄は、聞けた分しか言わない', () => {
  it('聞いていないときは「置いていない」と言わない', async () => {
    renderSettings({
      runners: [{ ...BASE, profileProbe: { status: 'unheard' } }],
      daemonRevision: DAEMON_UNKNOWN,
    });

    expect(await screen.findByText(/プロファイルは確かめていない/)).toBeTruthy();
    expect(screen.queryByText('プロファイルは置いていない')).toBeNull();
  });

  it('失敗したときは理由が出る', async () => {
    renderSettings({
      runners: [{ ...BASE, profileProbe: { status: 'failed', error: 'ECONNRESET: 途中で切れた' } }],
      daemonRevision: DAEMON_UNKNOWN,
    });

    expect(await screen.findByText(/ECONNRESET: 途中で切れた/)).toBeTruthy();
    expect(screen.queryByText('プロファイルは置いていない')).toBeNull();
  });

  it('聞いて profile が無ければ「置いていない」と言う', async () => {
    renderSettings({
      runners: [{ ...BASE, profileProbe: { status: 'asked' } }],
      daemonRevision: DAEMON_UNKNOWN,
    });

    expect(await screen.findByText('プロファイルは置いていない')).toBeTruthy();
  });

  it('聞けて profile があれば指紋と更新時刻を出す', async () => {
    renderSettings({
      runners: [
        {
          ...BASE,
          profile: { sha256: 'abc123456789', bytes: 42, updatedAt: '2026-09-01T00:00:00.000Z' },
          profileProbe: { status: 'asked' },
        },
      ],
      daemonRevision: DAEMON_UNKNOWN,
    });

    const line = await screen.findByText(/abc123456789/);
    expect(line.textContent).toContain('プロファイル: 置いてある');
    expect(line.textContent).toMatch(/09\/01/);
  });
});

describe('runner の押し込み結果（pushHealth）', () => {
  it('pushHealth 自体が無ければ、押し込みの行を出さない', async () => {
    renderSettings({
      runners: [{ ...BASE }],
      daemonRevision: DAEMON_UNKNOWN,
    });

    await screen.findByText(BASE.label);
    expect(screen.queryByText(/押し込み/)).toBeNull();
  });

  it('成功した種類は ok、失敗した種類は理由付きで出て、互いを畳まない', async () => {
    renderSettings({
      runners: [
        {
          ...BASE,
          pushHealth: {
            profile: { status: 'ok', at: '2026-09-01T00:00:00.000Z' },
            credentials: {
              status: 'failed',
              at: '2026-09-01T00:00:05.000Z',
              error: 'ECONNRESET: 途中で切れた',
            },
            mcpServers: { status: 'ok', at: '2026-09-01T00:00:06.000Z' },
          },
        },
      ],
      daemonRevision: DAEMON_UNKNOWN,
    });

    expect(await screen.findByText(/プロファイル: 反映済み/)).toBeTruthy();
    expect(await screen.findByText(/環境変数: 反映に失敗/)).toBeTruthy();
    expect(await screen.findByText(/ECONNRESET: 途中で切れた/)).toBeTruthy();
    expect(await screen.findByText(/MCP の登録: 反映済み/)).toBeTruthy();
    // 押し込みバッジの文言そのもの（コロン区切り）で絞る: 認証トークン単独は他の静的文言にも現れるため
    expect(screen.queryByText(/認証トークン: 押し込み/)).toBeNull();
  });
});

describe('折り返しの付け忘れ（本2）', () => {
  it('runnerId（宛先の1行目）に break-all が付いている', async () => {
    renderSettings({
      runners: [{ ...BASE, runnerId: 'runner-primary' }],
      daemonRevision: DAEMON_UNKNOWN,
    });

    const el = await screen.findByText('runner-primary');
    expect(el.className.split(/\s+/)).toContain('break-all');
  });

  it('label（宛先の補助表示）に break-all が付いている', async () => {
    renderSettings({
      runners: [{ ...BASE, runnerId: 'runner-primary', label: 'http://runner:4518' }],
      daemonRevision: DAEMON_UNKNOWN,
    });

    const el = await screen.findByText('http://runner:4518');
    expect(el.className.split(/\s+/)).toContain('break-all');
  });

  it('workspacePath に break-all が付いている', async () => {
    renderSettings({
      runners: [{ ...BASE, workspacePath: '/very/long/workspace/path' }],
      daemonRevision: DAEMON_UNKNOWN,
    });

    const el = await screen.findByText('/very/long/workspace/path');
    expect(el.className.split(/\s+/)).toContain('break-all');
  });

  it('instanceId 混じり文（プロセス: ...）に break-words が付いている', async () => {
    renderSettings({
      runners: [{ ...BASE, instanceId: 'boot-2', instanceSince: '2026-08-22T03:04:00.000Z' }],
      daemonRevision: DAEMON_UNKNOWN,
    });

    const line = await screen.findByText(/プロセス: boot-2/);
    expect(line.className.split(/\s+/)).toContain('break-words');
  });

  it('runner.error に break-words が付いている', async () => {
    renderSettings({
      runners: [{ ...BASE, error: 'ETIMEDOUT: 応答が無い' }],
      daemonRevision: DAEMON_UNKNOWN,
    });

    const el = await screen.findByText('ETIMEDOUT: 応答が無い');
    expect(el.className.split(/\s+/)).toContain('break-words');
  });

  it('credentialsProbe が failed のときの理由に break-words が付いている', async () => {
    renderSettings({
      runners: [
        {
          ...BASE,
          credentials: [],
          credentialsProbe: { status: 'failed', error: 'ECONNRESET: 途中で切れた' },
        },
      ],
      daemonRevision: DAEMON_UNKNOWN,
    });

    const el = await screen.findByText(/ECONNRESET: 途中で切れた/);
    expect(el.className.split(/\s+/)).toContain('break-words');
  });

  it('資格情報バッジ（credential.name）に break-all が付いている', async () => {
    renderSettings({
      runners: [
        {
          ...BASE,
          credentials: [{ name: 'ANTHROPIC_API_KEY', sha256: 'a'.repeat(12), updatedAt: 'now' }],
          credentialsProbe: { status: 'asked' },
        },
      ],
      daemonRevision: DAEMON_UNKNOWN,
    });

    const badge = await screen.findByText('ANTHROPIC_API_KEY');
    expect(badge.className.split(/\s+/)).toContain('break-all');
  });
});

describe('横並びの積み替え（本4-A）: アカウントの dl', () => {
  it('狭い画面では1列、sm: 以上で固定幅ラベル列になる', async () => {
    renderSettings({ runners: [], daemonRevision: DAEMON_UNKNOWN });

    const anchor = await screen.findByText('アカウント');
    const dl = anchor.closest('dl');
    expect(dl).not.toBeNull();
    const dlTokens = dl!.className.split(/\s+/);
    expect(dlTokens).toContain('grid-cols-1');
    expect(dl!.style.getPropertyValue('--kv-label')).toBe('6rem');
    const smCols = dlTokens.filter((token) => token.startsWith('sm:grid-cols-'));
    expect(smCols).toHaveLength(1);
    expect(smCols[0]).toContain('var(--kv-label)');
    expect(dlTokens.filter((token) => /^grid-cols-/.test(token))).toEqual(['grid-cols-1']);
  });

  it('先頭以外の dt に上の余白と sm:mt-0 が付いている（積んだときの組の境目）', async () => {
    // renderAuthedAccount を使う: renderSettings の応答にはアカウントのメールが無く dt が1つだけになり、組の境目は2組以上ないと測れないため
    renderAuthedAccount(() => undefined);

    const anchor = await screen.findByText('アカウント');
    const dl = anchor.closest('dl');
    expect(dl).not.toBeNull();
    const dts = Array.from(dl!.querySelectorAll('dt'));
    expect(dts.length).toBeGreaterThan(1);
    const first = dts[0]!.className.split(/\s+/);
    expect(first).not.toContain('mt-3');
    expect(first).not.toContain('sm:mt-0');
    for (const dt of dts.slice(1)) {
      const tokens = dt.className.split(/\s+/);
      expect(tokens).toContain('mt-3');
      expect(tokens).toContain('sm:mt-0');
    }
  });
});

const AUTH_HEALTH = {
  ok: true,
  pid: 1,
  operator: false,
  storage: '/tmp/alteroid',
  auth: { enabled: true, providers: [{ id: 'google', label: 'Google', kind: 'oauth2' }] },
};

const CREDENTIAL: Credential = {
  token: 'alt_settings',
  account: { id: 'acc-1', displayName: null, email: 'me@example.com' },
  grantedAtClaim: true,
  createdAt: '2026-08-13T00:00:00.000Z',
};

function renderAuthedAccount(
  logoutRoute: (url: string) => Response | Promise<Response> | undefined,
) {
  storeCredential(TEST_BASE_URL, CREDENTIAL);
  stubFetch((url) => {
    if (url.includes('/runners')) return json({ runners: [], daemonRevision: DAEMON_UNKNOWN });
    if (url.endsWith('/health')) return json(AUTH_HEALTH);
    if (url.endsWith('/auth/me')) {
      return json({ kind: 'account', account: CREDENTIAL.account, granted: true });
    }
    const logoutResponse = logoutRoute(url);
    if (logoutResponse !== undefined) return logoutResponse;
    return json({});
  });
  const router = createMemoryRouter([{ path: '/', Component: Settings }], {
    initialEntries: ['/'],
  });
  render(
    <Providers>
      <RouterProvider router={router} />
    </Providers>,
  );
}

describe('Account のログアウト（issue #1757）', () => {
  it('成功 → サーバ側のトークンを失効させ、鍵を捨てる', async () => {
    renderAuthedAccount((url) => (url.endsWith('/auth/logout') ? json({ ok: true }) : undefined));

    const button = await screen.findByRole('button', { name: 'ログアウト' });
    fireEvent.click(button);

    await waitFor(() => {
      expect(localStorage.getItem(`alteroid.credential:${TEST_BASE_URL}`)).toBeNull();
    });
  });

  it('送信中は読み込み中になり、二度押しでも要求は1回だけ（#3738）', async () => {
    const logouts: string[] = [];
    renderAuthedAccount((url) => {
      if (!url.endsWith('/auth/logout')) return undefined;
      logouts.push(url);
      return new Promise<Response>(() => undefined);
    });

    const button = await screen.findByRole('button', { name: 'ログアウト' });
    fireEvent.click(button);
    fireEvent.click(button);

    await waitFor(() => expect(button.hasAttribute('disabled')).toBe(true));
    fireEvent.click(button);
    expect(logouts).toHaveLength(1);
  });

  it('失敗 → 鍵は残したままエラーを出し、「この画面から鍵だけを捨てる」で個別に捨てられる', async () => {
    renderAuthedAccount((url) =>
      url.endsWith('/auth/logout') ? json({ error: 'internal' }, 500) : undefined,
    );

    const button = await screen.findByRole('button', { name: 'ログアウト' });
    fireEvent.click(button);

    await screen.findByText(/サーバ側を失効させられなかった/);
    expect(localStorage.getItem(`alteroid.credential:${TEST_BASE_URL}`)).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'この画面から鍵だけを捨てる' }));

    await waitFor(() => {
      expect(localStorage.getItem(`alteroid.credential:${TEST_BASE_URL}`)).toBeNull();
    });
  });
});

describe('デーモンを止める（ShutdownDaemon）', () => {
  function renderWithShutdownStub(options: { shutdownStatus?: number } = {}) {
    const { shutdownStatus = 200 } = options;
    const stub = stubFetch((url) => {
      if (url.includes('/shutdown')) return json({ ok: true }, shutdownStatus);
      if (url.includes('/runners')) {
        return json({ runners: [], daemonRevision: DAEMON_UNKNOWN });
      }
      if (url.includes('/auth/providers')) return json({ providers: [] });
      if (url.includes('/me')) return json({ status: 'open' });
      if (url.includes('/health')) return json({ ok: true });
      return json({});
    });
    const router = createMemoryRouter([{ path: '/', Component: Settings }], {
      initialEntries: ['/'],
    });
    render(
      <Providers>
        <RouterProvider router={router} />
      </Providers>,
    );
    return stub;
  }

  function shutdownCallCount(stub: ReturnType<typeof stubFetch>): number {
    return stub.calls.filter((url) => url.includes('/shutdown')).length;
  }

  async function openShutdownDialog(): Promise<void> {
    fireEvent.click(await screen.findByRole('button', { name: 'alteroid のサーバを止める' }));
    await screen.findByPlaceholderText('stop');
  }

  it('【歯4】文言に「記憶も各種の記録も消さない」と Railway の再起動が載る', async () => {
    renderWithShutdownStub();

    expect(await screen.findByText(/記憶も各種の記録も消さない/)).toBeTruthy();
    expect(await screen.findByText(/再起動として働く/)).toBeTruthy();
  });

  it('【歯1】打つ文字が一致しないとボタンは押せず、/shutdown を呼ばない', async () => {
    const stub = renderWithShutdownStub();
    await openShutdownDialog();

    fireEvent.change(screen.getByPlaceholderText('stop'), { target: { value: 'sto' } });
    const confirmButton = screen.getByRole('button', { name: '止める' }) as HTMLButtonElement;
    expect(confirmButton.disabled).toBe(true);

    fireEvent.click(confirmButton);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(shutdownCallCount(stub)).toBe(0);
  });

  it('【歯2】一致すると押せて、押すと POST /shutdown を1回呼ぶ', async () => {
    const stub = renderWithShutdownStub();
    await openShutdownDialog();

    fireEvent.change(screen.getByPlaceholderText('stop'), { target: { value: 'stop' } });
    const confirmButton = screen.getByRole('button', { name: '止める' }) as HTMLButtonElement;
    expect(confirmButton.disabled).toBe(false);

    fireEvent.click(confirmButton);

    await screen.findByText(/止めました/);
    expect(shutdownCallCount(stub)).toBe(1);
    const entry = stub.entries.find((e) => e.url.includes('/shutdown'));
    expect(entry?.request?.method).toBe('POST');
  });

  it('【歯3・陽性対照】ResetWorkspace の確認語「reset」を打っても止めるボタンは押せない', async () => {
    renderWithShutdownStub();
    await openShutdownDialog();

    fireEvent.change(screen.getByPlaceholderText('stop'), { target: { value: 'reset' } });
    const confirmButton = screen.getByRole('button', { name: '止める' }) as HTMLButtonElement;
    expect(confirmButton.disabled).toBe(true);
  });
});

describe('ワークスペースのリセット（ResetWorkspace） — issue #2196', () => {
  function renderWithReset() {
    stubFetch((url) => {
      if (url.includes('/runners')) return json({ runners: [], daemonRevision: DAEMON_UNKNOWN });
      if (url.includes('/auth/providers')) return json({ providers: [] });
      if (url.includes('/me')) return json({ status: 'open' });
      if (url.includes('/health')) return json({ ok: true });
      return json({});
    });
    const router = createMemoryRouter([{ path: '/', Component: Settings }], {
      initialEntries: ['/'],
    });
    render(
      <Providers>
        <RouterProvider router={router} />
      </Providers>,
    );
  }

  it('カード本体の文に「仕事のやり方」が出る（ダイアログを開く前）', async () => {
    renderWithReset();

    // 「1件以上出るか」を見る: ダイアログ（未オープン）とカード本体の両方の <p> がこの文言を持ち、単数の findByText だと複数一致になるため
    const matches = await screen.findAllByText(/仕事のやり方/);
    expect(matches.length).toBeGreaterThan(0);
  });

  it('ダイアログを開いた確認の文にも「仕事のやり方」が出る', async () => {
    renderWithReset();

    fireEvent.click(await screen.findByRole('button', { name: 'リセットする' }));
    await screen.findByPlaceholderText('reset');

    const matches = await screen.findAllByText(/仕事のやり方/);
    expect(matches.length).toBeGreaterThan(0);
  });

  it('消した後の報告の見出し（RESET_SUMMARY_LABELS）が、全キーどこかの確認の group に載っている', () => {
    const covered = new Set(RESET_CONFIRM_GROUPS_FOR_TEST.flatMap((group) => group.keys));
    const labelKeys = RESET_SUMMARY_LABELS.map(([key]) => key);

    for (const key of labelKeys) {
      expect(covered.has(key), `${key} が確認の group に見当たらない`).toBe(true);
    }
    expect(covered.size).toBe(labelKeys.length);
  });
});

describe('runner を空ける（vacate）', () => {
  function renderWithVacate(runners: RunnerSummary[], vacateBody: object = { ok: true }) {
    const stub = stubFetch((url) => {
      if (url.includes('/runners/vacate')) return json(vacateBody);
      if (url.includes('/runners')) return json({ runners, daemonRevision: DAEMON_UNKNOWN });
      if (url.includes('/auth/providers')) return json({ providers: [] });
      if (url.includes('/me')) return json({ status: 'open' });
      if (url.includes('/health')) return json({ ok: true });
      return json({});
    });
    const router = createMemoryRouter([{ path: '/', Component: Settings }], {
      initialEntries: ['/'],
    });
    render(
      <Providers>
        <RouterProvider router={router} />
      </Providers>,
    );
    return stub;
  }

  it('確認の一手を挟むまで叩かず、確認したら runnerId を渡して POST /runners/vacate を叩く', async () => {
    const stub = renderWithVacate([BASE]);

    fireEvent.click(await screen.findByText('この実行環境から仕事を移す'));
    expect(stub.calls.some((url) => url.includes('/runners/vacate'))).toBe(false);

    fireEvent.click(screen.getByText('移すのをやめる'));
    expect(stub.calls.some((url) => url.includes('/runners/vacate'))).toBe(false);

    fireEvent.click(screen.getByText('この実行環境から仕事を移す'));
    fireEvent.click(screen.getByText('本当に移す'));
    expect(
      await screen.findByText(/仕事を他へ移す指示を出した。まだ終わってはいない/),
    ).toBeTruthy();

    const entry = stub.entries.find((e) => e.url.includes('/runners/vacate'));
    expect(entry).toBeDefined();
    expect(await entry?.request?.clone().json()).toEqual({ runnerId: 'runner-primary' });
  });

  it('「仕事を移す」まわりのボタンと確認の文に、どの実行環境か分かる名前が付く（#3372）', async () => {
    renderWithVacate([BASE]);
    fireEvent.click(await screen.findByRole('button', { name: 'runner-primary から仕事を移す' }));
    expect(screen.getByText(/runner-primary）で動いている委譲を止めて/)).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'runner-primary から仕事を移すのを確定する' }),
    ).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'runner-primary から仕事を移すのをやめる' }),
    ).toBeTruthy();
  });

  it('普通の成功には、握手を飛ばしたとは言わない（対照。#2376）', async () => {
    renderWithVacate([BASE]);
    fireEvent.click(await screen.findByText('この実行環境から仕事を移す'));
    fireEvent.click(screen.getByText('本当に移す'));
    expect(
      await screen.findByText(/仕事を他へ移す指示を出した。まだ終わってはいない/),
    ).toBeTruthy();
    expect(screen.queryByText(/引き継ぎの連絡は飛ばした/)).toBeNull();
  });

  it('握手を飛ばした応答（handshakeSkipped）には、飛ばしたことと呼び直しを言う（#2376）', async () => {
    renderWithVacate([BASE], {
      ok: true,
      handshakeSkipped: {
        reason: 'jobs_unreadable',
        message: '一覧を読めなかったので握手を飛ばした',
        retry: true,
      },
    });
    fireEvent.click(await screen.findByText('この実行環境から仕事を移す'));
    fireEvent.click(screen.getByText('本当に移す'));
    expect(
      await screen.findByText(/引き継ぎの連絡は飛ばした（一覧を読めなかったので握手を飛ばした）/),
    ).toBeTruthy();
  });

  it('仕事を他へ移している最中の器と、名乗っていない器には出さない', async () => {
    renderWithVacate([
      { ...BASE, state: 'vacating' },
      { ...BASE, label: 'http://runner-2:4518', runnerId: undefined, state: 'connecting' },
    ]);

    await screen.findByText('仕事を他へ移している最中');
    expect(screen.queryByText('この実行環境から仕事を移す')).toBeNull();
  });
});

describe('知らない runner の state に倒れ先がある（#2010）', () => {
  it('知らない state が混ざっても、他の runner の行は見え、その行は生の値を出す', async () => {
    renderSettings({
      runners: [
        { ...BASE, label: 'http://runner-good:4518', runnerId: 'runner-good' },
        {
          ...BASE,
          label: 'http://runner-bad:4518',
          runnerId: 'runner-bad',
          state: 'draining' as RunnerSummary['state'],
        },
      ],
      daemonRevision: DAEMON_UNKNOWN,
    });

    expect(await screen.findByText('runner-good')).toBeTruthy();
    expect(screen.getByText('runner-bad')).toBeTruthy();
    expect(screen.getByText('知らない状態（draining）')).toBeTruthy();
  });

  it('Object の継承したキーと同じ名前の state でも落ちない', async () => {
    renderSettings({
      runners: [
        {
          ...BASE,
          label: 'http://runner-proto:4518',
          runnerId: 'runner-proto',
          state: 'constructor' as RunnerSummary['state'],
        },
      ],
      daemonRevision: DAEMON_UNKNOWN,
    });

    expect(await screen.findByText('runner-proto')).toBeTruthy();
    expect(screen.getByText('知らない状態（constructor）')).toBeTruthy();
  });

  it('既知の state は今までどおりのラベルと tone で出す', async () => {
    renderSettings({
      runners: [{ ...BASE, state: 'unreachable' }],
      daemonRevision: DAEMON_UNKNOWN,
    });

    expect(await screen.findByText('繋がらない（つなぎ直しを試している）')).toBeTruthy();
  });
});

describe('実行中は窓の Esc（cancel）を止める — #3349', () => {
  function renderPending() {
    stubFetch((url) => {
      if (url.includes('/runners')) return json({ runners: [], daemonRevision: DAEMON_UNKNOWN });
      if (url.includes('/auth/providers')) return json({ providers: [] });
      if (url.includes('/me')) return json({ status: 'open' });
      if (url.includes('/health')) return json({ ok: true });
      return json({});
    });
    const stubbed = globalThis.fetch;
    let release!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      release = resolve;
    });
    let called = false;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('/shutdown') || url.includes('/reset')) {
        called = true;
        return pending;
      }
      return stubbed(input, init);
    }) as typeof fetch;
    const router = createMemoryRouter([{ path: '/', Component: Settings }], {
      initialEntries: ['/'],
    });
    render(
      <Providers>
        <RouterProvider router={router} />
      </Providers>,
    );
    return { release, wasCalled: () => called };
  }

  const cases = [
    { name: 'サーバを止める', open: 'alteroid のサーバを止める', word: 'stop', run: '止める' },
    { name: 'リセット', open: 'リセットする', word: 'reset', run: '本当に削除する' },
  ];

  for (const c of cases) {
    it(`${c.name}: 実行中は cancel を止め、終われば cancel は通る`, async () => {
      const { release, wasCalled } = renderPending();
      fireEvent.click(await screen.findByRole('button', { name: c.open }));
      const input = await screen.findByPlaceholderText(c.word);
      const dialog = input.closest('dialog')!;

      expect(fireEvent(dialog, new Event('cancel', { cancelable: true }))).toBe(true);

      fireEvent.change(input, { target: { value: c.word } });
      fireEvent.click(screen.getByRole('button', { name: c.run }));
      await waitFor(() => expect(wasCalled()).toBe(true));

      expect(fireEvent(dialog, new Event('cancel', { cancelable: true }))).toBe(false);

      release(json({ error: '失敗' }, 500));
      await waitFor(() =>
        expect(fireEvent(dialog, new Event('cancel', { cancelable: true }))).toBe(true),
      );
    });
  }
});
