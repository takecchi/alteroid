// @vitest-environment jsdom
/**
 * 接続先カード（`ConnectionCard`）。
 *
 * 折り返しの付け忘れ（本2）を固定する。`storage`（記憶の置き場。ローカルの
 * パスか PostgreSQL の接続先ラベル、`apps/daemon/src/openapi.ts` の
 * `healthResponseSchema`）は空白を持たないことが多いパス/ラベルなので
 * `break-all` を当てた。`pid`（`z.number().int()` ＝ `process.pid`）は
 * Linux の `pid_max` 既定でも7桁までしか無い有界の小さい整数で、このセクション
 * の幅では折り返しが要る長さにならないため、意図して据え置いている
 * （この不在も戻す変更を黙って通さないために固定する）。
 *
 * **⚠️ これは「はみ出しが直った」ことの試験ではない。** jsdom はレイアウトを
 * 持たないので（`offsetWidth` / `scrollWidth` / `getBoundingClientRect()` は
 * すべて 0）、固定できるのは「そのクラス名が書かれていること」までである。
 *
 * この画面には、これまでテストが無かった。
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
        storage: health.storage,
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
    // クラス自体は font-mono のまま残っていること（無指定に落ちていないか）。
    expect(el.className.split(/\s+/)).toContain('font-mono');
  });
});

/**
 * 横並びの積み替え（本4）。
 *
 * **A: `dl`（`grid-cols-[6rem_1fr]`）が breakpoint 無しで固定されていた。**
 * 375px 幅でもラベル列（6rem）が値の取り分を持っていくので、`sm:` 未満は
 * 1列、`sm:` 以上で固定幅ラベル列に切り替える。積んだときに `dt`/`dd` の
 * 対応が読めるよう、`dt` に `mt-3 first:mt-0 sm:mt-0` を足して組の境目を
 * 間隔の差で表す。
 *
 * **C: 「接続先」入力欄がボタン2つとの取り合いで潰れうる。** `input` は
 * フォームコントロールの既定の最小幅を持ち、本3で `Button` が狭い画面で
 * `h-11`（44px）になった分、この行の取り合いは悪化している。`chat.tsx` の
 * `Textarea` と同じ形（`<div className="min-w-0 flex-1">` で包む）に揃えた。
 *
 * **⚠️ どちらも「積み替わった」「潰れなくなった」ことの試験ではない。**
 * jsdom はレイアウトを持たない（`offsetWidth` / `scrollWidth` /
 * `getBoundingClientRect()` はすべて 0）ので、breakpoint が実際に効いて
 * いることも、flex の縮み方が変わったことも、ここでは1つも観測できない。
 * 固定できるのは「そのクラス名が書かれていること」までである。本2・本3 の
 * テストより歯が弱い。
 */
describe('横並びの積み替え（本4）', () => {
  it('A: dl は狭い画面で1列、sm: 以上で固定幅ラベル列になる', async () => {
    renderCard({ storage: '/data', pid: 4242 });

    const dt = await screen.findByText('記憶');
    const dl = dt.closest('dl');
    expect(dl).not.toBeNull();
    const dlTokens = dl!.className.split(/\s+/);
    expect(dlTokens).toContain('grid-cols-1');
    expect(dlTokens).toContain('sm:grid-cols-[6rem_1fr]');
    expect(dlTokens).not.toContain('grid-cols-[6rem_1fr]');
  });

  it('A: dt に mt-3 first:mt-0 sm:mt-0 が付いている（積んだときの組の境目）', async () => {
    renderCard({ storage: '/data', pid: 4242 });

    const dt = await screen.findByText('記憶');
    const tokens = dt.className.split(/\s+/);
    expect(tokens).toContain('mt-3');
    expect(tokens).toContain('first:mt-0');
    expect(tokens).toContain('sm:mt-0');
  });

  it('C: 接続先の入力欄が min-w-0 flex-1 の div で包まれている', async () => {
    renderCard({ storage: '/data', pid: 4242 });

    const input = await screen.findByLabelText('接続先');
    const wrapper = input.parentElement;
    expect(wrapper).not.toBeNull();
    const tokens = wrapper!.className.split(/\s+/);
    expect(tokens).toContain('min-w-0');
    expect(tokens).toContain('flex-1');
  });
});

