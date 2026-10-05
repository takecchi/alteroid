import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { CloneHost, Stores } from '@alteroid/core';
import { createCloneTools } from '@alteroid/core';
import { createFsStores } from '@alteroid/storage-fs';
import { createPgStoresFromDb, tables } from '@alteroid/storage-pg';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

import { createApp } from './app.js';
import { createMigratedPglite, migratedTemplate } from './pglite-template.test-support.js';

// 雛形の前払い（#3034）。最初の `beforeEach`（hookTimeout 10s）で WASM の起動 + migrate を
// 払わせない。
beforeAll(async () => {
  await migratedTemplate();
}, 60_000);

/**
 * issue #2148。
 *
 * 読めない約束（`UnreadableCommitmentError` になる行）を、HTTP でも道具でも
 * 直す・閉じる口が実質無かった——呼び手の口（`PATCH /commitments/:id`・道具 `commitment_close` /
 * `commitment_edit`）が先に `commitments.get(id)` を
 * 無条件に呼んで投げていた。マネージャーの決定（issue 本文へのコメント）は:
 *
 * - (1) `POST /commitments/:id/close` と道具 `commitment_close` は、読めない
 *   約束も閉じられるようにする（fs / pg 両方）。
 * - (2) 本文の書き直し（`PATCH` / `commitment_edit`）はこの issue ではやらない。
 * - (3) 上の口は、読めない約束を 500 / 生の isError ではなく、409 /
 *   理由の分かる isError で名乗る。
 *
 * ここでは fs / pg の両方で、`origin` が既知の値でない（`commitmentOriginSchema`
 * = `z.enum(['human', 'manager', 'external', 'self'])` に違反する）壊れた行を
 * 直接書き（版ずれ・手編集を模す）、次を確かめる。
 */

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

