import type { CloneHost, JournalEntry, Stores } from '@alteroid/core';
import { captureStderr, createMemoryStores } from '@alteroid/core';
import { beforeEach, describe, expect, it } from 'vitest';

import { createApp } from './app.js';

// #5374: 人間の POST /schedule は、既存の kind を置き換えるとき旧本文・旧周期を日誌へ先に残し、応答の replaced で置換か新規かを言う。

const SEEN = '2026-10-01T00:00:00.000Z';
const oldSpec = { type: 'daily', at: '09:00' } as const;
const newSpec = { type: 'every', minutes: 30 } as const;
const KIND = 'morning';
const OLD_REQUEST = '旧い本文（置き換えると行から消える）';
const NEW_REQUEST = '新しい本文';

function stubClone(): CloneHost {
  return {
    post: () => 'conversation-1',
    subscribe: () => () => undefined,
    stop: () => Promise.resolve(),
    usageBlocked: false,
    managers: {},
  } as unknown as CloneHost;
}

function appOver(stores: Stores) {
  return createApp({
    clone: stubClone(),
    stores,
    token: 'test-token',
    shutdown: () => undefined,
  });
}

function post(app: ReturnType<typeof createApp>, extra: Record<string, unknown> = {}) {
  return app.request('/schedule', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind: KIND, request: NEW_REQUEST, spec: newSpec, ...extra }),
  });
}

async function decisions(stores: Stores): Promise<(JournalEntry & { type: 'decision' })[]> {
  const rows = await stores.journal.list({ types: ['decision'], order: 'asc' });
  return rows.filter((row): row is JournalEntry & { type: 'decision' } => row.type === 'decision');
}

describe('POST /schedule は置き換えの前に旧本文・旧周期を日誌へ残す（#5374）', () => {
  let stores: Stores;

  beforeEach(async () => {
    stores = createMemoryStores();
  });

  async function seed() {
    await stores.schedules.put({
      kind: KIND,
      spec: oldSpec,
      request: OLD_REQUEST,
      createdAt: SEEN,
      updatedAt: SEEN,
    });
  }

  it('既存の kind へ ifMatch なしで置くと、旧本文・旧周期が日誌に残り、応答は replaced: true', async () => {
    await seed();

    const response = await post(appOver(stores));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, replaced: true });
    expect((await stores.schedules.get(KIND))?.request).toBe(NEW_REQUEST);
    const rows = await decisions(stores);
    const before = rows[0]?.decision ?? '';
    expect(before).toContain('人間が定期の依頼を置き換えようとしている');
    expect(before).toContain(OLD_REQUEST);
    expect(before).toContain('毎日 09:00');
    expect(before).toContain(NEW_REQUEST);
    expect(rows[0]?.humanAction).toBeUndefined();
  });

  it('置き換えの瞬間に、旧本文を持つ先の行が日誌に既に在る（順序の歯）', async () => {
    await seed();
    const real = stores.schedules;
    let atWrite: (JournalEntry & { type: 'decision' })[] | undefined;
    stores.schedules = {
      ...real,
      async editRequest(kind, changes, now, options) {
        atWrite = await decisions(stores);
        return real.editRequest(kind, changes, now, options);
      },
    };

    const response = await post(appOver(stores));

    expect(response.status).toBe(200);
    expect(atWrite).toHaveLength(1);
    expect(atWrite?.[0]?.decision).toContain(OLD_REQUEST);
  });

  it('新しい kind は replaced: false で、置き換えの行は書かない', async () => {
    const response = await post(appOver(stores));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, replaced: false });
    const rows = await decisions(stores);
    expect(rows.some((row) => row.decision.includes('置き換えようとしている'))).toBe(false);
    expect(rows[0]?.decision).toBe(
      `人間が定期の依頼を設定しようとしている: ${KIND}: ${NEW_REQUEST}`,
    );
  });

  it('日誌が書けないときは置き換えず 500（旧本文・旧周期が残る）', async () => {
    await seed();
    const failing: Stores = {
      ...stores,
      journal: {
        ...stores.journal,
        append: () => {
          throw new Error('journal store unavailable (test)');
        },
      },
    };

    let status = 0;
    await captureStderr(async () => {
      status = (await post(appOver(failing))).status;
    });

    expect(status).toBe(500);
    const kept = await stores.schedules.get(KIND);
    expect(kept?.request).toBe(OLD_REQUEST);
    expect(kept?.spec).toEqual(oldSpec);
  });

  it('ifMatch が合えば置き換わり、旧本文が日誌に残り、replaced: true', async () => {
    await seed();

    const response = await post(appOver(stores), { ifMatch: SEEN });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, replaced: true });
    expect((await decisions(stores))[0]?.decision).toContain(OLD_REQUEST);
  });

  it('ifMatch が食い違えば 409 で何も書かない。先の行は打ち消される（既存の挙動）', async () => {
    await seed();

    const response = await post(appOver(stores), { ifMatch: '2000-01-01T00:00:00.000Z' });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ current: { request: OLD_REQUEST } });
    expect((await stores.schedules.get(KIND))?.request).toBe(OLD_REQUEST);
    const rows = await decisions(stores);
    expect(rows).toHaveLength(2);
    expect(rows[1]?.decision).toContain('読んだ後に変わっていた');
  });

  it('ifMatch: null（無いときだけ作る）は既存の kind へは 409 で、置き換えない', async () => {
    await seed();

    const response = await post(appOver(stores), { ifMatch: null });

    expect(response.status).toBe(409);
    expect((await stores.schedules.get(KIND))?.request).toBe(OLD_REQUEST);
  });

  it('ifMatch: null で新しい kind を作ると replaced: false', async () => {
    const response = await post(appOver(stores), { ifMatch: null });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, replaced: false });
  });

  it('読んだ後に別の書き手が書き換えたら、読み直して実際に上書きされる本文を日誌に残す', async () => {
    await seed();
    const real = stores.schedules;
    let interrupted = false;
    stores.schedules = {
      ...real,
      async editRequest(kind, changes, now, options) {
        if (!interrupted) {
          interrupted = true;
          await real.editRequest(
            kind,
            { request: '割り込みで書かれた本文', spec: oldSpec },
            '2026-10-02T00:00:00.000Z',
            {},
          );
        }
        return real.editRequest(kind, changes, now, options);
      },
    };

    const response = await post(appOver(stores));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, replaced: true });
    const text = (await decisions(stores)).map((row) => row.decision).join('\n');
    expect(text).toContain(OLD_REQUEST);
    expect(text).toContain('割り込みで書かれた本文');
  });
});
