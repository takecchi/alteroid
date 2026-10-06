import {
  ATTACHMENT_UNBOUND_TTL_MS,
  AttachmentRejectedError,
  type AttachmentStore,
} from './attachment.js';

/**
 * `AttachmentStore`（#3111 段1a）の契約を、実装1つに対して測る。
 *
 * **vitest に依存しない素の非同期関数にしてある**（`archive-contract.ts` と同じ理由。
 * `packages/storage-fs` / `packages/storage-pg` へ vitest を持ち込まない）。食い違ったら `throw` する。
 * 3実装（インメモリ / fs / pg）すべてがこれを呼ぶこと。
 *
 * 測る性質:
 * 1. `put` が sha256・size・名前の正規化・期限を持つ控えを返す
 * 2. `get` が中身をそのまま返し、`getMeta` が同じ控えを返す。無い id・NUL を含む id は `undefined`
 * 3. 宣言 MIME が画像なのに中身が一致しなければ `magic_mismatch` で断る。上限超過は `too_large`
 * 4. `bind` は未結び付けを結び付け（冪等）、別の会話へ結び付いたものは `conflicts`、無いものは `missing`
 * 5. `prune` は①未結び付けのまま1時間たったもの②期限を過ぎたものだけを消し、消した件数を返す。
 *    結び付いた期限内のものは残す
 */
export async function verifyAttachmentStoreContract(store: AttachmentStore): Promise<void> {
  const fail = (message: string): never => {
    throw new Error(`AttachmentStore 契約違反: ${message}`);
  };
  const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
  const same = (a: Uint8Array, b: Uint8Array) =>
    a.length === b.length && a.every((v, i) => v === b[i]);

  // 1 + 2
  const meta = await store.put({
    name: 'a/b\\c\u0000.png',
    mediaType: 'Image/PNG; x=y',
    bytes: PNG,
  });
  if (meta.name !== 'a_b_c.png') fail(`名前の正規化: ${meta.name}`);
  if (meta.mediaType !== 'image/png') fail(`MIME の正規化: ${meta.mediaType}`);
  if (meta.size !== PNG.length) fail('size');
  if (!/^[0-9a-f]{64}$/.test(meta.sha256)) fail('sha256 の形');
  if (meta.conversationId !== undefined) fail('未結び付けの put に conversationId が付いた');
  if (meta.uploadedBy !== undefined) fail('uploadedBy を渡さない put に uploadedBy が付いた');
  if (!(Date.parse(meta.expiresAt) > Date.parse(meta.createdAt))) fail('expiresAt > createdAt');
  const got = await store.get(meta.id);
  if (got === undefined || !same(got.bytes, PNG)) fail('get が中身を返さない');
  if (JSON.stringify(got?.meta) !== JSON.stringify(meta)) fail('get の meta が put と違う');
  if (JSON.stringify(await store.getMeta(meta.id)) !== JSON.stringify(meta)) fail('getMeta');
  if ((await store.get('no-such-id')) !== undefined) fail('無い id の get');
  if ((await store.getMeta('no-such-id')) !== undefined) fail('無い id の getMeta');
  if ((await store.get('x\u0000y')) !== undefined) fail('NUL を含む id の get は undefined');
  if ((await store.getMeta('x\u0000y')) !== undefined)
    fail('NUL を含む id の getMeta は undefined');

  // 3
  const rejected = async (run: () => Promise<unknown>, code: string) => {
    try {
      await run();
    } catch (error) {
      if (error instanceof AttachmentRejectedError && error.code === code) return;
      throw error;
    }
    fail(`${code} で断られなかった`);
  };
  await rejected(
    () => store.put({ name: 'x.png', mediaType: 'image/png', bytes: Uint8Array.from([1, 2, 3]) }),
    'magic_mismatch',
  );
  await rejected(
    () => store.put({ name: 'x.jpg', mediaType: 'image/jpeg', bytes: PNG }),
    'magic_mismatch',
  );
  const big = new Uint8Array(5 * 1024 * 1024 + 1);
  big.set(PNG);
  await rejected(
    () => store.put({ name: 'big.png', mediaType: 'image/png', bytes: big }),
    'too_large',
  );
  // 画像でない宣言は、中身を問わず通る（上限は画像より大きい）
  const text = await store.put({
    name: 'n.txt',
    mediaType: 'text/plain',
    bytes: new TextEncoder().encode('hello'),
  });
  if (text.size !== 5) fail('テキストの put');

  // 4
  const bound = await store.put({ name: 'b.txt', mediaType: 'text/plain', bytes: PNG });
  const first = await store.bind([bound.id, 'no-such-id'], 'conv-1');
  if (
    first.bound.join() !== bound.id ||
    first.missing.join() !== 'no-such-id' ||
    first.conflicts.length > 0
  ) {
    fail(`bind の結果: ${JSON.stringify(first)}`);
  }
  if ((await store.getMeta(bound.id))?.conversationId !== 'conv-1')
    fail('bind が控えへ反映されない');
  const again = await store.bind([bound.id], 'conv-1');
  if (again.bound.join() !== bound.id) fail('同じ会話への bind は冪等');
  const other = await store.bind([bound.id], 'conv-2');
  if (other.conflicts.join() !== bound.id || other.bound.length > 0)
    fail('別の会話への bind は conflicts');
  if ((await store.getMeta(bound.id))?.conversationId !== 'conv-1')
    fail('conflicts が結び付けを書き換えた');

  // 5
  const t0 = Date.now();
  const sooner = new Date(t0 + ATTACHMENT_UNBOUND_TTL_MS - 5 * 60_000);
  if ((await store.prune(sooner)) !== 0) fail('1時間たつ前に何かが消えた');
  const stillThere = await store.getMeta(text.id);
  if (stillThere === undefined) fail('1時間たつ前に未結び付けが消えた');
  // 1時間+α: 未結び付け（meta・text）は消え、結び付いた bound は残る
  const afterHour = new Date(t0 + ATTACHMENT_UNBOUND_TTL_MS + 5 * 60_000);
  const removed = await store.prune(afterHour);
  if (removed !== 2) fail(`未結び付けの掃除: ${removed} 件（2 件のはず）`);
  if ((await store.getMeta(meta.id)) !== undefined) fail('未結び付けが残った');
  if ((await store.get(text.id)) !== undefined) fail('未結び付けの中身が残った');
  if ((await store.getMeta(bound.id)) === undefined) fail('結び付いた期限内のものが消えた');
  // 期限切れ: 結び付いていても消える
  const expiry = new Date(Date.parse(bound.expiresAt) + 1000);
  if ((await store.prune(expiry)) !== 1) fail('期限切れの掃除');
  if ((await store.get(bound.id)) !== undefined) fail('期限切れが残った');
  if ((await store.prune(expiry)) !== 0) fail('掃除は冪等');

  // uploadedBy（上げた主体の識別子。中身ではない）
  const uploaded = await store.put({
    name: 'u.png',
    mediaType: 'image/png',
    bytes: PNG,
    uploadedBy: 'account:a1',
  });
  if (uploaded.uploadedBy !== 'account:a1') fail('put が uploadedBy を返さない');
  if ((await store.getMeta(uploaded.id))?.uploadedBy !== 'account:a1') fail('getMeta の uploadedBy');
  if ((await store.get(uploaded.id))?.meta.uploadedBy !== 'account:a1') fail('get の uploadedBy');
}
