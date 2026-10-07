import { afterEach, describe, expect, it, vi } from 'vitest';

import { setup, waitForDone } from './clone-test-harness.js';
import { createCloneTools } from './tools.js';
import type { ToolContext } from './tools.js';
import { humanMessage } from './testing.js';
import type { AttachmentRef, InboxEvent } from './schema.js';
import type { Stores } from './store.js';

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const PNG_BASE64 = Buffer.from(PNG).toString('base64');

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

function withAttachments(text: string, attachments: AttachmentRef[]): InboxEvent {
  return {
    type: 'human_message',
    id: `evt-${text}`,
    at: new Date().toISOString(),
    text,
    conversationId: 'conv-1',
    attachments,
  };
}

describe('発言の添付', () => {
  it('画像は image ブロックとして渡り、通知行が本文に付く。日誌はメタデータだけで bytes を持たない', async () => {
    const s = setup(() => '見た');
    const png = await put(s.stores, 'shot.png', 'image/png', PNG);
    const txt = await put(s.stores, 'memo.txt', 'text/plain', new TextEncoder().encode('hello'));

    s.clone.post(withAttachments('これを見て', [png, txt]));
    await waitForDone(s.events);

    const call = s.calls.find((c) => c.kind === 'session');
    const blocks = call?.inputBlocks?.[0] as {
      type: string;
      text?: string;
      source?: { type: string; media_type: string; data: string };
    }[];
    expect(Array.isArray(blocks)).toBe(true);
    const images = blocks.filter((block) => block.type === 'image');
    expect(images).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG_BASE64 } },
    ]);
    const input = call?.inputs[0] ?? '';
    expect(input).toContain(
      `[添付] id=${png.id} name=shot.png type=image/png size=${png.size} sha256=${png.sha256}`,
    );
    expect(input).toContain(`[添付] id=${txt.id} name=memo.txt type=text/plain size=5`);
    expect(blocks.filter((block) => block.type === 'image')).toHaveLength(1);

    const exchanges = await s.stores.journal.list({
      types: ['exchange'],
      with: ['human'],
    });
    const inbound = exchanges.find((e) => e.type === 'exchange' && e.role === 'inbound');
    expect(inbound?.type === 'exchange' ? inbound.attachments : undefined).toEqual([png, txt]);
    expect(JSON.stringify(exchanges)).not.toContain(PNG_BASE64);
    expect(JSON.stringify(await s.stores.journal.list({}))).not.toContain(PNG_BASE64);
  });

  it('見つからない（期限切れ）添付は通知行で言い、ターンは続く', async () => {
    const s = setup(() => '続けた');
    const ghost: AttachmentRef = {
      id: 'gone-1',
      name: 'old.png',
      mediaType: 'image/png',
      size: 9,
      sha256: 'ab',
    };
    s.clone.post(withAttachments('消えたやつ', [ghost]));
    await waitForDone(s.events);

    const call = s.calls.find((c) => c.kind === 'session');
    expect(call?.inputs[0]).toContain('[添付] id=gone-1 name=old.png');
    expect(call?.inputs[0]).toContain('見つからない（期限切れの可能性）');
    expect(s.events.some((e) => e.type === 'error')).toBe(false);
  });

  it('添付の無い発言の入力は従来どおり（通知行も image も無い）', async () => {
    const s = setup(() => 'ok');
    s.clone.post(humanMessage('ただの発言'));
    await waitForDone(s.events);
    const call = s.calls.find((c) => c.kind === 'session');
    expect(call?.inputs[0]).not.toContain('[添付]');
    expect(call?.inputBlocks?.[0]).toBe(call?.inputs[0]);
  });

  it('conversation_read は [添付 n件] と id name type size を出す（中身は出さない）', async () => {
    const s = setup(() => 'ok');
    const png = await put(s.stores, 'shot.png', 'image/png', PNG);
    s.clone.post(withAttachments('絵', [png]));
    await waitForDone(s.events);

    const context: ToolContext = {
      stores: s.stores,
      emit: () => undefined,
      memoryCause: () => 'clone',
      conversationId: () => undefined,
    };
    const tool = createCloneTools(context).find((t) => t.name === 'conversation_read');
    expect(tool?.description).toContain('[添付 n件]');
    const out = await tool!.handler({ conversationId: 'conv-1' } as never, {} as never);
    const text = out.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
    expect(text).toContain('[添付 1件]');
    expect(text).toContain(`id=${png.id} name=shot.png type=image/png size=${png.size}`);
    expect(text).not.toContain(PNG_BASE64);
  });
});

describe('発言の添付: ターンの画像の枚数の上限（#3696）', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('環境変数の上限を超えた分は image にならず、通知行が理由と開け方を言う（添付の順）', async () => {
    vi.stubEnv('ALTEROID_ATTACHMENT_MAX_TURN_IMAGES', '2');
    const s = setup(() => '見た');
    const refs: AttachmentRef[] = [];
    for (let i = 0; i < 3; i += 1) {
      refs.push(await put(s.stores, `p${i}.png`, 'image/png', Uint8Array.from([...PNG, i])));
    }
    s.clone.post(withAttachments('3枚', refs));
    await waitForDone(s.events);

    const call = s.calls.find((c) => c.kind === 'session');
    const blocks = call?.inputBlocks?.[0] as { type: string }[];
    expect(blocks.filter((block) => block.type === 'image')).toHaveLength(2);
    const lines = (call?.inputs[0] ?? '').split('\n').filter((l) => l.startsWith('[添付]'));
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('name=p0.png');
    expect(lines[0]).toContain('（画像として渡した）');
    expect(lines[2]).toContain('name=p2.png');
    expect(lines[2]).toContain(
      '（このターンの画像は上限（2 枚）までで、これは超えた分なので画像としては渡していない。attachment_fetch で取り出して Read で開ける）',
    );
  });
});
