// @vitest-environment jsdom
/**
 * `/archive` 画面（#776）。ここで固定したいのは:
 *
 * - `GET /archive` の一覧が出る（id / sessionId / storedBytes / at）
 * - `GET /archive/sessions` の集計が出る
 * - 既に削除済み（`removedAt` あり）の行には「本文を消す」ボタンを出さない
 * - **「本文を消す」で `DELETE /archive/:id` を叩き、成功すれば一覧が取り直されて
 *   「本文は削除済み」に変わる**（#776 の中心）
 * - **409（走行中マネージャーの退避）を黙って失敗させない** — サーバの断り
 *   文言を `ErrorNote` に出し、理由の入力欄が現れる。理由を付けて打ち直すと
 *   `overrideReason` クエリが付き、成功すれば override した旨が分かる
 *
 * **共有の `stubFetch` は使えない**（`tokens.test.tsx` / `schedule.test.tsx` と
 * 同じ理由 — `openapi-fetch` は `fetch(new Request(...))` の形で呼ぶので、
 * `stubFetch` の `route(url, init)` には method が渡らない）。ここでは
 * `globalThis.fetch` を自分で差し替え、状態（`removedAt` が付くかどうか）を持つ。
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { json, Providers, storeTestBaseUrl } from '~/test-support';

import Archive from './archive';

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

interface StubEntry {
  id: string;
  sessionId: string;
  at: string;
  storedBytes: number;
  removedAt?: string;
  removedBytes?: number;
}

/**
 * 状態を持つ `/archive` の stub。`DELETE /archive/:id` を受けたら、既定では
 * その場で `removedAt` を付ける——一覧の取り直し（`useRemoveArchive` が
 * `KEY.archive` / `KEY.archiveSessions` を無効化する）で「本文は削除済み」に
 * 変わることを確かめるため。
 *
 * `denyManagerId` を渡すと、**それ以外の呼び**（`overrideReason` を付けない）
 * を 409 で拒む——走行中マネージャーの退避を模す。
 */
function stubArchiveScreen(
  initial: StubEntry[],
  options: { sessions?: unknown[]; denyManagerId?: string } = {},
) {
  let rows = initial;
  const deletes: { url: string }[] = [];

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : null;
    const url = request?.url ?? (typeof input === 'string' ? input : String(input));
    const method = request?.method ?? init?.method ?? 'GET';

    if (url.includes('/journal')) return json({ entries: [] });
    if (url.endsWith('/archive/sessions')) return json({ sessions: options.sessions ?? [] });
    if (url.includes('/archive/') && method === 'DELETE') {
      deletes.push({ url });
      const parsed = new URL(url);
      const id = decodeURIComponent(parsed.pathname.split('/').pop() ?? '');
      const overrideReason = parsed.searchParams.get('overrideReason');
      const entry = rows.find((row) => row.id === id);
      if (entry === undefined) return json({ error: 'not found' }, 404);
      if (entry.removedAt !== undefined) {
        return json({ ok: true, id, bytes: entry.removedBytes ?? 0, alreadyRemoved: true });
      }
      if (
        options.denyManagerId !== undefined &&
        (overrideReason === null || overrideReason.trim() === '')
      ) {
        return json(
          {
            error:
              `走行中のマネージャー ${options.denyManagerId} の退避なので消せない` +
              '（overrideReason クエリ引数に理由を書けば通せる）',
          },
          409,
        );
      }
      rows = rows.map((row) =>
        row.id === id
          ? { ...row, removedAt: '2026-09-15T00:00:00.000Z', removedBytes: row.storedBytes }
          : row,
      );
      return json({
        ok: true,
        id,
        bytes: entry.storedBytes,
        alreadyRemoved: false,
        ...(overrideReason !== null && overrideReason.trim() !== ''
          ? { override: { managerId: options.denyManagerId ?? 'mgr-1', reason: overrideReason } }
          : {}),
      });
    }
    if (url.endsWith('/archive')) return json({ entries: rows });
    return Promise.reject(new TypeError(`Failed to fetch: ${url}`));
  }) as typeof fetch;

  return { deletes, currentRows: () => rows };
}

async function renderArchive(): Promise<void> {
  render(
    <Providers>
      <MemoryRouter>
        <Archive />
      </MemoryRouter>
    </Providers>,
  );
  await screen.findByText('一覧');
}

