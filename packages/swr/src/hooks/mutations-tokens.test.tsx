// @vitest-environment jsdom
/**
 * 認証トークンの全置換（`GET /tokens` → 加工 → `PUT /tokens`）は、同じ API クライアントの中で
 * 1本ずつ直列に流れる（Issue #3608）。別の行を続けて操作しても、先の変更を後の `PUT` が
 * 巻き戻さない。順序は保留した Promise で作る（実時間の待ちは使わない）。
 */
import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { useAddToken, useRemoveToken, useSetTokenDisabled } from './mutations';
import { json, Providers, storeTestBaseUrl, stubFetch } from '../test-support';

interface Row {
  id: string;
  label: string;
  order: number;
  disabled?: boolean;
}

function view(rows: readonly Row[]) {
  return {
    tokens: rows.map((row) => ({ ...row, disabled: row.disabled ?? false })),
    unreadable: [],
  };
}

const A: Row = { id: 'a', label: 'A', order: 0 };
const B: Row = { id: 'b', label: 'B', order: 1 };

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  localStorage.clear();
  storeTestBaseUrl();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** 全置換だけを真似る偽のサーバ。`gate` を渡した回の `PUT` は、`gate` が解けるまで返さない。 */
function fakeTokenServer(initial: readonly Row[], gates: Promise<void>[] = []) {
  let rows = [...initial];
  const log: string[] = [];
  let putIndex = 0;
  const stub = stubFetch(() => undefined);
  const inner = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const path = new URL(request.url).pathname;
    if (path === '/tokens' && request.method === 'GET') {
      log.push('GET');
      return json(view(rows));
    }
    if (path === '/tokens' && request.method === 'PUT') {
      const index = putIndex++;
      const body = (await request.clone().json()) as { tokens: Row[] };
      log.push(`PUT#${index}`);
      await gates[index];
      if (body.tokens.some((token) => token.label === 'boom')) {
        return json({ error: 'rejected' }, 400);
      }
      // `disabled` を省略した行は既存の状態を引き継ぐ（`normalizeTokenPool` と同じ）。
      const before = new Map(rows.map((row) => [row.id, row]));
      rows = body.tokens.map((token, order) => ({
        ...token,
        order,
        disabled: token.disabled ?? before.get(token.id)?.disabled ?? false,
      }));
      return json(view(rows));
    }
    return inner(input, init);
  }) as typeof fetch;
  return { stub, log, rows: () => rows };
}

function wrapper({ children }: { children: ReactNode }) {
  return <Providers>{children}</Providers>;
}

function useAll() {
  return { remove: useRemoveToken(), disable: useSetTokenDisabled(), add: useAddToken() };
}

describe('トークンの全置換を直列に流す', () => {
  it('2行を続けて外すと、両方の変更が残る', async () => {
    let release!: () => void;
    const first = new Promise<void>((resolve) => (release = resolve));
    const server = fakeTokenServer([A, B], [first]);
    const { result } = renderHook(useAll, { wrapper });

    const p1 = result.current.remove('a');
    const p2 = result.current.remove('b');
    // 1本目の PUT が保留の間、2本目は GET も撃たない。
    await Promise.resolve();
    release();
    await Promise.all([p1, p2]);

    expect(server.rows()).toEqual([]);
    expect(server.log).toEqual(['GET', 'PUT#0', 'GET', 'PUT#1']);
  });

  it('外すと無効化を続けても、外した行が戻らない', async () => {
    const server = fakeTokenServer([A, B]);
    const { result } = renderHook(useAll, { wrapper });

    const p1 = result.current.remove('a');
    const p2 = result.current.disable('b', true);
    await Promise.all([p1, p2]);

    expect(server.rows().map((row) => [row.id, row.disabled])).toEqual([['b', true]]);
  });

  it('前の書き込みが失敗しても、後ろは走り、失敗は呼び手に返る', async () => {
    const server = fakeTokenServer([A, B]);
    const { result } = renderHook(useAll, { wrapper });

    const failing = result.current.add('boom', 'secret');
    const failed = failing.then(
      () => 'ok',
      () => 'rejected',
    );
    const next = result.current.remove('a');
    await next;

    expect(await failed).toBe('rejected');
    expect(server.rows().map((row) => row.id)).toEqual(['b']);
  });

  it('別の API クライアントの列は待たない', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    fakeTokenServer([A, B], [gate]);
    const one = renderHook(useAll, { wrapper });
    const stalled = one.result.current.remove('a');

    // 別の ApiProvider（別の client）。1本目が保留のままでも完了する。
    const two = renderHook(useAll, { wrapper });
    await two.result.current.remove('b');

    release();
    await stalled;
  });
});
