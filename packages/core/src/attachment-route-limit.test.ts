import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';
import { resolveTurnAttachments, resolveTurnAttachmentGroups } from './attachment-turn.js';
import {
  ATTACHMENT_MAX_IMAGE_BYTES_BASE64_ROUTE,
  DEFAULT_ATTACHMENT_LIMITS,
  isBase64CappedImageRoute,
  routeImageCapBytes,
} from './attachment.js';
import { setup, waitForDone } from './clone-test-harness.js';
import { composeAttachmentInput, placeRunnerAttachments } from './runner-attachments.js';
import { createMemoryStores } from './testing.js';

const BEDROCK = { CLAUDE_CODE_USE_BEDROCK: '1' };
const VERTEX = { CLAUDE_CODE_USE_VERTEX: 'true' };
const CAP = ATTACHMENT_MAX_IMAGE_BYTES_BASE64_ROUTE;

/** 先頭が PNG のマジックで、`size` バイトになる中身。 */
function pngOfSize(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return bytes;
}

async function putOctet(bytes: Uint8Array) {
  const stores = createMemoryStores();
  const meta = await stores.attachments.put({
    name: 'x.bin',
    mediaType: 'application/octet-stream',
    bytes,
  });
  return { stores, meta };
}

function runnerAttachmentOf(bytes: Uint8Array) {
  return {
    id: 'att-1',
    name: 'x.bin',
    mediaType: 'application/octet-stream',
    size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    data: Buffer.from(bytes).toString('base64'),
  };
}

const ROUTE_NOTICE =
  'この経路（Bedrock / Vertex）の画像1枚の上限（base64 で 5 MB）を超えるので画像としては渡していない';

describe('isBase64CappedImageRoute: 経路の判定（#3743）', () => {
  it.each([
    [{ CLAUDE_CODE_USE_BEDROCK: '1' }, true],
    [{ CLAUDE_CODE_USE_BEDROCK: 'true' }, true],
    [{ CLAUDE_CODE_USE_BEDROCK: ' TRUE ' }, true],
    [{ CLAUDE_CODE_USE_VERTEX: 'yes' }, true],
    [{ CLAUDE_CODE_USE_VERTEX: 'on' }, true],
    [{ CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_USE_VERTEX: '1' }, true],
    [{ CLAUDE_CODE_USE_BEDROCK: '0', CLAUDE_CODE_USE_VERTEX: '1' }, true],
    [{}, false],
    [{ CLAUDE_CODE_USE_BEDROCK: '' }, false],
    [{ CLAUDE_CODE_USE_BEDROCK: '0' }, false],
    [{ CLAUDE_CODE_USE_VERTEX: 'false' }, false],
    [{ CLAUDE_CODE_USE_VERTEX: 'maybe' }, false],
    [{ CLAUDE_CODE_USE_BEDROCK: undefined }, false],
  ])('%j は %s', (env, expected) => {
    expect(isBase64CappedImageRoute(env)).toBe(expected);
  });

  it('上限が既に経路の上限以下なら下げない（undefined）。直なら下げない', () => {
    expect(routeImageCapBytes(DEFAULT_ATTACHMENT_LIMITS, BEDROCK)).toBe(CAP);
    expect(routeImageCapBytes({ maxImageBytes: CAP }, BEDROCK)).toBeUndefined();
    expect(routeImageCapBytes({ maxImageBytes: 1000 }, VERTEX)).toBeUndefined();
    expect(routeImageCapBytes(DEFAULT_ATTACHMENT_LIMITS, {})).toBeUndefined();
  });
});

