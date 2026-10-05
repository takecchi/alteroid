// @vitest-environment jsdom
/**
 * `/dropped` 画面。ここで固定したいのは:
 *
 * - 0件のとき `describeDroppedTraceEmptyNote()` の文言が出る
 * - 件数があるとき跡が（サーバが返した順のまま）全件出る
 * - runner の跡はここに出ない、という文言（`describeDroppedTraceOriginNote`）が
 *   0件でも件数があっても常に出る
 * - 取得に失敗したとき（404 = 古いデーモン／それ以外の失敗）、0件の文言とは
 *   別の文言が出る
 * - 説明に CLI 名・パス・内部の語が出ず、時刻は地域の時刻で出る（#2792）。
 *   core の文言とは揃えない（core は CLI・クローン向け）
 */
import { formatDateTime } from '@alteroid/logic';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
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

async function renderDropped() {
  const view = render(
    <Providers>
      <MemoryRouter>
        <Dropped />
      </MemoryRouter>
    </Providers>,
  );
  await screen.findByText('失敗の一覧');
  return view;
}

describe('/dropped 画面 — 0件・件数あり・runner の非表示を混ぜない', () => {
  it('0件なら describeDroppedTraceEmptyNote() の文言を出す', async () => {
    stubDropped({ body: { origin: 'daemon', since: SINCE, limit: 200, total: 0, traces: [] } });

    await renderDropped();

    expect(screen.getByText(describeDroppedTraceEmptyNote())).toBeTruthy();
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
    expect(screen.queryByText(describeDroppedTraceEmptyNote())).toBeNull();
  });

  /**
   * **runner の跡はここに出ない、という文言は0件でも件数があっても常に出る。**
   * 構造的に見えないものを黙って0件に混ぜないため。
   */
  it('runner の跡が出ない旨は、0件でも出る', async () => {
    stubDropped({ body: { origin: 'daemon', since: SINCE, limit: 200, total: 0, traces: [] } });

    await renderDropped();

    expect(screen.getByText(describeDroppedTraceOriginNote('daemon'))).toBeTruthy();
  });

  it('runner の跡が出ない旨は、件数があっても出る', async () => {
    stubDropped({
      body: { origin: 'daemon', since: SINCE, limit: 200, total: 1, traces: ['alteroid: x'] },
    });

    await renderDropped();

    expect(screen.getByText(describeDroppedTraceOriginNote('daemon'))).toBeTruthy();
  });
});

describe('/dropped 画面 — 「取りに行けなかった」は0件と違う文言', () => {
  /**
   * **404 は「この口を持たない古いデーモン」であって「跡が無い」ではない。**
   * 0件の文言（`describeDroppedTraceEmptyNote()`）とは別の文字列を出す。
   */
  it('404（この口を持たない古いデーモン）は、0件の文言とは別の文言を出す', async () => {
    stubDropped({ status: 404, body: {} });

    await renderDropped();

    expect(screen.queryByText(describeDroppedTraceEmptyNote())).toBeNull();
    expect(screen.getByText(/版が古い可能性があります/)).toBeTruthy();
  });

  it('404 以外の失敗（500 等）でも、0件の文言とは別の文言を出す', async () => {
    stubDropped({ status: 500, body: { error: 'boom' } });

    await renderDropped();

    expect(screen.queryByText(describeDroppedTraceEmptyNote())).toBeNull();
    expect(screen.getByRole('alert')).toBeTruthy();
  });
});

/**
 * **利用者に内部の語を見せない（#2792）。** CLI 名・HTTP のパス・実装の語は、画面の説明に出さない。
 * 時刻は他の画面と同じ書式（端末の地域の時刻）で、UTC の ISO 文字列のままにしない。
 */
describe('/dropped 画面 — 利用者の言葉で書く（#2792）', () => {
  const FORBIDDEN = [
    /alteroid dropped/,
    /GET \/dropped/,
    /帳面/,
    /stderr/,
    /握り潰し/,
    /runner/,
    /プロセス/,
  ];

  it('0件の画面に、コマンド・パス・内部の語が出ない', async () => {
    stubDropped({ body: { origin: 'daemon', since: SINCE, limit: 200, total: 0, traces: [] } });

    const { container } = await renderDropped();

    for (const word of FORBIDDEN) expect(container.textContent).not.toMatch(word);
    expect(screen.getByText(/日誌に書き損ねた記録は、いまは0件です/)).toBeTruthy();
  });

  it('404 の文言にも、パスと内部の語が出ない', async () => {
    stubDropped({ status: 404, body: {} });

    const { container } = await renderDropped();

    for (const word of FORBIDDEN) expect(container.textContent).not.toMatch(word);
  });

  it('数え始めた時刻は、UTC の ISO 文字列ではなく地域の時刻の書式で出る', async () => {
    stubDropped({ body: { origin: 'daemon', since: SINCE, limit: 200, total: 0, traces: [] } });

    const { container } = await renderDropped();

    expect(container.textContent).toContain(`数え始めた時刻: ${formatDateTime(SINCE)}`);
    expect(container.textContent).not.toContain(SINCE);
  });

  it('保持の説明は limit をサーバの値のまま言い、stderr を指さない', () => {
    expect(describeDroppedTraceRetentionNote(200)).toContain('直近 200 件');
    expect(describeDroppedTraceRetentionNote(7)).toContain('直近 7 件');
  });

  it('origin が無いとき（古い版）は空文字', () => {
    expect(describeDroppedTraceOriginNote(undefined)).toBe('');
  });
});
