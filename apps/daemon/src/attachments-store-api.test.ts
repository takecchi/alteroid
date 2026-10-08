import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  createAuthProviderRegistry,
  createAuthService,
  createMemoryStores,
  MemoryAttachmentStore,
  type CloneHost,
} from '@alteroid/core';
import { beforeEach, describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';
import { createApp } from './app.js';

const OPERATOR = { authorization: 'Bearer test-token' };
const bearer = (value: string) => ({ authorization: `Bearer ${value}` });

interface Meta {
  id: string;
  name: string;
  size: number;
  uploadedBy?: string;
  conversationId?: string;
  createdAt: string;
  expiresAt?: string;
  keptAt?: string;
}
interface ListBody {
  items: Meta[];
  nextCursor?: string;
  usage: {
    count: number;
    totalBytes: number;
    byFrom: Record<string, { count: number; totalBytes: number }>;
  };
}

let stores: ReturnType<typeof createMemoryStores>;
let copiesDir: string;
let root: string;

function makeApp(options: { copies?: boolean; now?: () => Date } = {}) {
  return createApp({
    ...(options.now === undefined ? {} : { now: options.now }),
    // 添付の口だけを叩くので、クローンは中身を使わない
    clone: {} as CloneHost,
    stores,
    token: 'test-token',
    shutdown: () => undefined,
    ...(options.copies === false ? {} : { attachmentCopiesDir: copiesDir }),
    auth: {
      plan: {
        enabled: true,
        providers: [],
        publicBaseUrl: 'http://127.0.0.1:4517',
        tokenTtlDays: 30,
        description: 'テスト',
      },
      service: createAuthService({ store: stores.auth, providers: createAuthProviderRegistry([]) }),
    },
  });
}

let app: ReturnType<typeof makeApp>;

beforeEach(async () => {
  stores = createMemoryStores();
  root = await makeTempDir('alteroid-attachments-api-');
  copiesDir = join(root, 'state', 'attachment-copies');
  await mkdir(copiesDir, { recursive: true });
  app = makeApp();
});

const upload = (
  name: string,
  query = '',
  headers: Record<string, string> = OPERATOR,
  body = 'hello',
) =>
  app.request(`/attachments?name=${encodeURIComponent(name)}&type=text%2Fplain${query}`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream', ...headers },
    body,
  });

const uploadOk = async (name: string, query = '', body = 'hello'): Promise<Meta> => {
  const response = await upload(name, query, OPERATOR, body);
  expect(response.status).toBe(200);
  return (await response.json()) as Meta;
};

const list = async (query = ''): Promise<{ status: number; body: ListBody }> => {
  const response = await app.request(`/attachments${query}`, { headers: OPERATOR });
  return { status: response.status, body: (await response.json()) as ListBody };
};