describe('resolveTurnAttachments: Bedrock / Vertex の画像1枚の上限（#3743。クローン側）', () => {
  it.each([
    ['Bedrock', BEDROCK],
    ['Vertex', VERTEX],
  ])('%s: 3,750,000 バイトちょうどは画像として渡る', async (_name, env) => {
    const { stores, meta } = await putOctet(pngOfSize(CAP));
    const out = await resolveTurnAttachments(stores, [meta], undefined, env);
    expect(out.images).toHaveLength(1);
    expect(out.noticeLines[0]).toContain('（画像として渡した）');
  });

  it.each([
    ['Bedrock', BEDROCK],
    ['Vertex', VERTEX],
  ])('%s: 3,750,001 バイトは渡らず、通知行が経路の上限と開け方を言う', async (_name, env) => {
    const { stores, meta } = await putOctet(pngOfSize(CAP + 1));
    const out = await resolveTurnAttachments(stores, [meta], undefined, env);
    expect(out.images).toHaveLength(0);
    expect(out.noticeLines).toHaveLength(1);
    expect(out.noticeLines[0]).toContain(ROUTE_NOTICE);
    expect(out.noticeLines[0]).toContain('attachment_fetch');
    expect(out.noticeLines[0]).not.toContain('（画像として渡した）');
  });

  it('経路の上限で外した画像は、ターンの合計の予算を使わない', async () => {
    const stores = createMemoryStores();
    const big = await stores.attachments.put({
      name: 'big.bin',
      mediaType: 'application/octet-stream',
      bytes: pngOfSize(CAP + 1),
    });
    const small = await stores.attachments.put({
      name: 'small.bin',
      mediaType: 'application/octet-stream',
      bytes: pngOfSize(CAP),
    });
    const limits = { ...DEFAULT_ATTACHMENT_LIMITS, maxTurnImageBytes: CAP };
    const [out] = await resolveTurnAttachmentGroups(stores, [[big, small]], limits, BEDROCK);
    expect(out?.images).toHaveLength(1);
  });

  it('直（環境変数なし）: 5 MiB ちょうどは今までどおり画像として渡る', async () => {
    const { stores, meta } = await putOctet(pngOfSize(5 * 1024 * 1024));
    const out = await resolveTurnAttachments(stores, [meta], undefined, {});
    expect(out.images).toHaveLength(1);
    expect(out.noticeLines[0]).toContain('（画像として渡した）');
  });

  it('maxImageBytes が経路の上限より小さければ、そちらが効き、既存の通知行になる', async () => {
    const limits = { ...DEFAULT_ATTACHMENT_LIMITS, maxImageBytes: 1000 };
    const { stores, meta } = await putOctet(pngOfSize(1001));
    const out = await resolveTurnAttachments(stores, [meta], limits, BEDROCK);
    expect(out.images).toHaveLength(0);
    expect(out.noticeLines[0]).toContain('画像の上限（1000 B）を超える');
    expect(out.noticeLines[0]).not.toContain('この経路');
  });
});

describe('placeRunnerAttachments: Bedrock / Vertex の画像1枚の上限（#3743。担い手側）', () => {
  it.each([
    ['Bedrock', BEDROCK],
    ['Vertex', VERTEX],
  ])(
    '%s: 3,750,000 バイトちょうどは画像、3,750,001 バイトは渡らず通知行が付く',
    async (_name, env) => {
      const root = await makeTempDir('route-limit-');
      const exact = await placeRunnerAttachments({
        root,
        managerId: 'mgr-1',
        attachments: [runnerAttachmentOf(pngOfSize(CAP))],
        routeEnv: env,
      });
      expect(composeAttachmentInput('t', exact).images).toHaveLength(1);

      const over = await placeRunnerAttachments({
        root,
        managerId: 'mgr-2',
        attachments: [runnerAttachmentOf(pngOfSize(CAP + 1))],
        routeEnv: env,
      });
      const input = composeAttachmentInput('t', over);
      expect(input.images).toBeUndefined();
      expect(input.text).toContain(ROUTE_NOTICE);
      expect(input.text).toContain('path で Read で開ける');
      expect(input.text).not.toContain('画像としても渡した');
    },
  );

  it('直: 5 MiB ちょうどは今までどおり画像として渡る', async () => {
    const root = await makeTempDir('route-limit-');
    const placed = await placeRunnerAttachments({
      root,
      managerId: 'mgr-1',
      attachments: [runnerAttachmentOf(pngOfSize(5 * 1024 * 1024))],
      routeEnv: {},
    });
    expect(composeAttachmentInput('t', placed).images).toHaveLength(1);
  });
});

describe('クローンのターン: 経路は SDK 子プロセスと同じ env（#3743）', () => {
  it('env が Bedrock のとき、3,750,001 バイトの画像は image ブロックにならず通知行が付く', async () => {
    const s = setup(() => '見た', undefined, {}, BEDROCK);
    const ok = await s.stores.attachments.put({
      name: 'ok.bin',
      mediaType: 'application/octet-stream',
      bytes: pngOfSize(CAP),
    });
    const over = await s.stores.attachments.put({
      name: 'over.bin',
      mediaType: 'application/octet-stream',
      bytes: pngOfSize(CAP + 1),
    });
    s.clone.post({
      type: 'human_message',
      id: 'evt-route',
      at: new Date().toISOString(),
      text: '見て',
      conversationId: 'conv-1',
      attachments: [ok, over].map((m) => ({
        id: m.id,
        name: m.name,
        mediaType: m.mediaType,
        size: m.size,
        sha256: m.sha256,
      })),
    });
    await waitForDone(s.events);
    const call = s.calls.find((c) => c.kind === 'session');
    const blocks = call?.inputBlocks?.[0] as { type: string }[];
    expect(blocks.filter((block) => block.type === 'image')).toHaveLength(1);
    expect(call?.inputs[0]).toContain(ROUTE_NOTICE);
  });
});
