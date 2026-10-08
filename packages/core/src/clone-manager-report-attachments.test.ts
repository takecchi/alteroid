import { describe, expect, it } from 'vitest';

import { setup, waitFor } from './clone-test-harness.js';
import type { FakeCall } from './clone-test-harness.js';
import type { AttachmentRef, InboxEvent } from './schema.js';
import type { Stores } from './store.js';
import { humanMessage } from './testing.js';

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
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

const report = (
  id: string,
  text: string,
  extra: Partial<Extract<InboxEvent, { type: 'manager_message' }>> = {},
): InboxEvent => ({
  type: 'manager_message',
  id,
  at: new Date().toISOString(),
  managerId: 'mgr-files',
  kind: 'report',
  text,
  ...extra,
});

type Block = { type: string; source?: { data: string } };
const imagesOf = (call: FakeCall | undefined): string[] =>
  (call?.inputBlocks ?? []).flatMap((blocks) =>
    Array.isArray(blocks)
      ? (blocks as Block[]).filter((b) => b.type === 'image').map((b) => b.source?.data ?? '')
      : [],
  );

describe('クローン — 担い手の報告に添えられたファイル（#4126 P2b）', () => {
  it('通知行が本文の前に付き、画像は画像としても渡り、日誌には控えだけが残る', async () => {
    const s = setup(() => '見た');
    s.clone.post(humanMessage('先客'));
    await waitFor(() => (s.calls[0]?.inputs.length ?? 0) === 1, '先客のターンが投げられる');
    const png = await put(s.stores, 'shot.png', 'image/png', PNG);
    const txt = await put(s.stores, 'log.txt', 'text/plain', new TextEncoder().encode('hello'));

    s.clone.post(report('r1', '調査が終わった', { attachments: [png, txt] }));
    await waitFor(
      () => (s.calls[0]?.inputs ?? []).some((input) => input.includes('調査が終わった')),
      '報告のターンが投げられる',
    );

    const call = s.calls[0] as FakeCall;
    const input = call.inputs.find((i) => i.includes('調査が終わった')) ?? '';
    const pngLine = `[添付] id=${png.id} name=shot.png type=image/png size=${png.size} sha256=${png.sha256}（画像として渡した）`;
    expect(input).toContain(pngLine);
    expect(input).toContain(`[添付] id=${txt.id} name=log.txt type=text/plain size=5`);
    expect(input.indexOf(pngLine)).toBeLessThan(input.indexOf('調査が終わった'));
    expect(imagesOf(call)).toEqual([b64(PNG)]);

    await waitFor(
      async () =>
        (await s.stores.journal.list({ types: ['exchange'], with: ['manager'] })).some(
          (entry) => entry.type === 'exchange' && entry.text.includes('調査が終わった'),
        ),
      '日誌に残る',
    );
    const journal = await s.stores.journal.list({ types: ['exchange'] });
    const row = journal.find((e) => e.type === 'exchange' && e.text.includes('調査が終わった'));
    expect(row?.type === 'exchange' ? row.attachments : undefined).toEqual([png, txt]);
    expect(JSON.stringify(journal)).not.toContain(b64(PNG));
    await s.clone.stop();
  }, 15_000);

  it('受け取れなかったものは「[添付を受け取れなかった] name=… 理由=…」の行で出る（添付が1つも無くても）', async () => {
    const s = setup(() => 'ok');
    s.clone.post(humanMessage('先客'));
    await waitFor(() => (s.calls[0]?.inputs.length ?? 0) === 1, '先客のターンが投げられる');

    s.clone.post(
      report('r1', '作った', {
        rejectedAttachments: [{ name: 'big.bin', reason: 'sha256 が申告と合わない' }],
      }),
    );
    await waitFor(
      () => (s.calls[0]?.inputs ?? []).some((input) => input.includes('作った')),
      '報告のターンが投げられる',
    );

    const input = (s.calls[0] as FakeCall).inputs.find((i) => i.includes('作った')) ?? '';
    expect(input).toContain('[添付を受け取れなかった] name=big.bin 理由=sha256 が申告と合わない');
    expect(input.indexOf('[添付を受け取れなかった]')).toBeLessThan(input.indexOf('作った'));

    const journal = await s.stores.journal.list({ types: ['exchange'] });
    const row = journal.find((e) => e.type === 'exchange' && e.text.includes('作った'));
    expect(row?.type === 'exchange' ? row.rejectedAttachments : undefined).toEqual([
      { name: 'big.bin', reason: 'sha256 が申告と合わない' },
    ]);
    await s.clone.stop();
  }, 15_000);

  it('添付の付かない報告には、通知行も追加の行も出ない', async () => {
    const s = setup(() => 'ok');
    s.clone.post(humanMessage('先客'));
    await waitFor(() => (s.calls[0]?.inputs.length ?? 0) === 1, '先客のターンが投げられる');

    s.clone.post(report('r1', 'ただの報告'));
    await waitFor(
      () => (s.calls[0]?.inputs ?? []).some((input) => input.includes('ただの報告')),
      '報告のターンが投げられる',
    );

    const input = (s.calls[0] as FakeCall).inputs.find((i) => i.includes('ただの報告')) ?? '';
    expect(input).not.toContain('[添付');
    expect(imagesOf(s.calls[0])).toEqual([]);
    await s.clone.stop();
  }, 15_000);

  it('同じマネージャーの報告が束ねられても、報告ごとの通知行が各本文の前に付く', async () => {
    const s = setup(() => 'ok');
    s.clone.post(humanMessage('先客'));
    await waitFor(() => (s.calls[0]?.inputs.length ?? 0) === 1, '先客のターンが投げられる');
    const txt = await put(s.stores, 'a.txt', 'text/plain', new TextEncoder().encode('abc'));

    s.clone.post(report('r1', '1本目の報告', { attachments: [txt] }));
    s.clone.post(report('r2', '2本目の報告'));
    await waitFor(
      () => (s.calls[0]?.inputs ?? []).some((input) => input.includes('2本目の報告')),
      'まとめたターンが投げられる',
    );

    const merged = (s.calls[0] as FakeCall).inputs.find((i) => i.includes('2本目の報告')) ?? '';
    const line = `[添付] id=${txt.id} name=a.txt`;
    expect(merged).toContain(line);
    expect(merged.indexOf(line)).toBeLessThan(merged.indexOf('1本目の報告'));
    expect(merged.indexOf('1本目の報告')).toBeLessThan(merged.indexOf('2本目の報告'));
    await s.clone.stop();
  }, 15_000);
});
