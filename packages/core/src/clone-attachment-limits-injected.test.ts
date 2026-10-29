import { crc32, deflateSync } from 'node:zlib';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_ATTACHMENT_LIMITS } from './attachment.js';
import type { TurnAttachmentLimits } from './attachment.js';
import { createClone } from './clone.js';
import { TOKEN_SAVING_ENABLED_ENV, fakeSdk, waitFor, wireEvents } from './clone-test-harness.js';
import type { FakeCall } from './clone-test-harness.js';
import { createLocalRunner } from './runner-local.js';
import { createRunnerRegistry } from './runner-protocol.js';
import type { AttachmentRef, InboxEvent } from './schema.js';
import type { Stores } from './store.js';
import { createMemoryStores, humanMessage } from './testing.js';

// createClone の `attachmentLimits` に注入した上限が、ターンの画像の判定に使われることを確かめる。
// 注入の値は既定より小さくし、process.env 側の上限は既定のままにする（env を読み直す実装なら既定で通ってしまい、画像として渡る）

const INJECTED_MAX_IMAGE_BYTES = 3000;

function chunk(type: string, data: Uint8Array): Buffer {
  const typeBytes = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])));
  return Buffer.concat([length, typeBytes, data, crc]);
}

/** 1x1 の本物の PNG。`padTo` を超えるぶんは tEXt チャンクで埋めて、ちょうどその大きさにする */
function realPng(padTo: number, tag = 0): Uint8Array {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const idat = deflateSync(Buffer.from([0, 255, tag, 0]));
  const parts = [
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
  ];
  const base = parts.reduce((n, p) => n + p.length, 0) + chunk('IEND', Buffer.alloc(0)).length;
  const filler = padTo - base - 12 - 'k\0'.length;
  if (filler > 0) {
    parts.push(chunk('tEXt', Buffer.concat([Buffer.from('k\0'), Buffer.alloc(filler, 0x61)])));
  }
  parts.push(chunk('IEND', Buffer.alloc(0)));
  const out = Buffer.concat(parts);
  if (padTo > 0 && out.length !== padTo) throw new Error(`PNG の大きさが合わない: ${out.length}`);
  return out;
}

async function put(stores: Stores, name: string, bytes: Uint8Array): Promise<AttachmentRef> {
  const meta = await stores.attachments.put({ name, mediaType: 'image/png', bytes });
  return {
    id: meta.id,
    name: meta.name,
    mediaType: meta.mediaType,
    size: meta.size,
    sha256: meta.sha256,
  };
}

function inject(extra: Partial<TurnAttachmentLimits> = {}): TurnAttachmentLimits {
  return {
    ...DEFAULT_ATTACHMENT_LIMITS,
    maxImageBytes: INJECTED_MAX_IMAGE_BYTES,
    ...extra,
  };
}

function build(attachmentLimits: TurnAttachmentLimits) {
  const stores = createMemoryStores();
  const { fn, calls } = fakeSdk(() => 'ok');
  const clone = createClone({
    inboxSettleMs: 0,
    reportSettleMs: 0,
    stores,
    queryFn: fn,
    env: { ...TOKEN_SAVING_ENABLED_ENV },
    attachmentLimits,
    runners: createRunnerRegistry([
      createLocalRunner({ workspacePath: '/work', queryFn: fakeSdk().fn, env: {} }),
    ]),
  });
  const { events } = wireEvents(clone, 'conv-1');
  return { clone, stores, calls, events };
}

type Block = { type: string; source?: { data: string } };
const imageCount = (call: FakeCall): number =>
  call.inputBlocks
    ? call.inputBlocks.reduce<number>(
        (n, blocks) =>
          n +
          (Array.isArray(blocks)
            ? (blocks as Block[]).filter((b) => b.type === 'image').length
            : 0),
        0,
      )
    : 0;

const noticeLinesOf = (call: FakeCall, marker: string): string[] =>
  (call.inputs.find((i) => i.includes(marker)) ?? '')
    .split('\n')
    .filter((l) => l.startsWith('[添付]'));

const external = (id: string, attachments: AttachmentRef[]): InboxEvent => ({
  type: 'external',
  id,
  at: '2026-09-01T00:00:01.000Z',
  source: 'ci.main',
  payload: { status: 'failure' },
  attachments,
});

const report = (id: string, attachments: AttachmentRef[]): InboxEvent => ({
  type: 'manager_message',
  id,
  at: new Date().toISOString(),
  managerId: 'mgr-files',
  kind: 'report',
  text: '調査が終わった',
  attachments,
});

