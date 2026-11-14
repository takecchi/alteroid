import { readFileSync } from 'node:fs';

import {
  createManagerPool,
  createMemoryStores,
  createRunnerRegistry,
  fakeCloneHost,
} from '@alteroid/core';
import type { CloneHost } from '@alteroid/core';
import { describe, expect, it } from 'vitest';

import { createApp } from './app.js';

// `createApp` が登録する経路の一覧（`app.routes`）を、登録順のまま丸ごと固定する。
// `app.ts` を族ごとのファイルへ分けても、経路の数・順・ハンドラの段数（`describeRoute`・検証・ゲート・本体）が
// 変わらないことの歯。Hono は同じメソッドで当たったハンドラを登録順に走らせるので、順序そのものが挙動になる。
// 固定値は `app-routes-pin.json`。経路を足す・消す・並べ替えるときは、`createApp` の `app.routes` から
// 機械的に作り直すこと（手で書き写さない）。`[method, path]` はハンドラ 1 段ごとに 1 行（`use` は `ALL`）。

type Entry = [method: string, path: string];
interface Pin {
  withoutCors: Entry[];
  withCors: Entry[];
}

const PIN = JSON.parse(
  readFileSync(new URL('./app-routes-pin.json', import.meta.url), 'utf8'),
) as Pin;

function cloneHost(): CloneHost {
  const stores = createMemoryStores();
  return fakeCloneHost({
    managers: createManagerPool({ stores, post: () => {}, runners: createRunnerRegistry() }),
  });
}

function routesOf(allowedOrigins?: readonly string[]): Entry[] {
  const app = createApp({
    clone: cloneHost(),
    stores: createMemoryStores(),
    token: 'pin-token',
    shutdown: () => {},
    ...(allowedOrigins === undefined ? {} : { allowedOrigins }),
  });
  return app.routes.map((route): Entry => [route.method, route.path]);
}

// 連続する同じ組を 1 本に畳む（1 本の経路は describeRoute・検証・本体で複数段になる）。
function collapse(entries: readonly Entry[]): string[] {
  const out: string[] = [];
  for (const [method, path] of entries) {
    const key = `${method} ${path}`;
    if (out[out.length - 1] !== key) out.push(key);
  }
  return out;
}

describe('createApp の経路の一覧が固定値と一致する', () => {
  it('CORS なし: 登録順のまま一致する', () => {
    expect(routesOf()).toEqual(PIN.withoutCors);
  });

  it('CORS あり（allowedOrigins を渡す）: use の 1 段が増えるだけで、ほかは同じ順', () => {
    expect(routesOf(['https://www.example.com'])).toEqual(PIN.withCors);
  });

  it('空振りでない: 経路が 111 本（use の ALL と /openapi.json・/docs を除く）ある', () => {
    const collapsed = collapse(PIN.withoutCors);
    const real = collapsed.filter(
      (key) => !key.startsWith('ALL ') && key !== 'GET /openapi.json' && key !== 'GET /docs',
    );
    expect(real).toHaveLength(111);
    expect(collapsed).toContain('GET /openapi.json');
    expect(collapsed).toContain('GET /docs');
    // 型の側の経路（鎖）には /openapi.json・/docs が載らず、実行時だけに 2 本多い。
    expect(PIN.withoutCors.length).toBeGreaterThan(111);
  });

  it('同じ (method, path) が離れた場所に 2 度出ない（出るなら後ろは前に隠される）', () => {
    for (const entries of [PIN.withoutCors, PIN.withCors]) {
      const collapsed = collapse(entries).filter((key) => !key.startsWith('ALL '));
      expect(collapsed.filter((key, index) => collapsed.indexOf(key) !== index)).toEqual([]);
    }
  });

  it('use の順: 認証（ALL）は経路より前、先頭の ALL は CORS の有無で 1 段違う', () => {
    const firstRoute = (entries: readonly Entry[]) =>
      entries.findIndex(([method]) => method !== 'ALL');
    expect(firstRoute(PIN.withoutCors)).toBe(2);
    expect(firstRoute(PIN.withCors)).toBe(3);
    for (const entries of [PIN.withoutCors, PIN.withCors]) {
      const lastAll = entries.map(([method]) => method).lastIndexOf('ALL');
      expect(lastAll).toBe(firstRoute(entries) - 1);
    }
  });

  it('GET /journal/stream は GET /journal/:id より前に登録されている（逆だと stream が :id に食われる）', () => {
    const keys = collapse(PIN.withoutCors);
    const stream = keys.indexOf('GET /journal/stream');
    const byId = keys.indexOf('GET /journal/:id');
    expect(stream).toBeGreaterThanOrEqual(0);
    expect(byId).toBeGreaterThanOrEqual(0);
    expect(stream).toBeLessThan(byId);
  });

  it('同じメソッドで先の経路が後の `:param` の経路に隠されない（具体的な経路が先）', () => {
    const keys = collapse(PIN.withoutCors).filter((key) => !key.startsWith('ALL '));
    const toRegExp = (path: string) =>
      new RegExp(`^${path.replaceAll(/:[^/]+/g, '[^/]+').replaceAll('*', '.*')}$`);
    const hidden: string[] = [];
    keys.forEach((earlier, earlierIndex) => {
      const [earlierMethod = '', earlierPath = ''] = earlier.split(' ');
      if (!earlierPath.includes(':')) return;
      keys.slice(earlierIndex + 1).forEach((later) => {
        const [laterMethod = '', laterPath = ''] = later.split(' ');
        if (laterMethod !== earlierMethod || laterPath.includes(':')) return;
        // 前に登録された `:param` の経路が、後ろの具体的な経路に当たる（= 後ろが隠される）
        if (toRegExp(earlierPath).test(laterPath)) hidden.push(`${earlier} が ${later} を隠す`);
      });
    });
    expect(hidden).toEqual([]);
  });

  it('具体的な経路が `:param` の経路より前にある組を、いくつか名指しで確かめる', () => {
    const keys = collapse(PIN.withoutCors);
    const before = (a: string, b: string) => {
      expect(keys.indexOf(a), a).toBeGreaterThanOrEqual(0);
      expect(keys.indexOf(a), `${a} は ${b} より前`).toBeLessThan(keys.indexOf(b));
    };
    before('GET /attachments/limits', 'GET /attachments/:id');
    before('GET /conversations/unread-count', 'GET /conversations/:id');
    before('GET /approvals/answered-dates', 'GET /approvals/:id');
    before('GET /archive/sessions', 'GET /archive/:id');
  });
});
