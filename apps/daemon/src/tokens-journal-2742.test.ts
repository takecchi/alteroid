import { createTokenPoolService, captureStderr } from '@alteroid/core';
import type { CloneHost, Stores } from '@alteroid/core';
import { createFsStores } from '@alteroid/storage-fs';
import { describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

import { createApp } from './app.js';

/**
 * issue #2742。`PUT /tokens` と `PUT /tokens/policy` は、誰がいつ追加・削除・無効化・
 * 切替・回す設定の変更をしたかを日誌に残す。
 *
 * 決定（2026-10-05、teto＝takecchi の代理）:
 * - 広げる側（追加・有効化・切替・回す契機を有効にする/変える）は日誌が先。書けなければ
 *   状態を変えずに 500。
 * - 狭める側（削除・無効化・`rotateOn: off`）は保存が先。日誌が書けなくても止めない。
 * - 日誌にトークンの値は書かない（id・ラベル・操作の種類だけ）。
 */

const AUTH = { authorization: 'Bearer test-token' };
const V_A = 'dummy-token-value-A-never-journal';
const V_B = 'dummy-token-value-B-never-journal';
const V_C = 'dummy-token-value-C-never-journal';
const V_NEW = 'dummy-token-value-NEW-never-journal';
const ALL_VALUES = [V_A, V_B, V_C, V_NEW];

function stubCloneHost(): CloneHost {
  return {
    post: () => undefined,
    dropQueuedInboxEvents: async () => 0,
    subscribe: () => () => undefined,
    endConversation: async () => undefined,
    answerApproval: async () => undefined,
    managers: {} as CloneHost['managers'],
    usageBlocked: false,
    usageReleasePending: false,
    usageBlockedResetsAt: undefined,
    usageBlockedTokenId: undefined,
    recycleSessionForToken: () => undefined,
    stop: async () => undefined,
  };
}

async function seed(options: { journalDown?: boolean } = {}) {
  const root = await makeTempDir('alteroid-test-');
  const stores = createFsStores(root);
  // a が現役（order 0）。b・c は現役でない行。
  await stores.tokens.replace([
    { id: 'tok-a', label: 'a', value: V_A, source: 'stored', order: 0 },
    { id: 'tok-b', label: 'b', value: V_B, source: 'stored', order: 1 },
    { id: 'tok-c', label: 'c', value: V_C, source: 'stored', order: 2 },
  ]);
  const journalStores: Stores = {
    ...stores,
    journal: {
      ...stores.journal,
      append: async (entry: Parameters<Stores['journal']['append']>[0]) => {
        if (options.journalDown === true) throw new Error(`journal down ${V_A}`);
        return stores.journal.append(entry);
      },
    },
  };
  const app = createApp({
    clone: stubCloneHost(),
    stores: journalStores,
    token: 'test-token',
    shutdown: () => undefined,
    tokens: createTokenPoolService({ stores }),
  });
  return { stores, app };
}

type App = Awaited<ReturnType<typeof seed>>['app'];

async function put(app: App, path: string, body: unknown): Promise<Response> {
  let response: Response | undefined;
  await captureStderr(async () => {
    response = await app.request(path, {
      method: 'PUT',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  });
  return response!;
}

async function journalText(stores: Stores): Promise<string> {
  return JSON.stringify(await stores.journal.list({ types: ['decision'], limit: 100 }));
}

const KEEP = [
  { id: 'tok-a', label: 'a' },
  { id: 'tok-b', label: 'b' },
  { id: 'tok-c', label: 'c' },
];

describe('PUT /tokens の日誌（#2742）', () => {
  it('現役でない行の追加: 日誌に行が出る（id・ラベル・種類。値は出ない）', async () => {
    const { stores, app } = await seed();
    const response = await put(app, '/tokens', {
      tokens: [...KEEP, { label: 'added', value: V_NEW }],
    });
    expect(response.status).toBe(200);
    const text = await journalText(stores);
    expect(text).toContain('added');
    expect(text).toContain('追加');
    for (const value of ALL_VALUES) expect(text).not.toContain(value);
  });

  it('現役でない行の削除: 日誌に行が出る（id・ラベル・種類。値は出ない）', async () => {
    const { stores, app } = await seed();
    const response = await put(app, '/tokens', { tokens: KEEP.slice(0, 2) });
    expect(response.status).toBe(200);
    const text = await journalText(stores);
    expect(text).toContain('tok-c');
    expect(text).toContain('削除');
    for (const value of ALL_VALUES) expect(text).not.toContain(value);
  });

  it('無効化: 日誌に行が出る', async () => {
    const { stores, app } = await seed();
    await put(app, '/tokens', {
      tokens: [KEEP[0], { ...KEEP[1], disabled: true }, KEEP[2]],
    });
    const text = await journalText(stores);
    expect(text).toContain('tok-b');
    expect(text).toContain('無効化');
  });

  it('広げる側（追加）: 日誌が書けなければ保存せず 500', async () => {
    const { stores, app } = await seed({ journalDown: true });
    const response = await put(app, '/tokens', {
      tokens: [...KEEP, { label: 'added', value: V_NEW }],
    });
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain(V_NEW);
    expect((await stores.tokens.list()).map((t) => t.id)).toEqual(['tok-a', 'tok-b', 'tok-c']);
  });

  it('広げる側（有効化）: 日誌が書けなければ保存せず 500。書ければ「有効化」', async () => {
    const disabledPool = async (journalDown: boolean) => {
      const made = await seed({ journalDown });
      const rows = await made.stores.tokens.list();
      await made.stores.tokens.replace(
        rows.map((row) =>
          row.id === 'tok-b' ? { ...row, disabledAt: '2026-01-01T00:00:00.000Z' } : row,
        ),
      );
      return made;
    };
    const enable = { tokens: [KEEP[0], { ...KEEP[1], disabled: false }, KEEP[2]] };
    const down = await disabledPool(true);
    expect((await put(down.app, '/tokens', enable)).status).toBe(500);
    expect(
      (await down.stores.tokens.list()).find((t) => t.id === 'tok-b')?.disabledAt,
    ).toBeDefined();

    const ok = await disabledPool(false);
    expect((await put(ok.app, '/tokens', enable)).status).toBe(200);
    expect(await journalText(ok.stores)).toContain('有効化');
  });

  it('広げる側（並べ替え＝現役が変わりうる）: 日誌が書けなければ保存せず 500。書ければ「切替」', async () => {
    const down = await seed({ journalDown: true });
    const reordered = [KEEP[2], KEEP[0], KEEP[1]];
    const response = await put(down.app, '/tokens', { tokens: reordered });
    expect(response.status).toBe(500);
    expect((await down.stores.tokens.list()).map((t) => t.id)).toEqual(['tok-a', 'tok-b', 'tok-c']);

    const ok = await seed();
    expect((await put(ok.app, '/tokens', { tokens: reordered })).status).toBe(200);
    expect(await journalText(ok.stores)).toContain('切替');
  });

  it('広げる側（値の差し替え）: 日誌は「切替」。値は出ない', async () => {
    const { stores, app } = await seed();
    await put(app, '/tokens', { tokens: [{ ...KEEP[0], value: V_NEW }, KEEP[1], KEEP[2]] });
    const text = await journalText(stores);
    expect(text).toContain('切替');
    for (const value of ALL_VALUES) expect(text).not.toContain(value);
  });

  it('狭める側（削除）: 日誌が書けなくても保存する（止めない）', async () => {
    const { stores, app } = await seed({ journalDown: true });
    const response = await put(app, '/tokens', { tokens: KEEP.slice(0, 2) });
    expect(response.status).toBe(200);
    expect((await stores.tokens.list()).map((t) => t.id)).toEqual(['tok-a', 'tok-b']);
  });

  it('狭める側（無効化）: 日誌が書けなくても保存する', async () => {
    const { stores, app } = await seed({ journalDown: true });
    const response = await put(app, '/tokens', {
      tokens: [KEEP[0], { ...KEEP[1], disabled: true }, KEEP[2]],
    });
    expect(response.status).toBe(200);
    expect((await stores.tokens.list()).find((t) => t.id === 'tok-b')?.disabledAt).toBeDefined();
  });

  it('改名だけ（現役が変わらない）: 狭める側＝保存が先。日誌が書けなくても通る', async () => {
    const { stores, app } = await seed({ journalDown: true });
    const response = await put(app, '/tokens', {
      tokens: [KEEP[0], { id: 'tok-b', label: 'renamed' }, KEEP[2]],
    });
    expect(response.status).toBe(200);
    expect((await stores.tokens.list()).find((t) => t.id === 'tok-b')?.label).toBe('renamed');
  });

  it('混在（削除＋追加）: 広げる側が1つでも在れば全体が日誌先', async () => {
    const { stores, app } = await seed({ journalDown: true });
    const response = await put(app, '/tokens', {
      tokens: [KEEP[0], KEEP[1], { label: 'added', value: V_NEW }],
    });
    expect(response.status).toBe(500);
    expect((await stores.tokens.list()).map((t) => t.id)).toEqual(['tok-a', 'tok-b', 'tok-c']);
  });

  it('差分が無い PUT は日誌を書かない', async () => {
    const { stores, app } = await seed();
    expect((await put(app, '/tokens', { tokens: KEEP })).status).toBe(200);
    expect(await stores.journal.list({ types: ['decision'], limit: 10 })).toEqual([]);
  });
});

describe('PUT /tokens/policy の日誌（#2742）', () => {
  it('rotateOn: off にした: 日誌に行が出る', async () => {
    const { stores, app } = await seed();
    const response = await put(app, '/tokens/policy', { rotateOn: 'off' });
    expect(response.status).toBe(200);
    const text = await journalText(stores);
    expect(text).toContain('rotateOn');
    expect(text).toContain('off');
  });

  it('rotateOn: off は日誌が書けなくても止めない', async () => {
    const { stores, app } = await seed({ journalDown: true });
    const response = await put(app, '/tokens/policy', { rotateOn: 'off' });
    expect(response.status).toBe(200);
    expect((await stores.tokens.readSettings()).rotateOn).toBe('off');
  });

  it('回す契機を有効にする（off → free_exhausted）: 日誌が書けなければ保存せず 500', async () => {
    const down = await seed({ journalDown: true });
    await down.stores.tokens.writeSettings({
      rotateOn: 'off',
      cooldownMs: 1000,
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    const response = await put(down.app, '/tokens/policy', { rotateOn: 'free_exhausted' });
    expect(response.status).toBe(500);
    expect((await down.stores.tokens.readSettings()).rotateOn).toBe('off');
  });

  it('契機を変える・冷却を変える: 日誌が先（書けなければ 500、保存しない）', async () => {
    const { stores, app } = await seed({ journalDown: true });
    const before = await stores.tokens.readSettings();
    expect((await put(app, '/tokens/policy', { rotateOn: 'overage_exhausted' })).status).toBe(500);
    expect((await put(app, '/tokens/policy', { cooldownMs: 1234 })).status).toBe(500);
    expect(await stores.tokens.readSettings()).toEqual(before);
  });
});

/**
 * 日誌が書けなくて保存しなかった 500 は、素の `Internal Server Error` ではなく、
 * 「記録（日誌）が書けなかったので、変更していません」と機械が読める印（`code`）を返す
 * （CLI と Web が利用者に言える形にするため）。例外の本文（値が載りうる）は返さない。
 */
describe('日誌が書けなかった 500 の本文（#2742 の続き）', () => {
  const MESSAGE = '記録（日誌）が書けなかったので、変更していません';

  async function expectJournalFailure(response: Response): Promise<void> {
    expect(response.status).toBe(500);
    expect(response.headers.get('content-type')).toContain('application/json');
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ error: MESSAGE, code: 'journal_write_failed' });
    for (const value of ALL_VALUES) expect(text).not.toContain(value);
    expect(text).not.toContain('journal down');
  }

  it('PUT /tokens（追加）', async () => {
    const { app } = await seed({ journalDown: true });
    await expectJournalFailure(
      await put(app, '/tokens', { tokens: [...KEEP, { label: 'added', value: V_NEW }] }),
    );
  });

  it('PUT /tokens/policy（契機を変える）', async () => {
    const { app } = await seed({ journalDown: true });
    await expectJournalFailure(await put(app, '/tokens/policy', { rotateOn: 'overage_exhausted' }));
  });

  it('PUT /tokens/policy（冷却を変える）', async () => {
    const { app } = await seed({ journalDown: true });
    await expectJournalFailure(await put(app, '/tokens/policy', { cooldownMs: 1234 }));
  });
});
