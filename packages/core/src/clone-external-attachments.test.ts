import { afterEach, describe, expect, it, vi } from 'vitest';

import { setup, waitFor } from './clone-test-harness.js';
import type { FakeCall } from './clone-test-harness.js';
import { inboxBacklogDedupeKey } from './inbox-backlog.js';
import type { AttachmentRef, InboxEvent } from './schema.js';
import { humanMessage } from './testing.js';
import type { Stores } from './store.js';

/**
 * 外部イベントへの添付（#3113 段3）: 受信箱・日誌はメタデータだけ、中身は `stores.attachments`。
 * 画像はクローンのターンへ image ブロックで渡り、全添付が本文の通知行になる。**束ね読みで黙って落とさない。**
 */

const PNG_A = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const PNG_B = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 8, 7, 6]);
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');

async function put(
  stores: Stores,
  name: string,
  mediaType: string,
  bytes: Uint8Array,
): Promise<AttachmentRef> {
  const meta = await stores.attachments.put({ name, mediaType, bytes });
  return {
    id: meta.id,
    name: meta.name,
    mediaType: meta.mediaType,
    size: meta.size,
    sha256: meta.sha256,
  };
}

const external = (
  id: string,
  attachments?: AttachmentRef[],
  payload: unknown = { status: 'failure' },
): InboxEvent => ({
  type: 'external',
  id,
  at: `2026-09-01T00:00:0${id.slice(-1)}.000Z`,
  source: 'ci.main',
  payload,
  ...(attachments === undefined ? {} : { attachments }),
});

type Block = { type: string; text?: string; source?: { media_type: string; data: string } };
const imagesOf = (call: FakeCall | undefined): string[] =>
  (call?.inputBlocks ?? []).flatMap((blocks) =>
    Array.isArray(blocks)
      ? (blocks as Block[]).filter((b) => b.type === 'image').map((b) => b.source?.data ?? '')
      : [],
  );

describe('外部イベントの添付 — 単発', () => {
  it('画像は image ブロックで渡り、通知行が本文に付く。日誌はメタデータだけで bytes を持たない', async () => {
    const s = setup(() => '見た');
    s.clone.post(humanMessage('先客'));
    await waitFor(() => (s.calls[0]?.inputs.length ?? 0) === 1, '先客のターンが投げられる');
    const png = await put(s.stores, 'shot.png', 'image/png', PNG_A);
    const txt = await put(s.stores, 'log.txt', 'text/plain', new TextEncoder().encode('hello'));

    s.clone.post(external('e1', [png, txt]));
    await waitFor(
      () => (s.calls[0]?.inputs ?? []).some((input) => input.includes('外部から出来事')),
      '外部イベントのターンが投げられる',
    );

    const call = s.calls[0] as FakeCall;
    const input = call.inputs.find((i) => i.includes('外部から出来事')) ?? '';
    expect(imagesOf(call)).toEqual([b64(PNG_A)]);
    expect(input).toContain(
      `[添付] id=${png.id} name=shot.png type=image/png size=${png.size} sha256=${png.sha256}（画像として渡した）`,
    );
    expect(input).toContain(`[添付] id=${txt.id} name=log.txt type=text/plain size=5`);
    expect(input).toContain('この出来事には添付が **2 件** 付いている');

    await waitFor(
      async () => (await s.stores.journal.list({ types: ['external_event'] })).length === 1,
      '日誌に残る',
    );
    const journal = await s.stores.journal.list({});
    const row = journal.find((e) => e.type === 'external_event');
    expect(row?.type === 'external_event' ? row.attachments : undefined).toEqual([png, txt]);
    expect(JSON.stringify(journal)).not.toContain(b64(PNG_A));
    await s.clone.stop();
  }, 15_000);

  it('見つからない添付は通知行で言い、ターンは続く。添付の無い外部イベントは従来どおり', async () => {
    const s = setup(() => 'ok');
    s.clone.post(humanMessage('先客'));
    await waitFor(() => (s.calls[0]?.inputs.length ?? 0) === 1, '先客のターンが投げられる');
    const ghost: AttachmentRef = {
      id: 'gone-1',
      name: 'old.png',
      mediaType: 'image/png',
      size: 9,
      sha256: 'ab',
    };
    s.clone.post(external('e1', [ghost], { n: 1 }));
    s.clone.post(external('e2', undefined, { n: 2 }));
    await waitFor(
      () => (s.calls[0]?.inputs ?? []).filter((i) => i.includes('外部から出来事')).length === 2,
      '2件のターンが投げられる',
    );
    const inputs = (s.calls[0] as FakeCall).inputs.filter((i) => i.includes('外部から出来事'));
    const withGhost = inputs.find((i) => i.includes('gone-1')) ?? '';
    expect(withGhost).toContain('見つからない（期限切れの可能性）');
    const plain = inputs.find((i) => !i.includes('gone-1')) ?? '';
    expect(plain).not.toContain('[添付]');
    expect(plain).not.toContain('添付が');
    await s.clone.stop();
  }, 15_000);
});

