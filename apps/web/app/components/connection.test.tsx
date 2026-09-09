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