describe('/archive 画面 — 一覧・集計・削除（#776）', () => {
  it('一覧に id / sessionId / storedBytes / at を出す', async () => {
    stubArchiveScreen([
      {
        id: 'sess-1-a.jsonl',
        sessionId: 'sess-1',
        at: '2026-09-01T00:00:00.000Z',
        storedBytes: 1234,
      },
    ]);

    await renderArchive();

    expect(await screen.findByText(/ の会話$/)).toBeTruthy();
    // 識別子は「詳しい情報」の先にだけ在る
    expect(screen.getByText('sess-1-a.jsonl').closest('details')).not.toBeNull();
    expect(screen.getByText('sess-1').closest('details')).not.toBeNull();
    expect(screen.getByText(/1234バイト/)).toBeTruthy();
  });

  it('sessionId ごとの集計（GET /archive/sessions）を出す', async () => {
    stubArchiveScreen([], {
      sessions: [
        {
          sessionId: 'sess-repeated',
          rows: 68,
          storedBytes: 999,
          maxStoredBytes: 500,
          firstAt: '2026-08-01T00:00:00.000Z',
          lastAt: '2026-08-20T00:00:00.000Z',
        },
      ],
    });

    await renderArchive();

    expect(await screen.findByText(/からの会話/)).toBeTruthy();
    expect(screen.getByText('sess-repeated').closest('details')).not.toBeNull();
    expect(screen.getByText('行数 68')).toBeTruthy();
  });

  it('折りたたみの外に UUID の形の文字列を出さない', async () => {
    const uuid = '3f2b8c1e-9a4d-4e6f-8b1a-0c2d3e4f5a6b';
    stubArchiveScreen(
      [{ id: `${uuid}-1.jsonl`, sessionId: uuid, at: '2026-09-01T00:00:00.000Z', storedBytes: 10 }],
      {
        sessions: [
          {
            sessionId: uuid,
            rows: 1,
            storedBytes: 10,
            maxStoredBytes: 10,
            firstAt: '2026-09-01T00:00:00.000Z',
            lastAt: '2026-09-01T00:00:00.000Z',
          },
        ],
      },
    );

    await renderArchive();
    await screen.findAllByText(/の会話$/);

    const clone = document.body.cloneNode(true) as HTMLElement;
    clone.querySelectorAll('details').forEach((el) => el.remove());
    expect(clone.textContent).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
    expect(document.body.textContent).toMatch(uuid);
  });

  it('空のとき、何が起きるとここに出るかを言い、コマンド名・パス・内部の語を出さない（#2792）', async () => {
    stubArchiveScreen([]);

    await renderArchive();

    expect((await screen.findAllByText(/退避された生ログはまだありません/)).length).toBe(2);
    const text = document.body.textContent ?? '';
    for (const word of [/alteroid chat/, /\/archive/, /sessionId/, /GET /]) {
      expect(text).not.toMatch(word);
    }
  });

  it('既に削除済みの行には「本文を消す」を出さない', async () => {
    stubArchiveScreen([
      {
        id: 'sess-2-a.jsonl',
        sessionId: 'sess-2',
        at: '2026-09-01T00:00:00.000Z',
        storedBytes: 0,
        removedAt: '2026-09-02T00:00:00.000Z',
        removedBytes: 999,
      },
    ]);

    await renderArchive();

    expect(await screen.findByText('本文は削除済み')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '本文を消す' })).toBeNull();
  });

  it('消した本文のバイト数は、保存量とは単位が違うと読める文言で出す（issue #2270 / #2074）', async () => {
    stubArchiveScreen([
      {
        id: 'sess-3-a.jsonl',
        sessionId: 'sess-3',
        at: '2026-09-01T00:00:00.000Z',
        storedBytes: 11452,
        removedAt: '2026-09-02T00:00:00.000Z',
        removedBytes: 1000000,
      },
    ]);

    await renderArchive();

    // 保存量（`storedBytes`）は「使用量」。置き場が実際に使っている量である。
    expect(await screen.findByText(/使用量 11452バイト/)).toBeTruthy();
    // 消した量（`removedBytes`）は「消した本文の素の UTF-8 バイト数」。
    // 使用量とは単位が違い、置き場で解放した量でもないと言う。
    const removedLine = screen.getByText(/削除:/);
    expect(removedLine.textContent).toContain('消した本文の素の UTF-8 バイト数 1000000');
    expect(removedLine.textContent).toContain('使用量とは単位が違い');
    expect(removedLine.textContent).toContain('解放した量ではない');
    // 単位の区別なしの「（1000000バイト）」の形は出さない。
    expect(screen.queryByText(/（1000000バイト）/)).toBeNull();
  });

  it('「本文を消す」で DELETE /archive/:id を叩き、成功すれば一覧が「本文は削除済み」に変わる', async () => {
    stubArchiveScreen([
      {
        id: 'sess-3-a.jsonl',
        sessionId: 'sess-3',
        at: '2026-09-01T00:00:00.000Z',
        storedBytes: 10,
      },
    ]);

    await renderArchive();
    fireEvent.click(await screen.findByRole('button', { name: '本文を消す' }));

    await waitFor(() => {
      expect(screen.getByText('本文は削除済み')).toBeTruthy();
    });
    expect(screen.queryByRole('button', { name: '本文を消す' })).toBeNull();
  });

  /**
   * ⭐ 依頼の中心——409（走行中マネージャーの退避）を黙って失敗させない。
   * サーバの断り文言が出て、理由を付けて打ち直せる。
   */
  it('走行中マネージャーの退避は409。断り文言が出て、理由を付けると override で消せる', async () => {
    stubArchiveScreen(
      [
        {
          id: 'sess-4-a.jsonl',
          sessionId: 'sess-4',
          at: '2026-09-01T00:00:00.000Z',
          storedBytes: 10,
        },
      ],
      { denyManagerId: 'mgr-1' },
    );

    await renderArchive();
    fireEvent.click(await screen.findByRole('button', { name: '本文を消す' }));

    // 黙って失敗しない: サーバの断り文言が画面に出る。
    expect(await screen.findByText(/走行中のマネージャー mgr-1 の退避なので消せない/)).toBeTruthy();

    // 理由の入力欄が現れる。理由なしでは押せない。
    const input = await screen.findByPlaceholderText('走行中のマネージャーの退避——上書きする理由');
    const overrideButton = screen.getByRole('button', { name: '理由を付けて消す' });
    expect(overrideButton).toHaveProperty('disabled', true);

    fireEvent.change(input, { target: { value: '本番障害の調査で緊急に消す必要があった' } });
    expect(overrideButton).toHaveProperty('disabled', false);
    fireEvent.click(overrideButton);

    await waitFor(() => {
      expect(screen.getByText('本文は削除済み')).toBeTruthy();
    });
  });
});
