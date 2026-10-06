import {
  ATTACHMENT_NAME_MAX_LENGTH,
  ATTACHMENT_UNBOUND_TTL_MS,
  AttachmentRejectedError,
  DEFAULT_ATTACHMENT_LIMITS,
  normalizeAttachmentName,
  type AttachmentStore,
  type AttachmentStoreOptions,
} from './attachment.js';

export interface AttachmentStoreContractOptions {
  /**
   * 設定（`limits` / `now`）を指定して**空の**ストアを作る口。**渡されたときだけ**、境界ちょうどのサイズ・
   * `expiresAt` / 1時間ちょうどの `prune`・`bind` と `prune` の並行を測る（大きなバッファを作らずに済むよう
   * 上限を小さくしたストアで測る。他の節と件数を取り合わないよう、空のストアで測る）。
   */
  readonly createStore?: (
    options: AttachmentStoreOptions,
  ) => AttachmentStore | Promise<AttachmentStore>;
}

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
 * 8. 長い名前（255 を超える・マルチバイト）の往復、複数・重複した id の `bind`（`store` で測る）
 * 9. （`createStore` を渡したとき）サイズの境界ちょうど・`expiresAt` ちょうどと1時間ちょうどの `prune`・
 *    `bind` と `prune` の並行（空のストアで測る）
 *    **0バイトの扱いは測らない**（#3327 で決める）
 * 7. `unbind`（#3270）は、その結び付け先に結ばれている id だけを未結び付けへ戻して返す。別の宛先・未結び付け・
 *    無い id は触らない（返さない）。冪等。戻したものは掃除の対象に戻る
 * 6. `bindToExternalEvent`（#3113 段3）も `bind` と同じ規則（冪等・別の宛先は `conflicts`・無いものは `missing`）。
 *    会話と外部イベントは**互いに別の宛先**で、どちらか一方へ結んだものは他方へ結べない。外部イベントへ
 *    結び付いたものは、未結び付けの掃除（1時間）で消えない
 */