/**
 * PR 1 の本3: 3つの出どころ（`resolveApiBaseUrlOrigin` の 'stored' /
 * 'buildTime' / 'sameOrigin'）を画面の文言で区別する——**これがこの PR で
 * いちばん大事な歯である**（依頼文より）。文言はオーナーが読む画面の語なので、
 * 「段」「解決」のような実装側の語ではなく、画面に出す逐語で照合する。
 */
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
          storage: '/data',
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

/**
 * 本3の(3): 「既定に戻す」が嘘をつく件を直す。
 *
 * ビルド時の値（`VITE_ALTEROID_API_URL`）が在るとき、`storeApiBaseUrl(null)` の
 * 後に実際に効く接続先はそちらである。以前は入力欄を無条件に `SAME_ORIGIN_BASE_URL`
 * （`/api`）へ戻していたので、実際の接続先と表示が食い違っていた。
 */
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
          storage: '/data',
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
    // ここが本体: /api ではなく、ビルド時の値が入っていること。
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

/**
 * 接続先を「複数持って、選ぶ」形にした分（このカードの本体の変更）。
 *
 * **これまでは入力欄1つだった。** 切り替えるたびに URL を打ち直すことになり、
 * 打ち間違いが「繋がらない」として返ってくるうえ、間違えた側の値は既に上書き
 * されているので元へ戻るにももう一度打ち直すしかなかった。
 *
 * ⚠️ ここで固定するのは**一覧の中身と、選ぶ／足す／直す／消すが実際に
 * `localStorage` に効くこと**である。見た目（幅・折り返し）は上の本2・本4 が
 * 見ており、jsdom では観測できない（レイアウトを持たないため）。
 */
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
      storage: '/data',
      auth: { enabled: false, providers: [] },
    });
  });
  render(
    <Providers>
      <ConnectionCard />
    </Providers>,
  );
}

/** 一覧の `option` を、区画（`optgroup`）ごと読み出す。 */
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
    // 先頭が既定（`resolveApiBaseUrl` と同じ規則）。
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

  /**
   * ⭐ 一覧が無かった頃に選択だけを設定した人（コンソールから手で入れた人を含む）。
   *
   * その先が一覧に出ないと `select` の値がどの `option` とも一致せず、ブラウザは
   * 黙って先頭を表示する ＝ **実際の接続先と表示が食い違う。**
   */
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
    // 別の先へ切り替える。
    fireEvent.change(select, { target: { value: 'https://api.example.com' } });

    await waitFor(() => {
      expect(select.value).toBe('https://api.example.com');
    });
    // 切り替えた後も、元の接続先は一覧に残っている。
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
    // 末尾のスラッシュは落ちている（経路の連結で // にしないため）。
    expect(JSON.parse(localStorage.getItem('alteroid.endpoints') ?? '[]')).toContainEqual({
      url: 'https://stg.example.com',
      label: '検証',
    });
    const select = screen.getByLabelText<HTMLSelectElement>('接続先');
    expect(select.value).toBe('https://stg.example.com');

    // 足した後、入力欄は空に戻る（次の1件を打てる）。
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

  /**
   * **ホスト名だけを通すと、相対 URL として画面と同じオリジンの `./example.com` を
   * 叩きに行く**（そして 404 が「繋がらない」として返る ＝ 原因が画面から見えない）。
   * ここで止めて、何がまずいのかを画面に書く。
   */
  it('接続先として使えない形は足さない。理由を画面に出す', async () => {
    renderWithEndpoints();

    fireEvent.change(await screen.findByLabelText('追加する接続先の URL'), {
      target: { value: 'example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: '追加して接続' }));

    expect(await screen.findByText(/接続先として使えない/)).toBeTruthy();
    // 保存も切り替えも起きていない。**一覧が空であることを測らない** —
    // 描画の時点で「古い形の選択」が一覧へ写っている（migrate）ので、空ではない。
    // 測るのは「弾いた値が入っていないこと」である。
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
    // 接続先そのものは変えていない（名前だけ）。
    expect(select.value).toBe(TEST_BASE_URL);
  });

  /**
   * 消したのが「いま選んでいる先」なら、選択も外す。
   *
   * **選択だけ残すと、一覧に無い接続先へ繋ぎ続けたうえで「消した」と表示される。**
   */
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

  /**
   * **ビルド時の既定と同一オリジンには消す口を出さない。** 消してもビルドし直す
   * まで戻ってくるので、押せる削除は嘘になる（押した瞬間は消え、読み込み直すと戻る）。
   */
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
