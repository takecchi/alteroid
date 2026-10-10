// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { json, Providers, stubFetch, storeTestBaseUrl, TEST_BASE_URL } from '~/test-support';

import { ConnectionCard } from './connection';

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  localStorage.clear();
  storeTestBaseUrl();
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  vi.unstubAllEnvs();
});

function renderCard(health: { storage: string; pid: number }) {
  stubFetch((url) => {
    if (url.includes('/health')) {
      return json({
        ok: true,
        pid: health.pid,
        operator: false,
        auth: { enabled: false, providers: [] },
      });
    }
    if (url.includes('/status')) return json({ storage: health.storage });
    return undefined;
  });
  render(
    <Providers>
      <ConnectionCard />
    </Providers>,
  );
}

describe('折り返しの付け忘れ（本2）', () => {
  it('storage（記憶の置き場）に break-all が付いている', async () => {
    renderCard({ storage: '/very/long/path/to/the/memory/store', pid: 4242 });

    const el = await screen.findByText('/very/long/path/to/the/memory/store');
    expect(el.className.split(/\s+/)).toContain('break-all');
  });

  it('pid には break-all を付けていない（有界の小さい整数なので折り返しが要らない）', async () => {
    renderCard({ storage: '/data', pid: 4242 });

    const el = await screen.findByText('4242');
    expect(el.className.split(/\s+/)).not.toContain('break-all');
    expect(el.className.split(/\s+/)).toContain('font-mono');
  });
});

