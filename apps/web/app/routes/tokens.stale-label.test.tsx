// @vitest-environment jsdom
/**
 * **回転の履歴の badge が、捨てた理由を言い分ける**（人間の決定 2026-09-07）。
 *
 * ## これは実際に人間を誤らせた
 *
 * 本番の日誌にこの行が出た（2026-09-07 16:33 JST）:
 *
 * ```
 * 回さなかった（契機に当たらなかった。正常）      ← badge
 * 契機: reached
 * 古い観測
 * 認証トークン: 回さなかった（reached）。もう回した後の通知（世代が合わない）。…
 * 当たった文言: You've hit your session limit · resets 7:30pm (Asia/Tokyo)
 * ```
 *
 * **badge だけが別のことを言っている。** 契機には当たっている（`signal: reached`）
 * のに「契機に当たらなかった」と書いてあるので、**その1行が嘘なのではないか**と
 * 読まれた（人間の逐語: 「って嘘ですか？ どういうこと？」）。
 *
 * 原因は `event: 'not_rotated'` に**2つの別の事実**が畳まれていること:
 *
 * | 実際に起きたこと | `signal` | `freshness` |
 * | --- | --- | --- |
 * | 契機に当たらなかった（`off` / `org_policy` / まだ課金枠が生きている） | その印 | `current` など |
 * | **もう回した後の通知だったので捨てた** | **本物の印**（`reached` 等） | **`stale`** |
 *
 * ⟹ `freshness` を見て言い分ける。**`event` を増やして分ける道は採らない** ——
 * 外向きの面（`openapi.json`）が動くうえ、`freshness` に既に在る情報である。
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { JournalEntry } from '~/lib/types';
import { json, Providers, storeTestBaseUrl } from '~/test-support';

import Tokens from './tokens';

function entry(over: Partial<Extract<JournalEntry, { type: 'token_rotation' }>> = {}) {
  return {
    type: 'token_rotation' as const,
    id: 'j-1',
    at: '2026-09-07T07:33:12.146Z',
    event: 'not_rotated' as const,
    text: '認証トークン: 回さなかった（reached）。もう回した後の通知（世代が合わない）。',
    ...over,
  };
}

let originalFetch: typeof globalThis.fetch;

function stub(entries: readonly unknown[]): void {
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (new URL(url).pathname === '/journal') return Promise.resolve(json({ entries }));
    // プールは空で返す（この歯は履歴の badge だけを見る）。
    return Promise.resolve(
      json({ tokens: [], settings: { rotateOn: 'free_exhausted', cooldownMs: 18_000_000 } }),
    );
  }) as typeof fetch;
}

describe('not_rotated の badge は、捨てた理由を言い分ける', () => {
  beforeEach(() => {
    originalFetch = globalThis.fetch;
    localStorage.clear();
    storeTestBaseUrl();
    stub([]);
  });
  afterEach(() => {
    cleanup();
    globalThis.fetch = originalFetch;
  });

  it('古い観測で捨てた回は「契機に当たらなかった」と言わない', async () => {
    // **ここが本番で人間を誤らせた行そのものである。**
    stub([entry({ signal: 'reached', freshness: 'stale' })]);

    render(
      <Providers>
        <Tokens />
      </Providers>,
    );

    // **badge の文言で待つ。** 本文（`text`）にも「もう回した後の通知」が
    // 出るので、そちらでは badge を測れない（2件当たる）。
    await waitFor(() => {
      expect(screen.getByText(/契機には当たっている/)).toBeTruthy();
    });
    // **嘘の行が出ていない。**
    expect(screen.queryByText(/契機に当たらなかった/)).toBeNull();
  });

  it('本当に契機に当たらなかった回は、従来どおりそう書く', async () => {
    // 設定が `off` / `org_policy` / まだ課金枠が生きている、の側。**言い分けた
    // ことで、こちらの文言が消えていないことを固定する。**
    stub([entry({ signal: 'org_policy', freshness: 'current' })]);

    render(
      <Providers>
        <Tokens />
      </Providers>,
    );

    await waitFor(() => {
      expect(screen.getByText(/契機に当たらなかった/)).toBeTruthy();
    });
    expect(screen.queryByText(/もう回した後の通知。契機には当たっている/)).toBeNull();
  });

  it('freshness が無い回も、従来どおりの文言になる', async () => {
    // `freshness` は省略可（起動時の撒き直しなど）。**`undefined` を `stale` と
    // 読まない** —— 読むと、観測を持たない行に「もう回した後」と書くことになる。
    stub([entry({ signal: 'none' })]);

    render(
      <Providers>
        <Tokens />
      </Providers>,
    );

    await waitFor(() => {
      expect(screen.getByText(/契機に当たらなかった/)).toBeTruthy();
    });
  });
});