describe('外部イベントの添付 — 束ね読みで黙って落とさない', () => {
  it('同じ本文でも添付が違う合図は同じ中身と見なさない（鍵に添付の id が入る）', () => {
    const a = { id: 'a', name: 'a.png', mediaType: 'image/png', size: 1, sha256: 'x' };
    const b = { ...a, id: 'b' };
    const plain = inboxBacklogDedupeKey(external('e1'));
    // 添付の無い合図の鍵は変わらない（既存の鍵と同じ文字列）。
    expect(plain).toBe(
      ['external', 'ci.main', JSON.stringify({ status: 'failure' })].join('\u0000'),
    );
    expect(inboxBacklogDedupeKey(external('e1', [a]))).not.toBe(plain);
    expect(inboxBacklogDedupeKey(external('e1', [a]))).not.toBe(
      inboxBacklogDedupeKey(external('e2', [b])),
    );
    expect(inboxBacklogDedupeKey(external('e1', [a]))).toBe(
      inboxBacklogDedupeKey(external('e2', [a])),
    );
  });

  it('本文が同じで添付だけ違う2件: 束ねず、どちらの画像もターンへ届く', async () => {
    const s = setup(() => 'ok');
    s.clone.post(humanMessage('先客'));
    await waitFor(() => (s.calls[0]?.inputs.length ?? 0) === 1, '先客のターンが投げられる');
    const a = await put(s.stores, 'a.png', 'image/png', PNG_A);
    const b = await put(s.stores, 'b.png', 'image/png', PNG_B);

    s.clone.post(external('e1', [a]));
    s.clone.post(external('e2', [b]));
    await waitFor(
      () => (s.calls[0]?.inputs ?? []).filter((i) => i.includes('外部から出来事')).length === 2,
      '2件のターンが投げられる',
    );
    const call = s.calls[0] as FakeCall;
    expect(call.inputs.some((i) => i.includes('まとめて渡す'))).toBe(false);
    expect(imagesOf(call).sort()).toEqual([b64(PNG_A), b64(PNG_B)].sort());
    await s.clone.stop();
  }, 15_000);

  it('同じ添付を持つ同じ本文が束ねられても、添付は届く（1回だけ。件数ぶん重ねない）', async () => {
    const s = setup(() => 'ok');
    s.clone.post(humanMessage('先客'));
    await waitFor(() => (s.calls[0]?.inputs.length ?? 0) === 1, '先客のターンが投げられる');
    const a = await put(s.stores, 'a.png', 'image/png', PNG_A);

    s.clone.post(external('e1', [a]));
    s.clone.post(external('e2', [a]));
    s.clone.post(external('e3', [a]));
    await waitFor(
      () => s.calls[0]?.inputs[1]?.includes('まとめて渡す') ?? false,
      '束ねたターンが投げられる',
    );
    const call = s.calls[0] as FakeCall;
    const merged = call.inputs[1] ?? '';
    expect(merged).toContain('**3 件**');
    expect(merged.split(`[添付] id=${a.id}`).length - 1).toBe(1);
    expect(imagesOf(call)).toEqual([b64(PNG_A)]);
    await s.clone.stop();
  }, 15_000);
});

describe('外部イベントの添付 — ターンの画像の枚数の上限（#3696）', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('環境変数の上限を超えた分は image にならず、通知行が理由と開け方を言う', async () => {
    vi.stubEnv('ALTEROID_ATTACHMENT_MAX_TURN_IMAGES', '2');
    const s = setup(() => 'ok');
    s.clone.post(humanMessage('先客'));
    await waitFor(() => (s.calls[0]?.inputs.length ?? 0) === 1, '先客のターンが投げられる');
    const refs: AttachmentRef[] = [];
    for (let i = 0; i < 3; i += 1) {
      refs.push(await put(s.stores, `p${i}.png`, 'image/png', Uint8Array.from([...PNG_A, i])));
    }
    s.clone.post(external('e1', refs));
    await waitFor(
      () => (s.calls[0]?.inputs ?? []).some((input) => input.includes('外部から出来事')),
      '外部イベントのターンが投げられる',
    );
    const call = s.calls[0] as FakeCall;
    expect(imagesOf(call)).toHaveLength(2);
    const input = call.inputs.find((i) => i.includes('外部から出来事')) ?? '';
    const lines = input.split('\n').filter((l) => l.startsWith('[添付]'));
    expect(lines).toHaveLength(3);
    expect(lines[2]).toContain('name=p2.png');
    expect(lines[2]).toContain(
      '（このターンの画像は上限（2 枚）までで、これは超えた分なので画像としては渡していない。attachment_fetch で取り出して Read で開ける）',
    );
    await s.clone.stop();
  }, 15_000);
});
