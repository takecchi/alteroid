import {
  ATTACHMENT_FROM_CLASSES,
  ATTACHMENT_UPLOADED_BY_CLONE,
  ATTACHMENT_NAME_MAX_LENGTH,
  ATTACHMENT_UNBOUND_TTL_MS,
  AttachmentCursorError,
  AttachmentRejectedError,
  DEFAULT_ATTACHMENT_LIMITS,
  addToAttachmentUsage,
  emptyAttachmentUsage,
  encodeAttachmentCursor,
  normalizeAttachmentName,
  type AttachmentStore,
  type AttachmentStoreOptions,
} from './attachment.js';

export interface AttachmentStoreContractOptions {
  readonly createStore?: (
    options: AttachmentStoreOptions,
  ) => AttachmentStore | Promise<AttachmentStore>;
}

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
  const expiresAtOf = (value: { expiresAt?: string }): number =>
    Date.parse(value.expiresAt ?? fail('保存していない控えに expiresAt が無い'));
  if (!(expiresAtOf(meta) > Date.parse(meta.createdAt))) fail('expiresAt > createdAt');
  if (meta.keptAt !== undefined) fail('保存の印を付けていない put に keptAt が付いた');
  const got = await store.get(meta.id);
  if (got === undefined || !same(got.bytes, PNG)) fail('get が中身を返さない');
  if (JSON.stringify(got?.meta) !== JSON.stringify(meta)) fail('get の meta が put と違う');
  if (JSON.stringify(await store.getMeta(meta.id)) !== JSON.stringify(meta)) fail('getMeta');
  if ((await store.get('no-such-id')) !== undefined) fail('無い id の get');
  if ((await store.getMeta('no-such-id')) !== undefined) fail('無い id の getMeta');
  if ((await store.get('x\u0000y')) !== undefined) fail('NUL を含む id の get は undefined');
  if ((await store.getMeta('x\u0000y')) !== undefined)
    fail('NUL を含む id の getMeta は undefined');

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
  await rejected(
    () => store.put({ name: 'e.txt', mediaType: 'text/plain', bytes: new Uint8Array(0) }),
    'empty',
  );
  await rejected(
    () => store.put({ name: 'e.png', mediaType: 'image/png', bytes: new Uint8Array(0) }),
    'empty',
  );
  const big = new Uint8Array(5 * 1024 * 1024 + 1);
  big.set(PNG);
  await rejected(
    () => store.put({ name: 'big.png', mediaType: 'image/png', bytes: big }),
    'too_large',
  );
  const text = await store.put({
    name: 'n.txt',
    mediaType: 'text/plain',
    bytes: new TextEncoder().encode('hello'),
  });
  if (text.size !== 5) fail('テキストの put');

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
  if (first.newlyBound.join() !== bound.id)
    fail(`未結び付けだった id が newlyBound に入らない: ${JSON.stringify(first)}`);
  const again = await store.bind([bound.id], 'conv-1');
  if (again.bound.join() !== bound.id) fail('同じ会話への bind は冪等');
  if (again.newlyBound.length > 0)
    fail(`すでに結ばれていた id が newlyBound に入った: ${JSON.stringify(again)}`);
  const other = await store.bind([bound.id], 'conv-2');
  if (other.conflicts.join() !== bound.id || other.bound.length > 0)
    fail('別の会話への bind は conflicts');
  if ((await store.getMeta(bound.id))?.conversationId !== 'conv-1')
    fail('conflicts が結び付けを書き換えた');

  const t0 = Date.now();
  const sooner = new Date(t0 + ATTACHMENT_UNBOUND_TTL_MS - 5 * 60_000);
  if ((await store.prune(sooner)) !== 0) fail('1時間たつ前に何かが消えた');
  const stillThere = await store.getMeta(text.id);
  if (stillThere === undefined) fail('1時間たつ前に未結び付けが消えた');
  const afterHour = new Date(t0 + ATTACHMENT_UNBOUND_TTL_MS + 5 * 60_000);
  const removed = await store.prune(afterHour);
  if (removed !== 2) fail(`未結び付けの掃除: ${removed} 件（2 件のはず）`);
  if ((await store.getMeta(meta.id)) !== undefined) fail('未結び付けが残った');
  if ((await store.get(text.id)) !== undefined) fail('未結び付けの中身が残った');
  if ((await store.getMeta(bound.id)) === undefined) fail('結び付いた期限内のものが消えた');
  const expiry = new Date(expiresAtOf(bound) + 1000);
  if ((await store.prune(expiry)) !== 1) fail('期限切れの掃除');
  if ((await store.get(bound.id)) !== undefined) fail('期限切れが残った');
  if ((await store.prune(expiry)) !== 0) fail('掃除は冪等');

  const mixedBound = await store.put({ name: 'mb.txt', mediaType: 'text/plain', bytes: PNG });
  await store.bind([mixedBound.id], 'conv-mixed');
  const fresh = await store.put({ name: 'f.txt', mediaType: 'text/plain', bytes: PNG });
  const mixed = await store.bind([mixedBound.id, fresh.id, 'no-such-id'], 'conv-mixed');
  if (
    mixed.bound.join() !== [mixedBound.id, fresh.id].join() ||
    mixed.newlyBound.join() !== fresh.id ||
    mixed.missing.join() !== 'no-such-id'
  )
    fail(`既結び付けと未結び付けの混在の newlyBound: ${JSON.stringify(mixed)}`);

  const dupFresh = await store.put({ name: 'd.txt', mediaType: 'text/plain', bytes: PNG });
  const dup = await store.bind([dupFresh.id, dupFresh.id], 'conv-dup');
  if (dup.newlyBound.join() !== dupFresh.id)
    fail(`同じ id を重ねて渡した bind の newlyBound が重なる: ${JSON.stringify(dup)}`);
  const dupEvFresh = await store.put({ name: 'de.txt', mediaType: 'text/plain', bytes: PNG });
  const dupEv = await store.bindToExternalEvent([dupEvFresh.id, dupEvFresh.id], 'ev-dup');
  if (dupEv.newlyBound.join() !== dupEvFresh.id)
    fail(
      `同じ id を重ねて渡した bindToExternalEvent の newlyBound が重なる: ${JSON.stringify(dupEv)}`,
    );

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

  const byClone = await store.put({
    name: 'k.png',
    mediaType: 'image/png',
    bytes: PNG,
    // 結んで置く: あとの「未結び付けの掃除の件数」の数え方を動かさないため
    conversationId: 'conv-clone',
    uploadedBy: ATTACHMENT_UPLOADED_BY_CLONE,
  });
  if ((await store.getMeta(byClone.id))?.uploadedBy !== 'clone')
    fail('getMeta の clone の uploadedBy');
  if ((await store.get(byClone.id))?.meta.uploadedBy !== 'clone')
    fail('get の clone の uploadedBy');

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
  if (evFirst.newlyBound.join() !== toEvent.id)
    fail(`bindToExternalEvent の newlyBound: ${JSON.stringify(evFirst)}`);
  const evAgain = await store.bindToExternalEvent([toEvent.id], 'ev-1');
  if (evAgain.bound.join() !== toEvent.id || evAgain.newlyBound.length > 0)
    fail(
      `同じ外部イベントへの bindToExternalEvent は冪等で newlyBound に入らない: ${JSON.stringify(evAgain)}`,
    );
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
  const later = new Date(Date.now() + ATTACHMENT_UNBOUND_TTL_MS + 5 * 60_000);
  if ((await store.prune(later)) !== 2)
    fail('未結び付けの掃除の件数（loose と uploaded の2件のはず）');
  if ((await store.getMeta(loose.id)) !== undefined) fail('未結び付けが残った');
  if ((await store.getMeta(toEvent.id)) === undefined)
    fail('外部イベントへ結び付いたものが掃除で消えた');
  if ((await store.getMeta(toConv.id)) === undefined) fail('会話へ結び付いたものが掃除で消えた');

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
  if ((await store.bind([uc1.id], 'conv-u3')).bound.join() !== uc1.id)
    fail('unbind したものを別の会話へ bind できない');
  if ((await store.bind([uc2.id], 'conv-u3')).conflicts.join() !== uc2.id)
    fail('unbind の対象外だったものが別の会話へ結べた');

  const longNames = [
    'あ'.repeat(300) + '.txt',
    '😀'.repeat(200) + '.txt',
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

  // マネージャーの報告への結び付け（#4126 P2b）
  const toReport = await store.put({
    name: 'rp.txt',
    mediaType: 'text/plain',
    bytes: PNG,
    uploadedBy: 'manager:m1',
  });
  const reportFirst = await store.bindToManagerReport([toReport.id, 'no-such-id'], 'rep-1');
  if (
    reportFirst.bound.join() !== toReport.id ||
    reportFirst.newlyBound.join() !== toReport.id ||
    reportFirst.missing.join() !== 'no-such-id' ||
    reportFirst.conflicts.length > 0
  )
    fail(`bindToManagerReport の結果: ${JSON.stringify(reportFirst)}`);
  const reportMeta = await store.getMeta(toReport.id);
  if (reportMeta?.managerReportId !== 'rep-1') fail('bindToManagerReport が控えへ反映されない');
  if (reportMeta?.conversationId !== undefined || reportMeta?.externalEventId !== undefined)
    fail('報告への結び付けが会話・外部イベントの欄を立てた');
  if ((await store.get(toReport.id))?.meta.managerReportId !== 'rep-1')
    fail('get の meta に managerReportId が無い');
  const reportAgain = await store.bindToManagerReport([toReport.id], 'rep-1');
  if (reportAgain.bound.join() !== toReport.id || reportAgain.newlyBound.length > 0)
    fail(
      `同じ報告への bindToManagerReport は冪等で newlyBound に入らない: ${JSON.stringify(reportAgain)}`,
    );
  if ((await store.bindToManagerReport([toReport.id], 'rep-2')).conflicts.join() !== toReport.id)
    fail('別の報告への bindToManagerReport は conflicts');
  if ((await store.bind([toReport.id], 'conv-r')).conflicts.join() !== toReport.id)
    fail('報告へ結び付いたものを会話へ bind できた');
  if ((await store.bindToExternalEvent([toReport.id], 'ev-r')).conflicts.join() !== toReport.id)
    fail('報告へ結び付いたものを外部イベントへ結べた');
  const reportToConv = await store.put({ name: 'rc.txt', mediaType: 'text/plain', bytes: PNG });
  await store.bind([reportToConv.id], 'conv-r2');
  if (
    (await store.bindToManagerReport([reportToConv.id], 'rep-3')).conflicts.join() !==
    reportToConv.id
  )
    fail('会話へ結び付いたものを報告へ結べた');
  const reportToEvent = await store.put({ name: 're.txt', mediaType: 'text/plain', bytes: PNG });
  await store.bindToExternalEvent([reportToEvent.id], 'ev-r2');
  if (
    (await store.bindToManagerReport([reportToEvent.id], 'rep-3')).conflicts.join() !==
    reportToEvent.id
  )
    fail('外部イベントへ結び付いたものを報告へ結べた');
  const reportDup = await store.put({ name: 'rd.txt', mediaType: 'text/plain', bytes: PNG });
  const reportDupResult = await store.bindToManagerReport([reportDup.id, reportDup.id], 'rep-dup');
  if (reportDupResult.newlyBound.join() !== reportDup.id)
    fail(
      `同じ id を重ねて渡した bindToManagerReport の newlyBound が重なる: ${JSON.stringify(reportDupResult)}`,
    );
  if ((await store.unbind([toReport.id], { managerReportId: 'rep-other' })).length > 0)
    fail('unbind が別の報告の結び付けを外した');
  if ((await store.unbind([toReport.id], { conversationId: 'rep-1' })).length > 0)
    fail('会話の unbind が報告の結び付けを外した');
  if ((await store.unbind([toReport.id], { managerReportId: 'rep-1' })).join() !== toReport.id)
    fail('報告の unbind が戻さない');
  if ((await store.getMeta(toReport.id))?.managerReportId !== undefined)
    fail('報告の unbind が結び付けを残した');
  if ((await store.bind([toReport.id], 'conv-r3')).bound.join() !== toReport.id)
    fail('unbind したものを会話へ bind できない');
  if ((await store.getMeta(m1.id))?.conversationId !== 'conv-m')
    fail('重複 id の bind が反映されない');
  const empty = await store.bind([], 'conv-m');
  if (empty.bound.length + empty.missing.length + empty.conflicts.length > 0)
    fail('空の bind が何かを返した');
  const dupConflict = await store.bind([m1.id, m1.id], 'conv-other');
  if (dupConflict.bound.length > 0 || new Set(dupConflict.conflicts).size !== 1)
    fail(`別の会話への重複 bind: ${JSON.stringify(dupConflict)}`);

  if (contractOptions.createStore !== undefined) {
    await verifyWithSmallLimits(
      contractOptions.createStore,
      fail,
      rejected,
      PNG,
      same,
      expiresAtOf,
    );
    await verifyKeptAndListing(contractOptions.createStore, fail, PNG, expiresAtOf);
  }
}