const json = (body: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

const BAD_ID = 'bad-commitment';
const BAD_BODY = '壊れた約束の本文（跡に出てはいけない）';
const BAD_AT = '2026-09-02T00:00:00.000Z';

/** `origin` が既知の値でない壊れた行を fs の commitments.json へ直接書く。 */
async function fsStoresWithBadRow(): Promise<Stores> {
  const root = await makeTempDir('alteroid-test-');
  const stores = createFsStores(root);
  await stores.commitments.open({
    id: 'good-commitment',
    at: BAD_AT,
    origin: 'self',
    body: '正常な約束',
  });
  // `FsCommitmentStore` は `paths.jobs` に commitments.json を置く
  // （`packages/storage-fs/src/index.ts` の `createFsStores`）。
  const commitmentsPath = join(root, 'jobs', 'commitments.json');
  const raw = JSON.parse(await readFile(commitmentsPath, 'utf8')) as { commitments: unknown[] };
  raw.commitments.push({
    id: BAD_ID,
    at: BAD_AT,
    origin: 'bogus',
    body: BAD_BODY,
  });
  await writeFile(commitmentsPath, JSON.stringify(raw, null, 2), 'utf8');
  return stores;
}

/** `origin` が既知の値でない壊れた行を pg の `commitments` 表へ直接 insert する。 */
async function pgStoresWithBadRow(): Promise<Stores> {
  const { db } = await createMigratedPglite();
  const stores = createPgStoresFromDb(db);
  await stores.commitments.open({
    id: 'good-commitment',
    at: BAD_AT,
    origin: 'self',
    body: '正常な約束',
  });
  await db.insert(tables.commitments).values({
    id: BAD_ID,
    at: new Date(BAD_AT),
    closedAt: null,
    commitment: { id: BAD_ID, at: BAD_AT, origin: 'bogus', body: BAD_BODY },
  });
  return stores;
}

/**
 * `createCloneTools` から道具を直接呼ぶ最小の器。
 *
 * **SDK（`@modelcontextprotocol/sdk`）の `McpServer` が例外を
 * `{ content: [...], isError: true }` へ変換する層をここは通らない**
 * （`packages/core/src/tools.test.ts` の `callExpectingError` と同じ形——
 * その doc に確認済みの変換の逐語がある）。だからここでも同じ形で模す:
 * ハンドラが投げたら `isError: true` として拾い、投げなければ結果の
 * `isError` をそのまま見る。
 */
function toolCaller(stores: Stores) {
  const tools = createCloneTools({
    stores,
    emit: () => undefined,
    conversationId: () => undefined,
    memoryCause: () => 'clone',
  });
  return async (
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ text: string; isError: boolean }> => {
    const found = tools.find((entry) => entry.name === name);
    if (!found) throw new Error(`ツール ${name} が無い`);
    try {
      const result = await found.handler(args as never, {});
      const text = (result.content ?? [])
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join('');
      return { text, isError: (result as { isError?: boolean }).isError === true };
    } catch (error) {
      return { text: error instanceof Error ? error.message : String(error), isError: true };
    }
  };
}

describe.each([
  ['fs', fsStoresWithBadRow],
  ['pg', pgStoresWithBadRow],
] as const)('読めない約束を直す・閉じる口（%s 実装。issue #2148）', (_label, makeStores) => {
  let stores: Stores;
  let app: ReturnType<typeof createApp>;

  beforeEach(async () => {
    stores = await makeStores();
    app = createApp({
      clone: stubCloneHost(),
      stores,
      token: 'test-token',
      shutdown: () => undefined,
    });
  });

  describe('(1) 閉じる', () => {
    it('POST /commitments/:id/close は読めない約束も閉じられる（直す前は500）', async () => {
      const close = await app.request(`/commitments/${BAD_ID}/close`, json({ reason: '閉じた' }));
      const body = (await close.json().catch(() => undefined)) as unknown;
      expect(close.status, `本文: ${JSON.stringify(body)}`).toBe(200);
    });

    it('閉じた後、既定の一覧（includeClosed 省略）には出ない', async () => {
      await app.request(`/commitments/${BAD_ID}/close`, json({ reason: '閉じた' }));
      const list = await app.request('/commitments');
      const listBody = (await list.json()) as { unreadable: { id?: string }[] };
      expect(listBody.unreadable.map((row) => row.id)).not.toContain(BAD_ID);
    });

    it('閉じた後、includeClosed=true では unreadable に残る（entries には出ない・本文は漏れない）', async () => {
      await app.request(`/commitments/${BAD_ID}/close`, json({ reason: '閉じた' }));
      const list = await app.request('/commitments?includeClosed=true');
      const listBody = (await list.json()) as {
        entries: { id: string }[];
        unreadable: { id?: string }[];
      };
      expect(listBody.unreadable.map((row) => row.id)).toContain(BAD_ID);
      expect(listBody.entries.map((entry) => entry.id)).not.toContain(BAD_ID);
      expect(JSON.stringify(listBody)).not.toContain(BAD_BODY);
    });

    it('既に閉じた読めない約束をもう一度閉じようとすると 409（本文は漏れない）', async () => {
      await app.request(`/commitments/${BAD_ID}/close`, json({ reason: '閉じた' }));
      const again = await app.request(`/commitments/${BAD_ID}/close`, json({ reason: 'もう一度' }));
      const body = (await again.json()) as { error: string };
      expect(again.status).toBe(409);
      expect(body.error).not.toContain(BAD_BODY);
    });

    it('本当に無い id は今までどおり 404', async () => {
      const close = await app.request('/commitments/never-existed/close', json({ reason: 'x' }));
      expect(close.status).toBe(404);
    });

    it('commitment_close は読めない約束も閉じられる（本文は漏れない）', async () => {
      const call = toolCaller(stores);
      const result = await call('commitment_close', { id: BAD_ID, reason: '閉じた' });
      expect(result.isError).toBe(false);
      expect(result.text).toContain('読めない形で入っていた');
      expect(result.text).toContain('片付けた');
      expect(result.text).not.toContain(BAD_BODY);

      const list = await stores.commitments.list({ includeClosed: true });
      expect(list.unreadable.some((row) => row.id === BAD_ID)).toBe(true);
    });

    it('commitment_close で既に閉じた読めない約束をもう一度閉じようとすると、その旨を平文で返す（isError にはしない）', async () => {
      const call = toolCaller(stores);
      await call('commitment_close', { id: BAD_ID, reason: '閉じた' });
      const again = await call('commitment_close', { id: BAD_ID, reason: 'もう一度' });
      expect(again.isError).toBe(false);
      expect(again.text).toContain('読めない形で入っているため');
      expect(again.text).not.toContain(BAD_BODY);
    });

    it('commitment_close は本当に無い id なら今までどおり', async () => {
      const call = toolCaller(stores);
      const result = await call('commitment_close', { id: 'never-existed', reason: 'x' });
      expect(result.isError).toBe(false);
      expect(result.text).toContain('台帳');
    });
  });

  describe('(3) 名乗る（本文の書き直しは通さない）', () => {
    it('PATCH /commitments/:id は読めない約束で 409（本文は漏れない）', async () => {
      const patch = await app.request(`/commitments/${BAD_ID}`, {
        ...json({ body: '書き直したい' }),
        method: 'PATCH',
      });
      const body = (await patch.json()) as { error: string };
      expect(patch.status, `本文: ${JSON.stringify(body)}`).toBe(409);
      expect(body.error).toContain('close');
      expect(body.error).not.toContain(BAD_BODY);
    });

    it('commitment_edit は読めない約束で isError（本文は漏れない）', async () => {
      const call = toolCaller(stores);
      const result = await call('commitment_edit', { id: BAD_ID, body: '書き直したい' });
      expect(result.isError).toBe(true);
      expect(result.text).toContain('close');
      expect(result.text).not.toContain(BAD_BODY);
    });

    it('本当に無い id は PATCH でも今までどおり 404', async () => {
      const patch = await app.request('/commitments/never-existed', {
        ...json({ body: 'x' }),
        method: 'PATCH',
      });
      expect(patch.status).toBe(404);
    });
  });
});