const OVER_INJECTED = '画像の上限（3000 B）を超えるので画像としては渡していない';

describe('clone: 注入した添付の上限がターンの画像の判定に使われる', () => {
  beforeEach(() => {
    // process.env 側は既定のまま: 手元に設定があっても消す（vitest が試験の後で戻す）
    for (const name of Object.keys(process.env)) {
      if (name.startsWith('ALTEROID_ATTACHMENT_')) vi.stubEnv(name, undefined);
    }
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('前提: 画像は注入した上限を超え、既定の上限は超えない', () => {
    const size = realPng(INJECTED_MAX_IMAGE_BYTES + 500).length;
    expect(size).toBeGreaterThan(INJECTED_MAX_IMAGE_BYTES);
    expect(size).toBeLessThan(DEFAULT_ATTACHMENT_LIMITS.maxImageBytes);
  });

  it('人間の発言: 上限を超える画像は画像として渡らず、通知行が注入した上限を言う', async () => {
    const s = build(inject());
    const png = await put(s.stores, 'big.png', realPng(INJECTED_MAX_IMAGE_BYTES + 500));
    s.clone.post({
      type: 'human_message',
      id: 'evt-human',
      at: new Date().toISOString(),
      text: '見て',
      conversationId: 'conv-1',
      attachments: [png],
    });
    await waitFor(
      () => s.calls.some((c) => c.inputs.some((i) => i.includes('見て'))),
      '投げられる',
    );
    const call = s.calls.find((c) => c.kind === 'session') as FakeCall;
    expect(imageCount(call)).toBe(0);
    const lines = noticeLinesOf(call, '見て');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(OVER_INJECTED);
    await s.clone.stop();
  }, 15_000);

  it('外部イベント: 上限を超える画像は画像として渡らず、通知行が注入した上限を言う', async () => {
    const s = build(inject());
    s.clone.post(humanMessage('先客'));
    await waitFor(() => (s.calls[0]?.inputs.length ?? 0) === 1, '先客のターンが投げられる');
    const png = await put(s.stores, 'big.png', realPng(INJECTED_MAX_IMAGE_BYTES + 500));
    s.clone.post(external('e1', [png]));
    await waitFor(
      () => (s.calls[0]?.inputs ?? []).some((i) => i.includes('外部から出来事')),
      '外部イベントのターンが投げられる',
    );
    const call = s.calls[0] as FakeCall;
    expect(imageCount(call)).toBe(0);
    const lines = noticeLinesOf(call, '外部から出来事');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(OVER_INJECTED);
    await s.clone.stop();
  }, 15_000);

  it('マネージャーの報告: 上限を超える画像は画像として渡らず、通知行が注入した上限を言う', async () => {
    const s = build(inject());
    s.clone.post(humanMessage('先客'));
    await waitFor(() => (s.calls[0]?.inputs.length ?? 0) === 1, '先客のターンが投げられる');
    const png = await put(s.stores, 'big.png', realPng(INJECTED_MAX_IMAGE_BYTES + 500));
    s.clone.post(report('r1', [png]));
    await waitFor(
      () => (s.calls[0]?.inputs ?? []).some((i) => i.includes('調査が終わった')),
      '報告のターンが投げられる',
    );
    const call = s.calls[0] as FakeCall;
    expect(imageCount(call)).toBe(0);
    const lines = noticeLinesOf(call, '調査が終わった');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(OVER_INJECTED);
    await s.clone.stop();
  }, 15_000);

  it('人間の発言: 注入した maxTurnImages=1 で、2 枚目は上限で外れる', async () => {
    const s = build(inject({ maxTurnImages: 1 }));
    const a = await put(s.stores, 'a.png', realPng(0, 1));
    const b = await put(s.stores, 'b.png', realPng(0, 2));
    s.clone.post({
      type: 'human_message',
      id: 'evt-two',
      at: new Date().toISOString(),
      text: '2枚',
      conversationId: 'conv-1',
      attachments: [a, b],
    });
    await waitFor(() => s.calls.some((c) => c.inputs.some((i) => i.includes('2枚'))), '投げられる');
    const call = s.calls.find((c) => c.kind === 'session') as FakeCall;
    expect(imageCount(call)).toBe(1);
    const lines = noticeLinesOf(call, '2枚');
    expect(lines[1]).toContain('このターンの画像は上限（1 枚）まで');
    await s.clone.stop();
  }, 15_000);
});