/**
 * 保存の印・削除・一覧・使用量・全消し（#4126 P4）。**どの検査も新しいストアで行う**（上の本線のストアの
 * 掃除の件数を、ここで預けるものが動かさないため）。時計は差し替えて、期限の境目をちょうどで測る。
 */
async function verifyKeptAndListing(
  createStore: NonNullable<AttachmentStoreContractOptions['createStore']>,
  fail: (message: string) => never,
  PNG: Uint8Array,
  expiresAtOf: (value: { expiresAt?: string }) => number,
): Promise<void> {
  const DAY = 86_400_000;
  const T0 = new Date('2031-03-01T00:00:00.000Z');
  let clock = T0;
  const store = await createStore({
    now: () => clock,
    limits: DEFAULT_ATTACHMENT_LIMITS,
  });
  const bytesOf = (size: number) => {
    const bytes = new Uint8Array(size).fill(5);
    bytes.set(PNG.subarray(0, Math.min(PNG.length, size)));
    return bytes;
  };
  const at = (offsetMs: number) => new Date(T0.getTime() + offsetMs);
  const ids = (page: { items: { id: string }[] }) => page.items.map((item) => item.id);
  // 新しい順（作成日時の降順、同じなら id の降順）の期待値
  const newestFirst = <T extends { createdAt: string; id: string }>(metas: T[]): T[] =>
    [...metas].sort((a, b) =>
      a.createdAt === b.createdAt ? (a.id < b.id ? 1 : -1) : a.createdAt < b.createdAt ? 1 : -1,
    );

  // 空の置き場
  const emptyUsage = await store.usage();
  if (
    emptyUsage.count !== 0 ||
    emptyUsage.totalBytes !== 0 ||
    ATTACHMENT_FROM_CLASSES.some(
      (from) => emptyUsage.byFrom[from]?.count !== 0 || emptyUsage.byFrom[from]?.totalBytes !== 0,
    )
  )
    fail(`空の置き場の usage（出所は5つとも 0 のはず）: ${JSON.stringify(emptyUsage)}`);
  if ((await store.list({ limit: 10 })).items.length !== 0) fail('空の置き場の list');
  if ((await store.clear()) !== 0) fail('空の置き場の clear は 0');

  // 出所の違うものを、1秒ずつずらして預ける（同じ時刻に2つ: id の降順で並ぶことを見る）
  const put = async (
    name: string,
    uploadedBy: string | undefined,
    size: number,
    offsetMs: number,
  ) => {
    clock = at(offsetMs);
    return store.put({
      name,
      mediaType: 'text/plain',
      bytes: bytesOf(size),
      ...(uploadedBy === undefined ? {} : { uploadedBy }),
    });
  };
  const a = await put('Report.PDF', 'operator', 20, 0);
  const b = await put('b.txt', 'clone', 30, 1000);
  const c = await put('c.txt', 'manager:m1', 40, 2000);
  const d = await put('d.txt', 'integration:k1', 50, 3000);
  const e = await put('e.txt', undefined, 60, 4000);
  const f = await put('f.txt', 'account:x1', 70, 5000);
  const g = await put('100%_done.txt', 'operator', 80, 6000);
  const h = await put('h.txt', 'something-else', 90, 6000);
  const all = [a, b, c, d, e, f, g, h];
  await store.bind([b.id], 'conv-list');

  const full = await store.list({ limit: 100 });
  if (
    ids(full).join() !==
    newestFirst(all)
      .map((meta) => meta.id)
      .join()
  )
    fail(`一覧の並び（新しい順・同時刻は id の降順）: ${ids(full).join()}`);
  if (JSON.stringify(full.items[0]) !== JSON.stringify(newestFirst(all)[0]))
    fail('一覧の控えが getMeta と違う');
  if (full.nextCursor !== undefined) fail('最後のページに nextCursor が付いた');

  // 絞り込み
  const filtered = async (query: Parameters<typeof store.list>[0]) =>
    ids(await store.list(query))
      .sort()
      .join();
  const sortedIds = (...metas: { id: string }[]) =>
    metas
      .map((meta) => meta.id)
      .sort()
      .join();
  if ((await filtered({ from: 'human', limit: 100 })) !== sortedIds(a, f, g))
    fail('from=human は operator と account:* だけ');
  if ((await filtered({ from: 'clone', limit: 100 })) !== sortedIds(b)) fail('from=clone');
  if ((await filtered({ from: 'manager', limit: 100 })) !== sortedIds(c)) fail('from=manager');
  if ((await filtered({ from: 'integration', limit: 100 })) !== sortedIds(d))
    fail('from=integration');
  if ((await filtered({ from: 'unknown', limit: 100 })) !== sortedIds(e, h))
    fail('from=unknown は uploadedBy が無いものと分類できないもの');
  if ((await filtered({ conversationId: 'conv-list', limit: 100 })) !== sortedIds(b))
    fail('conversationId の絞り込み');
  if ((await filtered({ conversationId: 'conv-none', limit: 100 })) !== '')
    fail('結び付いていない会話の絞り込みが空でない');
  if ((await filtered({ q: 'report', limit: 100 })) !== sortedIds(a))
    fail('q は名前の部分一致（小文字の q で大文字の名前に当たる）');
  if ((await filtered({ q: 'REPORT.pdf', limit: 100 })) !== sortedIds(a))
    fail('q は大文字小文字を問わない（大文字の q で）');
  if ((await filtered({ q: 'zzz-no-match', limit: 100 })) !== '') fail('q が当たらないのに返った');
  if ((await filtered({ q: '%_', limit: 100 })) !== sortedIds(g))
    fail('q の % と _ は文字そのものとして探す（ワイルドカードにしない）');
  if ((await filtered({ q: '.txt', from: 'human', limit: 100 })) !== sortedIds(f, g))
    fail('絞り込みの組み合わせ（AND）');

  // ページ送り
  const pages: string[] = [];
  let cursor: string | undefined;
  for (let guard = 0; guard < 20; guard += 1) {
    const page = await store.list({ limit: 3, ...(cursor === undefined ? {} : { cursor }) });
    if (page.items.length > 3) fail('limit を超えて返した');
    pages.push(...ids(page));
    if (page.nextCursor === undefined) break;
    if (page.items.length !== 3) fail('続きがあるのに limit に満たないページ');
    cursor = page.nextCursor;
  }
  if (pages.join() !== ids(full).join())
    fail(`cursor で送った全ページの連結が一覧と違う（重複・抜け）: ${pages.join()}`);
  const exact = await store.list({ limit: all.length });
  if (exact.nextCursor !== undefined || exact.items.length !== all.length)
    fail('件数ちょうどの limit のページに nextCursor が付いた');
  const tie = newestFirst(all).findIndex((meta) => meta.id === (g.id > h.id ? g.id : h.id));
  const afterTie = await store.list({
    limit: 100,
    cursor: encodeAttachmentCursor(newestFirst(all)[tie]!),
  });
  if (
    ids(afterTie).join() !==
    ids(full)
      .slice(tie + 1)
      .join()
  )
    fail('同じ作成日時の2件のあいだで cursor が抜けた・重なった');
  try {
    await store.list({ limit: 1, cursor: 'これは cursor ではない' });
    fail('読めない cursor が断られなかった');
  } catch (error) {
    if (!(error instanceof AttachmentCursorError)) throw error;
  }

  // 使用量（期限内の全体と出所ごと）
  const usage = await store.usage();
  const expectedUsage = emptyAttachmentUsage();
  for (const meta of all) addToAttachmentUsage(expectedUsage, meta);
  if (JSON.stringify(usage) !== JSON.stringify(expectedUsage))
    fail(`usage: ${JSON.stringify(usage)}（期待 ${JSON.stringify(expectedUsage)}）`);
  if (usage.count !== 8 || usage.totalBytes !== 440) fail('usage の合計');
  if (
    usage.byFrom.human.count !== 3 ||
    usage.byFrom.human.totalBytes !== 170 ||
    usage.byFrom.unknown.count !== 2 ||
    usage.byFrom.unknown.totalBytes !== 150 ||
    usage.byFrom.clone.totalBytes !== 30 ||
    usage.byFrom.manager.totalBytes !== 40 ||
    usage.byFrom.integration.totalBytes !== 50
  )
    fail(`usage の出所ごと: ${JSON.stringify(usage.byFrom)}`);

  // 保存の印を付ける
  clock = at(10_000);
  const keptA = await store.setKept(a.id, true, clock);
  if (keptA === undefined) fail('setKept(true) が控えを返さない');
  if (keptA?.keptAt !== clock.toISOString()) fail(`keptAt が now でない: ${keptA?.keptAt}`);
  if (keptA?.expiresAt !== undefined) fail('保存中なのに expiresAt が残った');
  if (JSON.stringify(await store.getMeta(a.id)) !== JSON.stringify(keptA))
    fail('getMeta が保存の印を返さない');
  if ((await store.get(a.id))?.meta.keptAt !== clock.toISOString())
    fail('get が保存の印を返さない');
  if ((await filtered({ kept: true, limit: 100 })) !== sortedIds(a)) fail('kept=true の絞り込み');
  if ((await filtered({ kept: false, limit: 100 })) !== sortedIds(b, c, d, e, f, g, h))
    fail('kept=false の絞り込み');
  if ((await store.usage()).count !== 8) fail('保存の印を付けても使用量の件数が変わった');
  clock = at(20_000);
  if ((await store.setKept(a.id, true, clock))?.keptAt !== at(10_000).toISOString())
    fail('すでに保存中のものへの setKept(true) が keptAt を動かした');
  if ((await store.setKept('no-such-id', true, clock)) !== undefined) fail('無い id の setKept');
  if ((await store.setKept('x\u0000y', true, clock)) !== undefined)
    fail('NUL を含む id の setKept');
  if ((await store.setKept('no-such-id', false, clock)) !== undefined)
    fail('無い id の setKept(false)');
  // 保存していないものを外しても、期限は動かない
  const bBefore = await store.getMeta(b.id);
  const unkeptB = await store.setKept(b.id, false, clock);
  if (JSON.stringify(unkeptB) !== JSON.stringify(bBefore))
    fail('保存していないものの setKept(false) が控えを変えた（期限を延ばした）');

  // 保存中は期限でも未結び付け1時間でも消えない
  const farFuture = at(400 * DAY);
  clock = farFuture;
  const unkeptIds = [b, c, d, e, f, g, h].map((meta) => meta.id);
  if ((await store.getMeta(a.id)) === undefined) fail('保存中のものが期限で「無い」になった');
  if ((await store.get(a.id)) === undefined) fail('保存中のものの中身が期限で「無い」になった');
  for (const id of unkeptIds) {
    if ((await store.getMeta(id)) !== undefined) fail('期限切れが「無い」にならない（getMeta）');
  }
  if (ids(await store.list({ limit: 100 })).join() !== a.id)
    fail('期限切れが一覧に残る・保存中のものが一覧から消えた');
  const farUsage = await store.usage();
  if (farUsage.count !== 1 || farUsage.totalBytes !== 20 || farUsage.byFrom.human.count !== 1)
    fail(`期限切れが使用量に残る: ${JSON.stringify(farUsage)}`);
  if ((await store.setKept(b.id, true, farFuture)) !== undefined)
    fail('期限切れのものに保存の印を付けられた');
  if ((await store.prune(farFuture)) !== unkeptIds.length)
    fail('掃除が期限切れ（保存していないもの）の件数と合わない');
  if ((await store.getMeta(a.id)) === undefined)
    fail('保存中のもの（未結び付け・期限超過）が掃除で消えた');
  if ((await store.prune(farFuture)) !== 0) fail('保存中のものが2度目の掃除で消えた');

  // 保存を外すと、外した時刻から保持日数後に期限が入る
  clock = at(401 * DAY);
  // `a` は未結び付けのまま、作成から1年以上たっている（上で保存中のまま掃除を越えた）。
  // 一度保存されたものは「上げただけの残骸」ではないので、外しても未結び付け1時間の規則では消えない
  const unkeptA = await store.setKept(a.id, false, clock);
  if (unkeptA === undefined) fail('setKept(false) が控えを返さない');
  if (unkeptA?.keptAt !== undefined) fail('保存を外したのに keptAt が残った');
  const dueAt = clock.getTime() + DEFAULT_ATTACHMENT_LIMITS.retentionDays * DAY;
  if (unkeptA === undefined || expiresAtOf(unkeptA) !== dueAt)
    fail(`外した時刻 + 保持日数が期限になっていない: ${unkeptA?.expiresAt}`);
  if ((await store.getMeta(a.id))?.expiresAt !== new Date(dueAt).toISOString())
    fail('getMeta が外したあとの期限を返さない');
  // 作成からの期限（とうに過ぎている）で、外した瞬間に消えてはならない
  if ((await store.prune(clock)) !== 0) fail('保存を外した瞬間に掃除で消えた');
  if ((await store.prune(new Date(clock.getTime() + ATTACHMENT_UNBOUND_TTL_MS + 1000))) !== 0)
    fail('保存を外した未結び付けのものが、未結び付け1時間の規則で消えた');
  if ((await store.getMeta(a.id)) === undefined) fail('外した1時間後に控えが消えた');
  if ((await store.prune(new Date(dueAt - 1))) !== 0) fail('外した期限の1ms前に消えた');
  if ((await store.getMeta(a.id)) === undefined) fail('外した期限の1ms前に控えが消えた');
  if ((await store.prune(new Date(dueAt))) !== 1) fail('外した期限ちょうどで消えない');
  if ((await store.getMeta(a.id)) !== undefined) fail('外した期限ちょうどで控えが残った');

  // 付け直すと、外した印（releasedAt）は無くなり、また保存中として消えない。外し直せば数え直す
  clock = at(402 * DAY);
  const flip = await store.put({ name: 'flip.txt', mediaType: 'text/plain', bytes: PNG });
  await store.setKept(flip.id, true, clock);
  const released = await store.setKept(flip.id, false, clock);
  if (released?.releasedAt !== clock.toISOString()) fail('外した時刻が releasedAt に入らない');
  clock = at(403 * DAY);
  const rekept = await store.setKept(flip.id, true, clock);
  if (rekept?.releasedAt !== undefined || rekept?.expiresAt !== undefined)
    fail(`付け直したのに releasedAt / expiresAt が残った: ${JSON.stringify(rekept)}`);
  if ((await store.prune(at(900 * DAY))) !== 0) fail('付け直したものが掃除で消えた');
  const reReleased = await store.setKept(flip.id, false, at(900 * DAY));
  const reDue = at(900 * DAY).getTime() + DEFAULT_ATTACHMENT_LIMITS.retentionDays * DAY;
  if (reReleased === undefined || expiresAtOf(reReleased) !== reDue)
    fail('外し直しで期限が数え直されない');
  if ((await store.prune(new Date(reDue - 1))) !== 0) fail('外し直した期限の1ms前に消えた');
  if ((await store.prune(new Date(reDue))) !== 1) fail('外し直した期限ちょうどで消えない');

  // 預けた時点で保存の印
  clock = at(500 * DAY);
  const keptPut = await store.put({
    name: 'kept.txt',
    mediaType: 'text/plain',
    bytes: PNG,
    kept: true,
    uploadedBy: 'clone',
  });
  if (keptPut.keptAt !== clock.toISOString() || keptPut.expiresAt !== undefined)
    fail(`kept: true の put: ${JSON.stringify(keptPut)}`);
  if (JSON.stringify(await store.getMeta(keptPut.id)) !== JSON.stringify(keptPut))
    fail('kept: true の put の控えが getMeta と違う');
  clock = at(900 * DAY);
  if ((await store.prune(clock)) !== 0 || (await store.getMeta(keptPut.id)) === undefined)
    fail('kept: true で預けたものが掃除で消えた');

  // 削除
  const toRemove = await store.put({ name: 'r.txt', mediaType: 'text/plain', bytes: PNG });
  if (!(await store.remove(toRemove.id))) fail('remove が消したのに true を返さない');
  if ((await store.getMeta(toRemove.id)) !== undefined) fail('remove したのに控えが残った');
  if ((await store.get(toRemove.id)) !== undefined) fail('remove したのに中身が残った');
  if (await store.remove(toRemove.id)) fail('消したものの remove が true');
  if (await store.remove('no-such-id')) fail('無い id の remove が true');
  if (await store.remove('x\u0000y')) fail('NUL を含む id の remove が true');
  if (!(await store.remove(keptPut.id))) fail('保存中のものを remove できない');
  if ((await store.getMeta(keptPut.id)) !== undefined) fail('保存中のものが remove で消えない');
  const stale = await store.put({ name: 's.txt', mediaType: 'text/plain', bytes: PNG });
  clock = at(900 * DAY + 31 * DAY);
  if (await store.remove(stale.id)) fail('期限切れのものの remove が true（「無い」のはず）');

  // 全消し
  clock = at(1000 * DAY);
  const c1 = await store.put({ name: 'c1.txt', mediaType: 'text/plain', bytes: PNG, kept: true });
  const c2 = await store.put({ name: 'c2.txt', mediaType: 'text/plain', bytes: PNG });
  const c3 = await store.put({ name: 'c3.txt', mediaType: 'text/plain', bytes: PNG });
  await store.bind([c3.id], 'conv-clear');
  if ((await store.clear()) < 3) fail('clear が消した件数を返さない');
  for (const meta of [c1, c2, c3]) {
    if ((await store.getMeta(meta.id)) !== undefined) fail('clear のあとに控えが残った');
    if ((await store.get(meta.id)) !== undefined) fail('clear のあとに中身が残った');
  }
  if ((await store.list({ limit: 10 })).items.length !== 0) fail('clear のあとに一覧が空でない');
  if ((await store.usage()).count !== 0) fail('clear のあとに使用量が 0 でない');
  if ((await store.clear()) !== 0) fail('clear は冪等（2度目は 0 件）');
  const afterClear = await store.put({ name: 'ac.txt', mediaType: 'text/plain', bytes: PNG });
  if ((await store.getMeta(afterClear.id)) === undefined) fail('clear のあとに預けられない');
}