const patch = (id: string, body: unknown, headers: Record<string, string> = OPERATOR) =>
  app.request(`/attachments/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

const del = (id: string, headers: Record<string, string> = OPERATOR) =>
  app.request(`/attachments/${id}`, { method: 'DELETE', headers });

async function issueKey(): Promise<{ id: string; value: string }> {
  const response = await app.request('/integration-keys', {
    method: 'POST',
    headers: { ...OPERATOR, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'ci の鍵', source: 'ci.main' }),
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { key: { id: string }; value: string };
  return { id: body.key.id, value: body.value };
}

describe('GET /attachments（置き場の一覧と使用量）', () => {
  it('登録順: /attachments は一覧、/attachments/limits は上限（id と取り違えない）、/attachments/:id/meta は控え', async () => {
    const meta = await uploadOk('a.txt');

    const listing = await list();
    expect(listing.status).toBe(200);
    expect(listing.body.items.map((item) => item.id)).toEqual([meta.id]);

    const limits = await app.request('/attachments/limits', { headers: OPERATOR });
    expect(limits.status).toBe(200);
    expect(await limits.json()).toMatchObject({ maxImageBytes: expect.any(Number) });

    const metaResponse = await app.request(`/attachments/${meta.id}/meta`, { headers: OPERATOR });
    expect(((await metaResponse.json()) as Meta).id).toBe(meta.id);

    // `limits` という名前の id として扱われる（上限を返さない・500 にもならない）
    expect((await patch('limits', { kept: true })).status).toBe(404);
    expect((await del('limits')).status).toBe(404);
  });

  it('新しい順に返し、usage は絞り込みに関わらず期限内の全体', async () => {
    // 預けた時刻はストアの時計で決まる（実時間で待たない）
    let clock = new Date('2031-03-01T00:00:00.000Z');
    stores = {
      ...createMemoryStores(),
      attachments: new MemoryAttachmentStore({ now: () => clock }),
    };
    app = makeApp({ now: () => clock });
    const first = await uploadOk('first.txt', '', 'a');
    clock = new Date(clock.getTime() + 1000);
    const second = await uploadOk('second.txt', '', 'bbb');

    const listing = await list();
    expect(listing.body.items.map((item) => item.id)).toEqual([second.id, first.id]);
    expect(listing.body.nextCursor).toBeUndefined();
    expect(listing.body.usage.count).toBe(2);
    expect(listing.body.usage.totalBytes).toBe(4);
    // 上げた主体は operator なので human（5つの出所は常に全部在る）
    expect(listing.body.usage.byFrom.human).toEqual({ count: 2, totalBytes: 4 });
    expect(Object.keys(listing.body.usage.byFrom).sort()).toEqual([
      'clone',
      'human',
      'integration',
      'manager',
      'unknown',
    ]);

    const filtered = await list('?q=FIRST');
    expect(filtered.body.items.map((item) => item.id)).toEqual([first.id]);
    expect(filtered.body.usage.count).toBe(2);
  });

  it('kept / from / conversationId / q で絞り込む', async () => {
    const keptOne = await uploadOk('kept.txt', '&keep=1');
    const plain = await uploadOk('plain.txt');
    await stores.attachments.bind([plain.id], 'conv-1');
    await stores.attachments.put({
      name: 'from-clone.txt',
      mediaType: 'text/plain',
      bytes: Uint8Array.of(1),
      uploadedBy: 'clone',
    });

    const ids = async (query: string) => (await list(query)).body.items.map((item) => item.id);
    expect(await ids('?kept=1')).toEqual([keptOne.id]);
    expect(await ids('?kept=true')).toEqual([keptOne.id]);
    expect(await ids('?kept=0')).not.toContain(keptOne.id);
    expect((await list('?kept=false')).body.items).toHaveLength(2);
    expect(await ids('?conversationId=conv-1')).toEqual([plain.id]);
    expect((await list('?from=clone')).body.items.map((item) => item.name)).toEqual([
      'from-clone.txt',
    ]);
    expect((await list('?from=human')).body.items).toHaveLength(2);
    expect((await list('?from=manager')).body.items).toEqual([]);
    expect(await ids('?q=PLAIN&kept=false&from=human')).toEqual([plain.id]);
  });

  it('limit の既定は 50・上限は 200。cursor で続きを取れる', async () => {
    for (let i = 0; i < 52; i += 1) {
      await stores.attachments.put({
        name: `f${String(i).padStart(2, '0')}.txt`,
        mediaType: 'text/plain',
        bytes: Uint8Array.of(1),
      });
    }
    const firstPage = await list();
    expect(firstPage.body.items).toHaveLength(50);
    expect(firstPage.body.nextCursor).toBeDefined();
    const secondPage = await list(`?cursor=${firstPage.body.nextCursor}`);
    expect(secondPage.body.items).toHaveLength(2);
    expect(secondPage.body.nextCursor).toBeUndefined();
    const seen = new Set(
      [...firstPage.body.items, ...secondPage.body.items].map((item) => item.id),
    );
    expect(seen.size).toBe(52);

    expect((await list('?limit=200')).body.items).toHaveLength(52);
    expect((await list('?limit=3')).body.items).toHaveLength(3);
  });

  it.each([
    ['limit=0'],
    ['limit=201'],
    ['limit=abc'],
    ['limit=1.5'],
    ['from=robot'],
    ['kept=maybe'],
    ['cursor=%E3%81%93%E3%82%8C'],
    ['cursor='],
  ])('不正なクエリ %s は 400', async (query) => {
    const response = await app.request(`/attachments?${query}`, { headers: OPERATOR });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: expect.any(String) });
  });

  it('期限切れは一覧にも使用量にも出ない', async () => {
    let clock = new Date();
    stores = {
      ...createMemoryStores(),
      attachments: new MemoryAttachmentStore({ now: () => clock }),
    };
    app = makeApp({ now: () => clock });
    const expiring = await uploadOk('old.txt');
    const keptOne = await uploadOk('kept.txt', '&keep=1');

    clock = new Date(clock.getTime() + 40 * 86_400_000);
    const listing = await list();
    expect(listing.body.items.map((item) => item.id)).toEqual([keptOne.id]);
    expect(listing.body.usage.count).toBe(1);
    expect(
      (await app.request(`/attachments/${expiring.id}/meta`, { headers: OPERATOR })).status,
    ).toBe(404);
    // 期限切れには保存の印も付けられず、消す操作も「無い」
    expect((await patch(expiring.id, { kept: true })).status).toBe(404);
    expect((await del(expiring.id)).status).toBe(404);
  });
});

describe('POST /attachments?keep=1（預けた時点で保存の印）', () => {
  it('keptAt が付き expiresAt が無い。未結び付けでも期限でも掃除で消えない', async () => {
    const meta = await uploadOk('kept.txt', '&keep=1');
    expect(meta.keptAt).toBeDefined();
    expect(meta.expiresAt).toBeUndefined();

    expect(await stores.attachments.prune(new Date('2100-01-01T00:00:00Z'))).toBe(0);
    const got = await app.request(`/attachments/${meta.id}/meta`, { headers: OPERATOR });
    expect(got.status).toBe(200);
  });

  it('keep を付けない・keep=0 は従来どおり期限つき', async () => {
    for (const query of ['', '&keep=0', '&keep=false']) {
      const meta = await uploadOk('plain.txt', query);
      expect(meta.keptAt).toBeUndefined();
      expect(meta.expiresAt).toBeDefined();
    }
  });

  it('keep の値が不正なら 400（預けない）', async () => {
    const response = await upload('x.txt', '&keep=yes');
    expect(response.status).toBe(400);
    expect((await list()).body.items).toEqual([]);
  });
});

describe('PATCH /attachments/:id（保存の印を付ける・外す）', () => {
  it('付けると keptAt が入り expiresAt が消え、外すと expiresAt が戻る', async () => {
    const meta = await uploadOk('a.txt');
    expect(meta.expiresAt).toBeDefined();

    const kept = await patch(meta.id, { kept: true });
    expect(kept.status).toBe(200);
    const keptBody = (await kept.json()) as Meta;
    expect(keptBody.keptAt).toBeDefined();
    expect(keptBody.expiresAt).toBeUndefined();
    expect(keptBody.id).toBe(meta.id);
    expect((await list('?kept=1')).body.items.map((item) => item.id)).toEqual([meta.id]);

    const unkept = await patch(meta.id, { kept: false });
    expect(unkept.status).toBe(200);
    const unkeptBody = (await unkept.json()) as Meta;
    expect(unkeptBody.keptAt).toBeUndefined();
    // 外した時刻から保持日数（既定 30 日）後
    const days = (Date.parse(unkeptBody.expiresAt!) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThanOrEqual(30);
  });

  it('無い id は 404、本文が不正なら 400（何も変えない）', async () => {
    expect((await patch('no-such-id', { kept: true })).status).toBe(404);
    const meta = await uploadOk('a.txt');
    for (const body of [{}, { kept: 'yes' }, { kept: 1 }, []]) {
      expect((await patch(meta.id, body)).status).toBe(400);
    }
    const after = await app.request(`/attachments/${meta.id}/meta`, { headers: OPERATOR });
    expect(((await after.json()) as Meta).keptAt).toBeUndefined();
  });
});

describe('DELETE /attachments/:id（保存したものも消す）', () => {
  it('消すと 204、控えも中身も無くなり、2度目は 404', async () => {
    const keptOne = await uploadOk('kept.txt', '&keep=1');
    const plain = await uploadOk('plain.txt');

    expect((await del(keptOne.id)).status).toBe(204);
    expect((await del(plain.id)).status).toBe(204);
    for (const id of [keptOne.id, plain.id]) {
      expect((await app.request(`/attachments/${id}`, { headers: OPERATOR })).status).toBe(404);
      expect((await app.request(`/attachments/${id}/meta`, { headers: OPERATOR })).status).toBe(
        404,
      );
      expect((await del(id)).status).toBe(404);
    }
    expect((await list()).body.usage.count).toBe(0);
  });

  it('その id の attachment_fetch の写しも消す（ほかの id の写しは残す）', async () => {
    const target = await uploadOk('a.txt');
    const other = await uploadOk('b.txt');
    for (const id of [target.id, other.id]) {
      await mkdir(join(copiesDir, id), { recursive: true });
      await writeFile(join(copiesDir, id, 'copy.txt'), 'copy');
    }

    expect((await del(target.id)).status).toBe(204);
    expect(await readdir(copiesDir)).toEqual([other.id]);
  });

  it('本体が無くても写しは消す（404 のまま）', async () => {
    const orphan = '11111111-2222-3333-4444-555555555555';
    await mkdir(join(copiesDir, orphan), { recursive: true });
    await writeFile(join(copiesDir, orphan, 'copy.txt'), 'copy');

    expect((await del(orphan)).status).toBe(404);
    expect(await readdir(copiesDir)).toEqual([]);
  });

  it('id にパス区切りや .. を入れても、写しの置き場の外は消さない', async () => {
    await mkdir(join(root, 'state', 'precious'), { recursive: true });
    await writeFile(join(root, 'state', 'precious', 'keep.txt'), 'keep');
    for (const id of ['..%2Fprecious', '..%2F..%2Fstate%2Fprecious', '%2e%2e%2Fprecious']) {
      expect(
        (await app.request(`/attachments/${id}`, { method: 'DELETE', headers: OPERATOR })).status,
      ).toBe(404);
    }
    expect((await stat(join(root, 'state', 'precious', 'keep.txt'))).isFile()).toBe(true);
  });

  it('写しの置き場を渡していない構成でも消せる', async () => {
    app = makeApp({ copies: false });
    const meta = await uploadOk('a.txt');
    expect((await del(meta.id)).status).toBe(204);
  });
});

describe('連携の鍵（altk_）は POST /attachments だけ通り、keep は付けられない', () => {
  it('鍵は keep なしで上げられ、keep=1 は 403（何も預からない）', async () => {
    const key = await issueKey();

    const ok = await upload('k.txt', '', bearer(key.value));
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as Meta).uploadedBy).toBe(`integration:${key.id}`);

    for (const query of ['&keep=1', '&keep=true']) {
      const refused = await upload('k2.txt', query, bearer(key.value));
      expect(refused.status).toBe(403);
      expect(await refused.json()).toMatchObject({ error: expect.stringContaining('keep') });
    }
    expect((await list()).body.items).toHaveLength(1);
    // 鍵が keep なしで預けたものは、期限つきのまま
    expect((await list()).body.items[0]!.keptAt).toBeUndefined();
  });

  it('鍵は GET /attachments（一覧）・PATCH・DELETE が 403 で、置き場は何も変わらない', async () => {
    const key = await issueKey();
    const meta = await uploadOk('mine.txt');

    const headers = bearer(key.value);
    const listing = await app.request('/attachments', { headers });
    expect(listing.status).toBe(403);
    expect(await listing.text()).not.toContain(meta.id);
    expect((await patch(meta.id, { kept: true }, headers)).status).toBe(403);
    expect((await del(meta.id, headers)).status).toBe(403);
    expect((await app.request('/attachments/limits', { headers })).status).toBe(403);
    expect((await app.request(`/attachments/${meta.id}`, { headers })).status).toBe(403);

    const after = (await list()).body.items;
    expect(after.map((item) => item.id)).toEqual([meta.id]);
    expect(after[0]!.keptAt).toBeUndefined();
  });
});

describe('POST /reset は添付（保存したものを含む）と写しを消す（#4006）', () => {
  it('件数を申告し、本体も写しの置き場も空になる。置き場の外は残る', async () => {
    const keptOne = await uploadOk('kept.txt', '&keep=1');
    const plain = await uploadOk('plain.txt');
    for (const id of [keptOne.id, plain.id]) {
      await mkdir(join(copiesDir, id), { recursive: true });
      await writeFile(join(copiesDir, id, 'copy.txt'), 'copy');
    }
    await writeFile(join(root, 'state', 'other.txt'), 'other');

    const response = await app.request('/reset', {
      method: 'POST',
      headers: { ...OPERATOR, 'content-type': 'application/json' },
      body: JSON.stringify({ confirm: true }),
    });
    expect(response.status).toBe(200);
    expect(
      ((await response.json()) as { cleared: Record<string, number> }).cleared.attachments,
    ).toBe(2);

    expect((await list()).body.items).toEqual([]);
    expect((await list()).body.usage.count).toBe(0);
    for (const id of [keptOne.id, plain.id]) {
      expect((await app.request(`/attachments/${id}`, { headers: OPERATOR })).status).toBe(404);
    }
    await expect(stat(copiesDir)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await stat(join(root, 'state', 'other.txt'))).isFile()).toBe(true);
  });

  it('写しの置き場がまだ無くても、置き場を渡していなくても 200', async () => {
    const withoutDir = makeApp({ copies: false });
    await uploadOk('plain.txt');
    const response = await withoutDir.request('/reset', {
      method: 'POST',
      headers: { ...OPERATOR, 'content-type': 'application/json' },
      body: JSON.stringify({ confirm: true }),
    });
    expect(response.status).toBe(200);
    expect(
      ((await response.json()) as { cleared: Record<string, number> }).cleared.attachments,
    ).toBe(1);
  });
});