export async function verifyAttachmentStoreContract(
  store: AttachmentStore,
  contractOptions: AttachmentStoreContractOptions = {},
): Promise<void> {
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
  if ((await store.getMeta(uploaded.id))?.uploadedBy !== 'account:a1')
    fail('getMeta の uploadedBy');
  if ((await store.get(uploaded.id))?.meta.uploadedBy !== 'account:a1') fail('get の uploadedBy');

  // 6: 外部イベントへの結び付け
  const toEvent = await store.put({ name: 'e.png', mediaType: 'image/png', bytes: PNG });
  const toConv = await store.put({ name: 'c.png', mediaType: 'image/png', bytes: PNG });
  const loose = await store.put({ name: 'l.png', mediaType: 'image/png', bytes: PNG });
  const evFirst = await store.bindToExternalEvent([toEvent.id, 'no-such-id'], 'ev-1');
  if (
    evFirst.bound.join() !== toEvent.id ||
    evFirst.missing.join() !== 'no-such-id' ||
    evFirst.conflicts.length > 0
  ) {
    fail(`bindToExternalEvent の結果: ${JSON.stringify(evFirst)}`);
  }
  const evMeta = await store.getMeta(toEvent.id);
  if (evMeta?.externalEventId !== 'ev-1') fail('bindToExternalEvent が控えへ反映されない');
  if (evMeta?.conversationId !== undefined)
    fail('外部イベントへの結び付けが conversationId を立てた');
  if ((await store.bindToExternalEvent([toEvent.id], 'ev-1')).bound.join() !== toEvent.id)
    fail('同じ外部イベントへの bindToExternalEvent は冪等');
  const evOther = await store.bindToExternalEvent([toEvent.id], 'ev-2');
  if (evOther.conflicts.join() !== toEvent.id || evOther.bound.length > 0)
    fail('別の外部イベントへの bindToExternalEvent は conflicts');
  const evToConv = await store.bind([toEvent.id], 'conv-x');
  if (evToConv.conflicts.join() !== toEvent.id || evToConv.bound.length > 0)
    fail('外部イベントへ結び付いたものを会話へ bind できた');
  if ((await store.bind([toConv.id], 'conv-y')).bound.join() !== toConv.id) fail('会話への bind');
  const convToEv = await store.bindToExternalEvent([toConv.id], 'ev-3');
  if (convToEv.conflicts.join() !== toConv.id || convToEv.bound.length > 0)
    fail('会話へ結び付いたものを外部イベントへ結べた');
  const afterBinds = await store.getMeta(toEvent.id);
  if (afterBinds?.externalEventId !== 'ev-1' || afterBinds.conversationId !== undefined)
    fail('conflicts が外部イベントの結び付けを書き換えた');
  // 外部イベントへ結び付いたものは、未結び付けの掃除で消えない（未結び付けの loose と、上の uploadedBy の
  // 節で上げた `uploaded` の2件だけが消える）
  const later = new Date(Date.now() + ATTACHMENT_UNBOUND_TTL_MS + 5 * 60_000);
  if ((await store.prune(later)) !== 2)
    fail('未結び付けの掃除の件数（loose と uploaded の2件のはず）');
  if ((await store.getMeta(loose.id)) !== undefined) fail('未結び付けが残った');
  if ((await store.getMeta(toEvent.id)) === undefined)
    fail('外部イベントへ結び付いたものが掃除で消えた');
  if ((await store.getMeta(toConv.id)) === undefined) fail('会話へ結び付いたものが掃除で消えた');

  // 7: unbind（部分的に結ぶ bind / bindToExternalEvent の取り消し。**その宛先に結ばれている id だけ**を戻す）
  const uc1 = await store.put({ name: 'u1.png', mediaType: 'image/png', bytes: PNG });
  const uc2 = await store.put({ name: 'u2.png', mediaType: 'image/png', bytes: PNG });
  const ue1 = await store.put({ name: 'u3.png', mediaType: 'image/png', bytes: PNG });
  const unb = await store.put({ name: 'u4.png', mediaType: 'image/png', bytes: PNG });
  await store.bind([uc1.id], 'conv-u1');
  await store.bind([uc2.id], 'conv-u2');
  await store.bindToExternalEvent([ue1.id], 'ev-u1');
  const undone = await store.unbind([uc1.id, uc2.id, ue1.id, unb.id, 'no-such-id', uc1.id], {
    conversationId: 'conv-u1',
  });
  if (undone.join() !== uc1.id) fail(`unbind の戻り値: ${JSON.stringify(undone)}`);
  if ((await store.getMeta(uc1.id))?.conversationId !== undefined)
    fail('unbind が結び付けを戻さない');
  if ((await store.getMeta(uc2.id))?.conversationId !== 'conv-u2')
    fail('unbind が別の会話の結び付けを外した');
  if ((await store.getMeta(ue1.id))?.externalEventId !== 'ev-u1')
    fail('会話の unbind が外部イベントの結び付けを外した');
  if ((await store.unbind([uc1.id], { conversationId: 'conv-u1' })).length > 0)
    fail('unbind は冪等（戻したものを再度戻したと返さない）');
  if ((await store.unbind([ue1.id], { externalEventId: 'ev-other' })).length > 0)
    fail('unbind が別の外部イベントの結び付けを外した');
  if ((await store.unbind([uc2.id], { externalEventId: 'conv-u2' })).length > 0)
    fail('外部イベントの unbind が会話の結び付けを外した');
  if ((await store.unbind([ue1.id], { externalEventId: 'ev-u1' })).join() !== ue1.id)
    fail('外部イベントの unbind が戻さない');
  const ue1After = await store.getMeta(ue1.id);
  if (ue1After?.externalEventId !== undefined || ue1After?.conversationId !== undefined)
    fail('外部イベントの unbind が結び付けを残した');
  // 戻したものは別の宛先へ結べる。戻していないものは結べない
  if ((await store.bind([uc1.id], 'conv-u3')).bound.join() !== uc1.id)
    fail('unbind したものを別の会話へ bind できない');
  if ((await store.bind([uc2.id], 'conv-u3')).conflicts.join() !== uc2.id)
    fail('unbind の対象外だったものが別の会話へ結べた');

  // 8: 長い名前（マルチバイトを含む）の往復
  const longNames = [
    'あ'.repeat(300) + '.txt',
    '😀'.repeat(200) + '.txt', // サロゲートペアの途中で切れても壊れた文字を残さない
    'x'.repeat(ATTACHMENT_NAME_MAX_LENGTH),
    'y'.repeat(ATTACHMENT_NAME_MAX_LENGTH + 1),
  ];
  for (const raw of longNames) {
    const long = await store.put({ name: raw, mediaType: 'text/plain', bytes: PNG });
    const expected = normalizeAttachmentName(raw);
    if (long.name !== expected)
      fail(`長い名前の正規化が core の規則と違う: ${long.name.slice(0, 20)}…`);
    if (long.name.length > ATTACHMENT_NAME_MAX_LENGTH) fail('名前が上限を超えて残った');
    if (/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(long.name))
      fail('名前に孤立サロゲートが残った');
    if ((await store.getMeta(long.id))?.name !== expected) fail('getMeta の長い名前が往復しない');
    if ((await store.get(long.id))?.meta.name !== expected) fail('get の長い名前が往復しない');
  }

  // 8: 複数・重複した id の bind（重複を何回数えるかは実装に任せ、結び付いたか・無いか・衝突かだけを見る）
  const m1 = await store.put({ name: 'm1.txt', mediaType: 'text/plain', bytes: PNG });
  const m2 = await store.put({ name: 'm2.txt', mediaType: 'text/plain', bytes: PNG });
  const multi = await store.bind([m1.id, m2.id, m1.id, 'no-such-multi', 'no-such-multi'], 'conv-m');
  if (
    new Set(multi.bound).size !== 2 ||
    !multi.bound.includes(m1.id) ||
    !multi.bound.includes(m2.id)
  )
    fail(`複数・重複 id の bind の bound: ${JSON.stringify(multi)}`);
  if (multi.missing.length === 0 || multi.missing.some((id) => id !== 'no-such-multi'))
    fail(`複数・重複 id の bind の missing: ${JSON.stringify(multi)}`);
  if (multi.conflicts.length > 0)
    fail(`同じ宛先への重複 bind が conflicts になった: ${JSON.stringify(multi)}`);
  if ((await store.getMeta(m1.id))?.conversationId !== 'conv-m')
    fail('重複 id の bind が反映されない');
  const empty = await store.bind([], 'conv-m');
  if (empty.bound.length + empty.missing.length + empty.conflicts.length > 0)
    fail('空の bind が何かを返した');
  const dupConflict = await store.bind([m1.id, m1.id], 'conv-other');
  if (dupConflict.bound.length > 0 || new Set(dupConflict.conflicts).size !== 1)
    fail(`別の会話への重複 bind: ${JSON.stringify(dupConflict)}`);

  if (contractOptions.createStore !== undefined) {
    await verifyWithSmallLimits(contractOptions.createStore, fail, rejected, PNG, same);
  }
}

