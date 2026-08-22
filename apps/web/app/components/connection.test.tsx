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
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { json, Providers, stubFetch, storeTestBaseUrl } from '~/test-support';

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