describe('横並びの積み替え（本4）', () => {
  it('A: dl は狭い画面で1列、sm: 以上で固定幅ラベル列になる', async () => {
    renderCard({ storage: '/data', pid: 4242 });

    const anchor = await screen.findByText('記憶');
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

  it('A: 先頭以外の dt に上の余白と sm:mt-0 が付いている（積んだときの組の境目）', async () => {
    renderCard({ storage: '/data', pid: 4242 });

    const anchor = await screen.findByText('記憶');
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
  it('C: 接続先の入力欄が min-w-0 flex-1 の div で包まれている', async () => {
    renderCard({ storage: '/data', pid: 4242 });

    const input = await screen.findByLabelText('接続先');
    const selectBox = input.closest('[data-slot="native-select-wrapper"]');
    expect(selectBox).not.toBeNull();
    expect(selectBox!.contains(input)).toBe(true);
    const wrapper = selectBox!.parentElement;
    expect(wrapper).not.toBeNull();
    const tokens = wrapper!.className.split(/\s+/);
    expect(tokens).toContain('min-w-0');
    expect(tokens).toContain('flex-1');
  });
});

describe('接続先の出どころを画面で区別する（本3）', () => {
  it('保存済みの値があれば「このブラウザに保存した接続先」', async () => {
    renderCard({ storage: '/data', pid: 1 });
    expect(await screen.findByText('このブラウザに保存した接続先')).toBeTruthy();
  });

  it('保存済みが無く、ビルド時の値があれば「このアプリに組み込まれた既定の接続先」', async () => {
    localStorage.clear();
    vi.stubEnv('VITE_ALTEROID_API_URL', 'https://build-time.example.com');
    stubFetch((url) => {
      if (url.includes('/health')) {
        return json({
          ok: true,
          pid: 1,
          operator: false,
          auth: { enabled: false, providers: [] },
        });
      }
      return undefined;
    });
    render(
      <Providers>
        <ConnectionCard />
      </Providers>,
    );
    expect(await screen.findByText('このアプリに組み込まれた既定の接続先')).toBeTruthy();
  });

  it('どちらも無ければ「この画面と同じ場所（既定）」', async () => {
    localStorage.clear();
    stubFetch(() => undefined);
    render(
      <Providers>
        <ConnectionCard />
      </Providers>,
    );
    expect(await screen.findByText('この画面と同じ場所（既定）')).toBeTruthy();
  });
});

describe('「既定に戻す」の表示（本3-3）', () => {
  it('ビルド時の値が在るとき、入力欄は /api ではなく実際に効く値になる', async () => {
    const BUILD_TIME_URL = 'https://build-time.example.com';
    vi.stubEnv('VITE_ALTEROID_API_URL', BUILD_TIME_URL);
    localStorage.setItem('alteroid.apiBaseUrl', TEST_BASE_URL);
    stubFetch((url) => {
      if (url.includes('/health')) {
        return json({
          ok: true,
          pid: 1,
          operator: false,
          auth: { enabled: false, providers: [] },
        });
      }
      return undefined;
    });
    render(
      <Providers>
        <ConnectionCard />
      </Providers>,
    );

    const input = await screen.findByLabelText<HTMLInputElement>('接続先');
    expect(input.value).toBe(TEST_BASE_URL);

    fireEvent.click(screen.getByRole('button', { name: '既定に戻す' }));

    await waitFor(() => {
      expect(localStorage.getItem('alteroid.apiBaseUrl')).toBeNull();
    });
    expect(input.value).toBe(BUILD_TIME_URL);
    expect(input.value).not.toBe('/api');
  });

  it('保存済みの値が無ければ「既定に戻す」は disabled（hasStoredApiBaseUrl の使い道）', async () => {
    localStorage.clear();
    stubFetch(() => undefined);
    render(
      <Providers>
        <ConnectionCard />
      </Providers>,
    );

    const button = await screen.findByRole<HTMLButtonElement>('button', { name: '既定に戻す' });
    expect(button.disabled).toBe(true);
  });

  it('保存すると「既定に戻す」が有効になる', async () => {
    renderCard({ storage: '/data', pid: 1 });

    const button = await screen.findByRole<HTMLButtonElement>('button', { name: '既定に戻す' });
    expect(button.disabled).toBe(false);
  });
});

function renderWithEndpoints(options: { buildTime?: string; respondTo?: string } = {}) {
  if (options.buildTime !== undefined) vi.stubEnv('VITE_ALTEROID_API_URL', options.buildTime);
  const target = options.respondTo;
  stubFetch((url) => {
    if (!url.includes('/health')) return undefined;
    if (target !== undefined && !url.startsWith(target)) return undefined;
    return json({
      ok: true,
      pid: 1,
      operator: false,
      auth: { enabled: false, providers: [] },
    });
  });
  render(
    <Providers>
      <ConnectionCard />
    </Providers>,
  );
}

function readOptions(
  select: HTMLSelectElement,
): Array<{ group: string; value: string; text: string }> {
  return Array.from(select.querySelectorAll('option')).map((option) => ({
    group: option.closest('optgroup')?.label ?? '',
    value: option.value,
    text: option.textContent ?? '',
  }));
}

describe('接続先を一覧から選ぶ', () => {
  it('ビルド時の値を複数並べる。名前を付けても URL は隠さない', async () => {
    localStorage.clear();
    renderWithEndpoints({
      buildTime: '本番=https://api.example.com,ローカル=http://127.0.0.1:4517',
    });

    const select = await screen.findByLabelText<HTMLSelectElement>('接続先');
    expect(readOptions(select)).toEqual([
      {
        group: '既定（このアプリに組み込み）',
        value: 'https://api.example.com',
        text: '本番 — https://api.example.com',
      },
      {
        group: '既定（このアプリに組み込み）',
        value: 'http://127.0.0.1:4517',
        text: 'ローカル — http://127.0.0.1:4517',
      },
      { group: 'この画面と同じ場所', value: '/api', text: '/api' },
    ]);
    expect(select.value).toBe('https://api.example.com');
  });

  it('選ぶと、その先へ切り替わって保存される', async () => {
    localStorage.clear();
    renderWithEndpoints({ buildTime: 'https://api.example.com,http://127.0.0.1:4517' });

    const select = await screen.findByLabelText<HTMLSelectElement>('接続先');
    fireEvent.change(select, { target: { value: 'http://127.0.0.1:4517' } });

    await waitFor(() => {
      expect(localStorage.getItem('alteroid.apiBaseUrl')).toBe('http://127.0.0.1:4517');
    });
    expect(select.value).toBe('http://127.0.0.1:4517');
  });

  it('一覧に無い接続先を選んでいても、一覧に出て選ばれた状態になる', async () => {
    localStorage.clear();
    localStorage.setItem('alteroid.apiBaseUrl', 'http://console-set.example');
    renderWithEndpoints({ buildTime: 'https://api.example.com' });

    const select = await screen.findByLabelText<HTMLSelectElement>('接続先');
    expect(select.value).toBe('http://console-set.example');
    expect(readOptions(select)).toContainEqual({
      group: 'このブラウザに保存',
      value: 'http://console-set.example',
      text: 'http://console-set.example',
    });
  });

  it('描画しただけで、その古い形の選択が一覧へ写る（切り替えても失われない）', async () => {
    localStorage.clear();
    localStorage.setItem('alteroid.apiBaseUrl', 'http://console-set.example');
    renderWithEndpoints({ buildTime: 'https://api.example.com' });

    const select = await screen.findByLabelText<HTMLSelectElement>('接続先');
    fireEvent.change(select, { target: { value: 'https://api.example.com' } });

    await waitFor(() => {
      expect(select.value).toBe('https://api.example.com');
    });
    expect(readOptions(select).map((option) => option.value)).toContain(
      'http://console-set.example',
    );
  });
});

describe('接続先を足す・直す・消す', () => {
  it('足すと一覧へ保存され、そのまま繋ぎに行く', async () => {
    renderWithEndpoints();

    fireEvent.change(await screen.findByLabelText('追加する接続先の名前（任意）'), {
      target: { value: '検証' },
    });
    fireEvent.change(screen.getByLabelText('追加する接続先の URL'), {
      target: { value: 'https://stg.example.com/' },
    });
    fireEvent.click(screen.getByRole('button', { name: '追加して接続' }));

    await waitFor(() => {
      expect(localStorage.getItem('alteroid.apiBaseUrl')).toBe('https://stg.example.com');
    });
    expect(JSON.parse(localStorage.getItem('alteroid.endpoints') ?? '[]')).toContainEqual({
      url: 'https://stg.example.com',
      label: '検証',
    });
    const select = screen.getByLabelText<HTMLSelectElement>('接続先');
    expect(select.value).toBe('https://stg.example.com');

    expect(screen.getByLabelText<HTMLInputElement>('追加する接続先の URL').value).toBe('');
    expect(screen.getByLabelText<HTMLInputElement>('追加する接続先の名前（任意）').value).toBe('');
  });

  it('名前は任意（空なら URL がそのまま出る）', async () => {
    renderWithEndpoints();

    fireEvent.change(await screen.findByLabelText('追加する接続先の URL'), {
      target: { value: 'https://stg.example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: '追加して接続' }));

    await waitFor(() => {
      expect(localStorage.getItem('alteroid.apiBaseUrl')).toBe('https://stg.example.com');
    });
    expect(JSON.parse(localStorage.getItem('alteroid.endpoints') ?? '[]')).toContainEqual({
      url: 'https://stg.example.com',
    });
  });

  it('接続先として使えない形は足さない。理由を画面に出す', async () => {
    renderWithEndpoints();

    fireEvent.change(await screen.findByLabelText('追加する接続先の URL'), {
      target: { value: 'example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: '追加して接続' }));

    expect(await screen.findByText(/接続先として使えない/)).toBeTruthy();
    expect(JSON.parse(localStorage.getItem('alteroid.endpoints') ?? '[]')).toEqual([
      { url: TEST_BASE_URL },
    ]);
    expect(localStorage.getItem('alteroid.apiBaseUrl')).toBe(TEST_BASE_URL);
  });

  it('空のまま押しても、何も起きずに促される', async () => {
    renderWithEndpoints();

    fireEvent.click(await screen.findByRole('button', { name: '追加して接続' }));

    expect(await screen.findByText('接続先の URL を入れてほしい')).toBeTruthy();
    expect(localStorage.getItem('alteroid.apiBaseUrl')).toBe(TEST_BASE_URL);
  });

  it('選んでいる接続先の名前を後から変えられる', async () => {
    renderWithEndpoints();

    fireEvent.click(await screen.findByRole('button', { name: '名前を変更' }));
    fireEvent.change(screen.getByLabelText('選択中の接続先の名前'), {
      target: { value: '手元のデーモン' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => {
      expect(JSON.parse(localStorage.getItem('alteroid.endpoints') ?? '[]')).toContainEqual({
        url: TEST_BASE_URL,
        label: '手元のデーモン',
      });
    });
    const select = screen.getByLabelText<HTMLSelectElement>('接続先');
    expect(readOptions(select)).toContainEqual({
      group: 'このブラウザに保存',
      value: TEST_BASE_URL,
      text: `手元のデーモン — ${TEST_BASE_URL}`,
    });
    expect(select.value).toBe(TEST_BASE_URL);
  });

  it('名前を書いている途中で別の保存済みの接続先を選ぶと、編集を閉じ、名前は付かない（#4011）', async () => {
    const other = 'https://stg.example.com';
    localStorage.setItem(
      'alteroid.endpoints',
      JSON.stringify([{ url: TEST_BASE_URL }, { url: other }]),
    );
    renderWithEndpoints();

    fireEvent.click(await screen.findByRole('button', { name: '名前を変更' }));
    fireEvent.change(screen.getByLabelText('選択中の接続先の名前'), {
      target: { value: '本番' },
    });
    fireEvent.change(screen.getByLabelText('接続先'), { target: { value: other } });

    await waitFor(() => {
      expect(localStorage.getItem('alteroid.apiBaseUrl')).toBe(other);
    });
    expect(screen.queryByLabelText('選択中の接続先の名前')).toBeNull();
    expect(screen.getByRole('button', { name: '名前を変更' })).toBeTruthy();
    expect(JSON.parse(localStorage.getItem('alteroid.endpoints') ?? '[]')).toEqual([
      { url: TEST_BASE_URL },
      { url: other },
    ]);
  });

  it('一覧から消すと、選択も既定へ戻る', async () => {
    renderWithEndpoints({ buildTime: 'https://api.example.com' });

    fireEvent.click(await screen.findByRole('button', { name: '一覧から削除' }));

    await waitFor(() => {
      expect(localStorage.getItem('alteroid.apiBaseUrl')).toBeNull();
    });
    expect(JSON.parse(localStorage.getItem('alteroid.endpoints') ?? '[]')).toEqual([]);
    const select = screen.getByLabelText<HTMLSelectElement>('接続先');
    expect(select.value).toBe('https://api.example.com');
    expect(readOptions(select).map((option) => option.value)).not.toContain(TEST_BASE_URL);
  });

  it('ビルド時の既定を選んでいるときは、名前変更も削除も出ない', async () => {
    localStorage.clear();
    renderWithEndpoints({ buildTime: 'https://api.example.com' });

    await screen.findByLabelText('接続先');
    expect(screen.queryByRole('button', { name: '名前を変更' })).toBeNull();
    expect(screen.queryByRole('button', { name: '一覧から削除' })).toBeNull();
  });

  it('同一オリジン（既定）を選んでいるときも、名前変更も削除も出ない', async () => {
    localStorage.clear();
    renderWithEndpoints();

    await screen.findByLabelText('接続先');
    expect(screen.queryByRole('button', { name: '名前を変更' })).toBeNull();
    expect(screen.queryByRole('button', { name: '一覧から削除' })).toBeNull();
  });
});

describe('接続先の入力欄は、IME の確定の ⌘/Ctrl + Enter と Enter 単体では送らない', () => {
  it('追加: 名前の欄の変換中の ⌘ + Enter と Enter 単体では足さず、確定後の ⌘ + Enter で足す', async () => {
    renderWithEndpoints();

    fireEvent.change(screen.getByLabelText('追加する接続先の URL'), {
      target: { value: 'https://stg.example.com' },
    });
    const label = await screen.findByLabelText('追加する接続先の名前（任意）');
    fireEvent.change(label, { target: { value: 'けんしょう' } });

    fireEvent.keyDown(label, { key: 'Enter', metaKey: true, isComposing: true });
    fireEvent.keyDown(label, { key: 'Enter', metaKey: true, keyCode: 229 });
    expect(localStorage.getItem('alteroid.apiBaseUrl')).toBe(TEST_BASE_URL);

    fireEvent.change(label, { target: { value: '検証' } });
    fireEvent.keyDown(label, { key: 'Enter' });
    fireEvent.keyDown(label, { key: 'Enter', shiftKey: true });
    expect(localStorage.getItem('alteroid.apiBaseUrl')).toBe(TEST_BASE_URL);
    fireEvent.keyDown(label, { key: 'Enter', metaKey: true });
    await waitFor(() => {
      expect(localStorage.getItem('alteroid.apiBaseUrl')).toBe('https://stg.example.com');
    });
    expect(JSON.parse(localStorage.getItem('alteroid.endpoints') ?? '[]')).toContainEqual({
      url: 'https://stg.example.com',
      label: '検証',
    });
  });

  it('追加: URL の欄の変換中の ⌘ + Enter と Enter 単体でも足さない', async () => {
    renderWithEndpoints();

    const url = await screen.findByLabelText('追加する接続先の URL');
    fireEvent.change(url, { target: { value: 'https://stg.example.com' } });
    fireEvent.keyDown(url, { key: 'Enter', metaKey: true, isComposing: true });
    fireEvent.keyDown(url, { key: 'Enter' });
    expect(localStorage.getItem('alteroid.apiBaseUrl')).toBe(TEST_BASE_URL);

    fireEvent.keyDown(url, { key: 'Enter', ctrlKey: true });
    await waitFor(() => {
      expect(localStorage.getItem('alteroid.apiBaseUrl')).toBe('https://stg.example.com');
    });
  });

  it('名前の変更: 変換中の ⌘ + Enter と Enter 単体では保存せず、確定後の ⌘ + Enter で保存する', async () => {
    renderWithEndpoints();

    fireEvent.click(await screen.findByRole('button', { name: '名前を変更' }));
    const input = screen.getByLabelText('選択中の接続先の名前');
    fireEvent.change(input, { target: { value: 'てもと' } });
    fireEvent.keyDown(input, { key: 'Enter', metaKey: true, isComposing: true });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(screen.getByLabelText('選択中の接続先の名前')).toBeTruthy();
    expect(JSON.parse(localStorage.getItem('alteroid.endpoints') ?? '[]')).toEqual([
      { url: TEST_BASE_URL },
    ]);

    fireEvent.change(input, { target: { value: '手元' } });
    fireEvent.keyDown(input, { key: 'Enter', metaKey: true });
    await waitFor(() => {
      expect(JSON.parse(localStorage.getItem('alteroid.endpoints') ?? '[]')).toContainEqual({
        url: TEST_BASE_URL,
        label: '手元',
      });
    });
  });
});

describe('説明文の言い方（#2782）', () => {
  function visibleText(): string {
    const clone = document.body.cloneNode(true) as HTMLElement;
    clone.querySelectorAll('details > :not(summary)').forEach((el) => el.remove());
    return clone.textContent ?? '';
  }

  it('本文に CORS・ヘッダ名・API のパス・ビルド時の環境変数が出ない', async () => {
    renderCard({ storage: '/data', pid: 4242 });
    await screen.findByText('4242');

    const text = visibleText();
    for (const word of ['CORS', 'Authorization', 'Bearer', 'curl', 'VITE_']) {
      expect(text).not.toContain(word);
    }
    expect(text).toContain('（ALTEROID_ALLOWED_ORIGINS）');
    expect(text).toContain('この画面を開いているブラウザの場所');
    expect(text).toContain('/data');
    expect(text).toContain('4242');
  });

  it('開発者向けの詳細の先には、従来の技術的な説明が残る', async () => {
    renderCard({ storage: '/data', pid: 4242 });
    await screen.findByText('4242');

    const details = document.querySelector('details');
    expect(details?.querySelector('summary')?.textContent).toBe('開発者向けの詳細');
    expect(details?.textContent).toContain('CORS');
    expect(details?.textContent).toContain('VITE_ALTEROID_API_URL');
  });
});

describe('記憶の行は認証の後ろの /status から取る（#2869）', () => {
  it('取れたとき、/status の storage を出す（/health には storage が無い）', async () => {
    renderCard({ storage: '/srv/alteroid', pid: 1 });
    expect(await screen.findByText('/srv/alteroid')).toBeTruthy();
  });

  it('取れないとき（401）は例外にせず「取得できません」と言い、カードは残る', async () => {
    stubFetch((url) => {
      if (url.includes('/health')) {
        return json({ ok: true, pid: 1, operator: false, auth: { enabled: true, providers: [] } });
      }
      if (url.includes('/status')) return json({ error: 'unauthorized' }, 401);
      return undefined;
    });
    render(
      <Providers>
        <ConnectionCard />
      </Providers>,
    );
    expect(await screen.findByText('取得できません（ログインが要る場合があります）')).toBeTruthy();
    expect(screen.getByText('応答あり')).toBeTruthy();
  });
});

describe('置き場の取り直しの失敗（issue #3092）', () => {
  it('取れたあとの /status の取り直しが失敗しても、置き場は残したまま、失敗を言う。通れば消える', async () => {
    let statusFailing = false;
    stubFetch((url) => {
      if (url.includes('/health')) {
        return json({
          ok: true,
          pid: 1,
          operator: false,
          auth: { enabled: false, providers: [] },
        });
      }
      if (url.includes('/status')) {
        return statusFailing ? json({ error: 'internal' }, 500) : json({ storage: '/data/store' });
      }
      return undefined;
    });
    render(
      <Providers>
        <ConnectionCard />
      </Providers>,
    );
    expect(await screen.findByText('/data/store')).toBeTruthy();
    expect(screen.queryByText(/取り直せなかった/)).toBeNull();

    statusFailing = true;
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(await screen.findByText(/取り直せなかった/)).toBeTruthy();
    expect(screen.getByText('/data/store')).toBeTruthy();

    statusFailing = false;
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    await waitFor(() => expect(screen.queryByText(/取り直せなかった/)).toBeNull());
    expect(screen.getByText('/data/store')).toBeTruthy();
  });
});
