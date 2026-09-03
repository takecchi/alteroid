// @vitest-environment jsdom
/**
 * `/dropped` 画面。ここで固定したいのは:
 *
 * - 0件のとき `describeDroppedTraceEmpty()` の文言が出る
 * - 件数があるとき跡が（サーバが返した順のまま）全件出る
 * - runner の跡はここに出ない、という文言（`describeDroppedTraceOrigin`）が
 *   0件でも件数があっても常に出る
 * - 取得に失敗したとき（404 = 古いデーモン／それ以外の失敗）、0件の文言とは
 *   別の文言が出る
 * - Web 側の複製（`describeDroppedTraceOriginNote` 等）が core の実装と
 *   文字列として一致する（#242 系の先例 #579 と同じ形の歯）
 */
import {
  describeDroppedTraceEmpty,
  describeDroppedTraceOrigin,
  describeDroppedTraceRetention,
  RECENT_TRACE_LIMIT,
  type DroppedTraceOrigin,
} from '@alteroid/core';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { json, Providers, stubFetch, storeTestBaseUrl } from '~/test-support';

import Dropped, {
  describeDroppedTraceEmptyNote,
  describeDroppedTraceOriginNote,
  describeDroppedTraceRetentionNote,
} from './dropped';

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

const SINCE = '2026-09-01T00:00:00.000Z';

function stubDropped(options: { status?: number; body?: unknown }) {
  const { status = 200, body = {} } = options;
  return stubFetch((url) => {
    if (url.includes('/dropped')) return json(body, status);
    return undefined;
  });
}

async function renderDropped(): Promise<void> {
  render(
    <Providers>
      <Dropped />
    </Providers>,
  );
  await screen.findByText('帳面');
}

describe('/dropped 画面 — 0件・件数あり・runner の非表示を混ぜない', () => {
  it('0件なら describeDroppedTraceEmpty() の文言を出す', async () => {
    stubDropped({ body: { origin: 'daemon', since: SINCE, limit: 200, total: 0, traces: [] } });

    await renderDropped();

    expect(screen.getByText(describeDroppedTraceEmpty())).toBeTruthy();
  });

  it('件数があるとき、跡を全件出す', async () => {
    const traces = [
      'alteroid: 2026-09-01T00:00:01.000Z 記録できませんでした: Error: 古い方',
      'alteroid: 2026-09-01T00:00:02.000Z 記録できませんでした: Error: 新しい方',
    ];
    stubDropped({ body: { origin: 'daemon', since: SINCE, limit: 200, total: 2, traces } });

    await renderDropped();

    expect(screen.getByText(traces[0]!)).toBeTruthy();
    expect(screen.getByText(traces[1]!)).toBeTruthy();
    // 0件の文言は出ない。
    expect(screen.queryByText(describeDroppedTraceEmpty())).toBeNull();
  });

  /**
   * **runner の跡はここに出ない、という文言は0件でも件数があっても常に出る。**
   * 構造的に見えないものを黙って0件に混ぜないため。
   */
  it('runner の跡が出ない旨は、0件でも出る', async () => {
    stubDropped({ body: { origin: 'daemon', since: SINCE, limit: 200, total: 0, traces: [] } });

    await renderDropped();

    expect(screen.getByText(describeDroppedTraceOrigin('daemon'))).toBeTruthy();
  });

  it('runner の跡が出ない旨は、件数があっても出る', async () => {
    stubDropped({
      body: { origin: 'daemon', since: SINCE, limit: 200, total: 1, traces: ['alteroid: x'] },
    });

    await renderDropped();

    expect(screen.getByText(describeDroppedTraceOrigin('daemon'))).toBeTruthy();
  });
});

describe('/dropped 画面 — 「取りに行けなかった」は0件と違う文言', () => {
  /**
   * **404 は「この口を持たない古いデーモン」であって「跡が無い」ではない。**
   * 0件の文言（`describeDroppedTraceEmpty()`）とは別の文字列を出す。
   */
  it('404（この口を持たない古いデーモン）は、0件の文言とは別の文言を出す', async () => {
    stubDropped({ status: 404, body: {} });

    await renderDropped();

    expect(screen.queryByText(describeDroppedTraceEmpty())).toBeNull();
    expect(screen.getByText(/版が古い可能性がある/)).toBeTruthy();
  });

  it('404 以外の失敗（500 等）でも、0件の文言とは別の文言を出す', async () => {
    stubDropped({ status: 500, body: { error: 'boom' } });

    await renderDropped();

    expect(screen.queryByText(describeDroppedTraceEmpty())).toBeNull();
    expect(screen.getByRole('alert')).toBeTruthy();
  });
});

/**
 * **由来・0件・保持のしかたの字面が、core（`packages/core/src/dropped-record.ts`）
 * と Web の複製で一致していること。**
 *
 * **なぜ要るか — 2箇所に在るからである。** Web が core の関数をそのまま呼べない
 * 理由は正当で（`packages/core` の値 import はブラウザバンドルへサーバ専用の
 * ドメイン層を引き込む。`eslint.config.js` の該当ルールと #294 / #306 の事故）、
 * 統合するつもりは無い。**問題は、揃っていることを規約でしか守っていなかった
 * ことである** —— 両ファイルの doc は「直すときは両方見ること」と書いているが、
 * 面ごとのテストはそれぞれ自分の literal を assert しているので、**片方だけ
 * 直しても両方緑のまま通る。**
 *
 * **テストファイルからの値 import は禁止の対象外である**（`eslint.config.js`
 * の `no-restricted-imports` の doc が逐語で `*.test.{ts,tsx}` を外している）。
 * 先例は `managers.test.tsx`「sessionMissingKind の字面が core と一致する（#579）」。
 *
 * **`ALL_ORIGINS` を `Record` で持つのは、値が増えたときにここが型で落ちるため。**
 * 配列だと2値目が足されても素通りする（＝新しい値の字面が測られないまま増える）。
 * これはビルド時の網羅性であって、実行時に測っているのは下の一致だけである。
 */
describe('字面が core と一致する', () => {
  const ALL_ORIGINS: Record<DroppedTraceOrigin, true> = {
    daemon: true,
  };

  it('全ての origin で、core の describeDroppedTraceOrigin と文字列として等しい', () => {
    const origins = Object.keys(ALL_ORIGINS) as DroppedTraceOrigin[];
    // **空でないことを先に確かめる。** `Object.keys` が空なら下の forEach は
    // 1回も回らず、この歯は何も測らずに緑になる。
    expect(origins.length).toBeGreaterThan(0);
    for (const origin of origins) {
      expect(describeDroppedTraceOriginNote(origin)).toBe(describeDroppedTraceOrigin(origin));
    }
  });

  it('origin が無いときも一致する（どちらも空文字）', () => {
    expect(describeDroppedTraceOriginNote(undefined)).toBe(describeDroppedTraceOrigin(undefined));
    expect(describeDroppedTraceOriginNote(undefined)).toBe('');
  });

  it('0件のときの文言が、core の describeDroppedTraceEmpty と文字列として等しい', () => {
    expect(describeDroppedTraceEmptyNote()).toBe(describeDroppedTraceEmpty());
  });

  it('保持のしかたの文言が、複数の limit で core の describeDroppedTraceRetention と等しい', () => {
    for (const limit of [0, 1, RECENT_TRACE_LIMIT]) {
      expect(describeDroppedTraceRetentionNote(limit)).toBe(describeDroppedTraceRetention(limit));
    }
  });
});