async function verifyWithSmallLimits(
  createStore: NonNullable<AttachmentStoreContractOptions['createStore']>,
  fail: (message: string) => never,
  rejected: (run: () => Promise<unknown>, code: string) => Promise<void>,
  PNG: Uint8Array,
  same: (a: Uint8Array, b: Uint8Array) => boolean,
): Promise<void> {
  // 9: サイズの境界ちょうど（実際の 5 MiB / 25 MiB の代わりに、同じ「画像より、その他のほうが大きい」形の小さな上限）
  const IMAGE_MAX = 64;
  const FILE_MAX = 200;
  const limited = await createStore({
    limits: { ...DEFAULT_ATTACHMENT_LIMITS, maxImageBytes: IMAGE_MAX, maxFileBytes: FILE_MAX },
  });
  const image = (size: number) => {
    const bytes = new Uint8Array(size).fill(7);
    bytes.set(PNG);
    return bytes;
  };
  const atImage = await limited.put({
    name: 'at.png',
    mediaType: 'image/png',
    bytes: image(IMAGE_MAX),
  });
  if (atImage.size !== IMAGE_MAX) fail('画像の上限ちょうどが通らない（size）');
  const gotImage = await limited.get(atImage.id);
  if (gotImage === undefined || !same(gotImage.bytes, image(IMAGE_MAX)))
    fail('画像の上限ちょうどが往復しない');
  await rejected(
    () => limited.put({ name: 'over.png', mediaType: 'image/png', bytes: image(IMAGE_MAX + 1) }),
    'too_large',
  );
  // 画像でないものは、画像の上限を超えても通り、その他の上限ちょうどまで通る
  const fileBytes = (size: number) => new Uint8Array(size).fill(9);
  const atFile = await limited.put({
    name: 'at.bin',
    mediaType: 'application/octet-stream',
    bytes: fileBytes(FILE_MAX),
  });
  if (atFile.size !== FILE_MAX) fail('その他の上限ちょうどが通らない（size）');
  if ((await limited.get(atFile.id))?.bytes.length !== FILE_MAX)
    fail('その他の上限ちょうどが往復しない');
  await rejected(
    () =>
      limited.put({
        name: 'over.bin',
        mediaType: 'application/octet-stream',
        bytes: fileBytes(FILE_MAX + 1),
      }),
    'too_large',
  );
  const betweenLimits = await limited.put({
    name: 'between.bin',
    mediaType: 'application/octet-stream',
    bytes: fileBytes(IMAGE_MAX + 1),
  });
  if (betweenLimits.size !== IMAGE_MAX + 1) fail('画像の上限を超えたその他が通らない');

  // 9: prune の境界ちょうど（`<=`）。時計を固定した空のストアで測る
  const T0 = new Date('2030-01-01T00:00:00.000Z');
  const clocked = await createStore({ now: () => T0 });
  const bound = await clocked.put({ name: 'e.txt', mediaType: 'text/plain', bytes: PNG });
  await clocked.bind([bound.id], 'conv-e');
  const expiresAt = Date.parse(bound.expiresAt);
  if ((await clocked.prune(new Date(expiresAt - 1))) !== 0) fail('expiresAt の1ms前に消えた');
  if ((await clocked.getMeta(bound.id)) === undefined) fail('expiresAt の1ms前に消えた（getMeta）');
  if ((await clocked.prune(new Date(expiresAt))) !== 1) fail('expiresAt ちょうどで消えない');
  if ((await clocked.getMeta(bound.id)) !== undefined) fail('expiresAt ちょうどで消えていない');
  const unbound = await clocked.put({ name: 'u.txt', mediaType: 'text/plain', bytes: PNG });
  const unboundAt = T0.getTime() + ATTACHMENT_UNBOUND_TTL_MS;
  if ((await clocked.prune(new Date(unboundAt - 1))) !== 0)
    fail('未結び付けが1時間の1ms前に消えた');
  if ((await clocked.prune(new Date(unboundAt))) !== 1) fail('未結び付けが1時間ちょうどで消えない');
  if ((await clocked.getMeta(unbound.id)) !== undefined) fail('未結び付けが1時間ちょうどで残った');

  // 9: bind と prune の並行。どちらが先でもよいが、答えと結果が食い違ってはならない
  //（bound と答えたのに無い・missing と答えたのに残っている、は許さない）
  const racing = await createStore({ now: () => T0 });
  const ids: string[] = [];
  for (let i = 0; i < 12; i += 1) {
    ids.push((await racing.put({ name: `r${i}.txt`, mediaType: 'text/plain', bytes: PNG })).id);
  }
  const later = new Date(unboundAt + 1000);
  const [raced, pruned] = await Promise.all([racing.bind(ids, 'conv-race'), racing.prune(later)]);
  if (raced.conflicts.length > 0)
    fail(`並行の bind が conflicts を返した: ${JSON.stringify(raced)}`);
  for (const id of ids) {
    const left = await racing.getMeta(id);
    if (raced.bound.includes(id)) {
      if (left?.conversationId !== 'conv-race') fail('bound と答えたのに結び付いて残っていない');
    } else if (raced.missing.includes(id)) {
      if (left !== undefined) fail('missing と答えたのに残っている');
    } else {
      fail('bind がどちらにも数えなかった id がある');
    }
  }
  const survivors = (await Promise.all(ids.map((id) => racing.getMeta(id)))).filter(
    (meta) => meta !== undefined,
  ).length;
  if (pruned + survivors !== ids.length)
    fail(`prune の件数と残りが合わない: pruned=${pruned} 残り=${survivors}`);
}