async function verifyWithSmallLimits(
  createStore: NonNullable<AttachmentStoreContractOptions['createStore']>,
  fail: (message: string) => never,
  rejected: (run: () => Promise<unknown>, code: string) => Promise<void>,
  PNG: Uint8Array,
  same: (a: Uint8Array, b: Uint8Array) => boolean,
  expiresAtOf: (value: { expiresAt?: string }) => number,
): Promise<void> {
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
  // 画像の寸法（#3697）。IHDR だけの小さな png で測る。`limited` を使うのは、本線のストアの
  // 「未結び付けの掃除」の件数（上の 5）を、ここで預けるものが動かさないため
  const be32 = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
  const pngOf = (width: number, height: number) =>
    Uint8Array.from([
      ...PNG.subarray(0, 8),
      ...be32(13),
      0x49,
      0x48,
      0x44,
      0x52,
      ...be32(width),
      ...be32(height),
      8,
      6,
      0,
      0,
      0,
    ]);
  const atDimension = await limited.put({
    name: 'edge.png',
    mediaType: 'image/png',
    bytes: pngOf(8000, 8000),
  });
  if (!same((await limited.get(atDimension.id))?.bytes ?? new Uint8Array(), pngOf(8000, 8000)))
    fail('寸法 8000px ちょうどが往復しない');
  await rejected(
    () => limited.put({ name: 'wide.png', mediaType: 'image/png', bytes: pngOf(8001, 10) }),
    'image_dimension_too_large',
  );
  await rejected(
    () => limited.put({ name: 'tall.png', mediaType: 'image/png', bytes: pngOf(10, 8001) }),
    'image_dimension_too_large',
  );
  const unreadable = await limited.put({
    name: 'cut.png',
    mediaType: 'image/png',
    bytes: pngOf(8001, 10).subarray(0, 20),
  });
  if (unreadable.size !== 20) fail('寸法が読めない画像が通らない');
  const asFile = await limited.put({
    name: 'huge.bin',
    mediaType: 'application/octet-stream',
    bytes: pngOf(8001, 8001),
  });
  if (asFile.size !== pngOf(8001, 8001).length) fail('宣言が画像以外の 8001px の png が通らない');
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

  const T0 = new Date('2030-01-01T00:00:00.000Z');
  const clocked = await createStore({ now: () => T0 });
  const bound = await clocked.put({ name: 'e.txt', mediaType: 'text/plain', bytes: PNG });
  await clocked.bind([bound.id], 'conv-e');
  const expiresAt = expiresAtOf(bound);
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

  // 報告へ結び付けたものは、未結び付けの1時間の掃除に掛からない（#4126 P2b）
  const reported = await clocked.put({ name: 'rp.txt', mediaType: 'text/plain', bytes: PNG });
  const looseTwin = await clocked.put({ name: 'lt.txt', mediaType: 'text/plain', bytes: PNG });
  await clocked.bindToManagerReport([reported.id], 'rep-prune');
  if ((await clocked.prune(new Date(unboundAt + 5 * 60_000))) !== 1)
    fail('報告へ結び付けたものが未結び付けとして掃除された（件数）');
  if ((await clocked.getMeta(reported.id))?.managerReportId !== 'rep-prune')
    fail('報告へ結び付けたものが1時間の掃除で消えた');
  if ((await clocked.getMeta(looseTwin.id)) !== undefined) fail('未結び付けの対照が残った');
  if ((await clocked.get(reported.id)) === undefined) fail('報告へ結び付けたものの中身が消えた');
  if ((await clocked.prune(new Date(expiresAtOf(reported)))) !== 1)
    fail('報告へ結び付けたものが期限（expiresAt）で消えない');

  let readNow = T0;
  const expiring = await createStore({ now: () => readNow });
  const keep = await expiring.put({ name: 'k.txt', mediaType: 'text/plain', bytes: PNG });
  const late = await expiring.put({ name: 'l.txt', mediaType: 'text/plain', bytes: PNG });
  const late2 = await expiring.put({ name: 'm.txt', mediaType: 'text/plain', bytes: PNG });
  const lateBound = await expiring.put({ name: 'b.txt', mediaType: 'text/plain', bytes: PNG });
  await expiring.bind([lateBound.id], 'conv-x');
  const dueAt = expiresAtOf(keep);
  readNow = new Date(dueAt - 1);
  if ((await expiring.getMeta(keep.id)) === undefined)
    fail('expiresAt の1ms前に getMeta が無いと答えた');
  if ((await expiring.get(keep.id)) === undefined) fail('expiresAt の1ms前に get が無いと答えた');
  readNow = new Date(dueAt);
  if ((await expiring.getMeta(keep.id)) !== undefined)
    fail('expiresAt ちょうどで getMeta が答えた');
  if ((await expiring.get(keep.id)) !== undefined) fail('expiresAt ちょうどで get が答えた');
  if ((await expiring.getMeta(lateBound.id)) !== undefined)
    fail('結び付いていても期限切れの getMeta が答えた');
  readNow = new Date(dueAt + 1000);
  const lateBind = await expiring.bind([late.id], 'conv-late');
  if (lateBind.bound.length > 0 || lateBind.newlyBound.length > 0 || lateBind.conflicts.length > 0)
    fail(`期限切れの bind が通った: ${JSON.stringify(lateBind)}`);
  if (lateBind.missing.join() !== late.id) fail('期限切れの bind が missing にならない');
  const lateEvent = await expiring.bindToExternalEvent([late2.id], 'ev-late');
  if (lateEvent.bound.length > 0 || lateEvent.missing.join() !== late2.id)
    fail(`期限切れの bindToExternalEvent が missing にならない: ${JSON.stringify(lateEvent)}`);
  readNow = new Date(dueAt - 1);
  const again = await expiring.bind([lateBound.id], 'conv-x');
  if (again.bound.join() !== lateBound.id || again.newlyBound.length > 0)
    fail('期限内で結び付いたものの冪等な bind が変わった');
  if ((await expiring.getMeta(lateBound.id))?.conversationId !== 'conv-x')
    fail('期限内で結び付いたものが読めない');

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
