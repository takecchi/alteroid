import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';
import { fakeScriptedSdk, fakeSdk, waitForTerminal, wireEvents } from './clone-test-harness.js';
import type { ScriptedStep } from './clone-test-harness.js';
import { ALWAYS_REDELIVER, createClone } from './clone.js';
import { credentialSourceRefusal, guessMediaTypeFromPath } from './file-put.js';
import { createLocalRunner } from './runner-local.js';
import { createRunnerRegistry } from './runner-protocol.js';
import type { AttachmentRef, ChatStreamEvent } from './schema.js';
import { createMemoryStores, humanMessage } from './testing.js';
import { createCloneMcpServer, createCloneTools } from './tools.js';
import type { ToolContext } from './tools.js';

const LIMITS = {
  maxImageBytes: 100,
  maxFileBytes: 50,
  maxPerMessage: 2,
  maxTotalBytes: 60,
  retentionDays: 30,
};

function toolsFor(overrides: Partial<ToolContext> = {}) {
  const stores = createMemoryStores();
  const attached: AttachmentRef[] = [];
  const emitted: ChatStreamEvent[] = [];
  const posted: { conversationId: string; text: string; attachments?: readonly AttachmentRef[] }[] =
    [];
  const tools = createCloneTools({
    stores,
    emit: (event) => emitted.push(event),
    memoryCause: () => 'clone',
    conversationId: () => 'conv-now',
    attachmentLimits: LIMITS,
    replyAttachments: { current: () => attached, add: (refs) => attached.push(...refs) },
    postToConversation: (conversationId, text, attachments) =>
      posted.push({ conversationId, text, ...(attachments === undefined ? {} : { attachments }) }),
    ...overrides,
  });
  return {
    stores,
    attached,
    emitted,
    posted,
    async call(name: string, args: Record<string, unknown>): Promise<string> {
      const found = tools.find((entry) => entry.name === name);
      const result = await found!.handler(args as never, {});
      return result.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
    },
  };
}

async function putBytes(
  stores: ReturnType<typeof createMemoryStores>,
  name: string,
  size: number,
  extra: { conversationId?: string } = {},
) {
  return stores.attachments.put({
    name,
    mediaType: 'text/plain',
    bytes: new Uint8Array(size).fill(65),
    ...extra,
  });
}

describe('credentialSourceRefusal（純関数）', () => {
  const sources = {
    dir: '/run/creds',
    files: new Map([['ALTEROID_GH_TOKEN_FILE', '/run/creds/GH_TOKEN']]),
  };
  it('資格のディレクトリの配下は断り、理由を言う', () => {
    expect(credentialSourceRefusal('/run/creds/x/y', sources)).toContain('ALTEROID_CREDENTIAL_DIR');
  });
  it('_FILE の環境変数が指すファイルは、ディレクトリの外にあっても断る', () => {
    const outside = { files: new Map([['SOME_KEY_FILE', '/etc/key']]) };
    expect(credentialSourceRefusal('/etc/key', outside)).toContain('SOME_KEY_FILE');
  });
  it('前方一致するだけの別のディレクトリは断らない', () => {
    expect(credentialSourceRefusal('/run/creds-other/a', sources)).toBeUndefined();
  });
  it('関係の無いファイルは断らない', () => {
    expect(credentialSourceRefusal('/tmp/report.txt', sources)).toBeUndefined();
  });
});

describe('guessMediaTypeFromPath', () => {
  it('拡張子から推し、分からなければ octet-stream', () => {
    expect(guessMediaTypeFromPath('/a/b.PNG')).toBe('image/png');
    expect(guessMediaTypeFromPath('/a/b.unknownext')).toBe('application/octet-stream');
  });
});

describe('file_put', () => {
  it('通常のファイルを clone の名義で置き場へ入れ、id と控えを返し、1時間で消えることを言う', async () => {
    const dir = await makeTempDir('alteroid-file-put-');
    await writeFile(join(dir, 'note.txt'), 'hello');
    const h = toolsFor();
    const out = await h.call('file_put', { path: join(dir, 'note.txt') });
    const id = /id=(\S+)/.exec(out)?.[1];
    expect(out).toContain('name=note.txt type=text/plain size=5');
    expect(out).toContain('1時間で消える');
    const meta = await h.stores.attachments.getMeta(id!);
    expect(meta).toMatchObject({ uploadedBy: 'clone', size: 5 });
    expect(meta?.conversationId).toBeUndefined();
  });

  it('ディレクトリ・存在しないパス・相対パスは断る', async () => {
    const dir = await makeTempDir('alteroid-file-put-');
    const h = toolsFor();
    expect(await h.call('file_put', { path: dir })).toContain('通常のファイルではない');
    expect(await h.call('file_put', { path: join(dir, 'none') })).toContain('見つからない');
    expect(await h.call('file_put', { path: 'rel.txt' })).toContain('絶対パス');
  });

  it('上限を超えるファイルは読まずに断る', async () => {
    const dir = await makeTempDir('alteroid-file-put-');
    await writeFile(join(dir, 'big.bin'), new Uint8Array(LIMITS.maxFileBytes + 1));
    const out = await toolsFor().call('file_put', { path: join(dir, 'big.bin') });
    expect(out).toContain('上限');
    expect(out).toContain('読まずに断った');
  });

  it('画像の中身が拡張子と合わなければ置き場の検査で断る', async () => {
    const dir = await makeTempDir('alteroid-file-put-');
    await writeFile(join(dir, 'fake.png'), 'not a png');
    expect(await toolsFor().call('file_put', { path: join(dir, 'fake.png') })).toContain(
      '置き場が受け付けなかった',
    );
  });

  it('ALTEROID_CREDENTIAL_DIR の配下は、シンボリックリンク越しでも断る', async () => {
    const dir = await makeTempDir('alteroid-file-put-');
    const creds = join(dir, 'creds');
    await mkdir(creds);
    await writeFile(join(creds, 'GH_TOKEN'), 'secret');
    await symlink(join(creds, 'GH_TOKEN'), join(dir, 'innocent.txt'));
    const prior = process.env.ALTEROID_CREDENTIAL_DIR;
    process.env.ALTEROID_CREDENTIAL_DIR = creds;
    try {
      const out = await toolsFor().call('file_put', { path: join(dir, 'innocent.txt') });
      expect(out).toContain('資格の置き場');
    } finally {
      if (prior === undefined) delete process.env.ALTEROID_CREDENTIAL_DIR;
      else process.env.ALTEROID_CREDENTIAL_DIR = prior;
    }
  });

  it('_FILE で終わる環境変数が指すファイルは断る', async () => {
    const dir = await makeTempDir('alteroid-file-put-');
    await writeFile(join(dir, 'k.txt'), 'secret');
    process.env.ALTEROID_TEST_KEY_FILE = join(dir, 'k.txt');
    try {
      const out = await toolsFor().call('file_put', { path: join(dir, 'k.txt') });
      expect(out).toContain('ALTEROID_TEST_KEY_FILE');
    } finally {
      delete process.env.ALTEROID_TEST_KEY_FILE;
    }
  });
});

describe('reply_attach', () => {
  it('未結び付けの添付をいまの会話へ結び、返信に添える', async () => {
    const h = toolsFor();
    const meta = await putBytes(h.stores, 'a.txt', 5);
    const out = await h.call('reply_attach', { ids: [meta.id] });
    expect(out).toContain('添付 1 件を添えた');
    expect(h.attached.map((r) => r.id)).toEqual([meta.id]);
    expect((await h.stores.attachments.getMeta(meta.id))?.conversationId).toBe('conv-now');
  });

  it('別の会話に結ばれた添付は結び直さず、そのまま添える', async () => {
    const h = toolsFor();
    const meta = await putBytes(h.stores, 'a.txt', 5, { conversationId: 'conv-other' });
    await h.call('reply_attach', { ids: [meta.id] });
    expect(h.attached.map((r) => r.id)).toEqual([meta.id]);
    expect((await h.stores.attachments.getMeta(meta.id))?.conversationId).toBe('conv-other');
  });

  it('存在しない id が1つでもあれば、何も添えず結ばず、どれが無いかを言う', async () => {
    const h = toolsFor();
    const meta = await putBytes(h.stores, 'a.txt', 5);
    const out = await h.call('reply_attach', { ids: [meta.id, 'ghost'] });
    expect(out).toContain('ghost');
    expect(out).toContain('何も添えていない');
    expect(h.attached).toEqual([]);
    expect((await h.stores.attachments.getMeta(meta.id))?.conversationId).toBeUndefined();
  });

  it('同じターンの複数回の呼び出しを合計で数え、超えたら何も添えない', async () => {
    const h = toolsFor();
    const [a, b, c] = [
      await putBytes(h.stores, 'a.txt', 5),
      await putBytes(h.stores, 'b.txt', 5),
      await putBytes(h.stores, 'c.txt', 5),
    ];
    await h.call('reply_attach', { ids: [a!.id, b!.id] });
    const out = await h.call('reply_attach', { ids: [c!.id] });
    expect(out).toContain('2 個まで');
    expect(h.attached).toHaveLength(2);
    expect((await h.stores.attachments.getMeta(c!.id))?.conversationId).toBeUndefined();
  });

  it('合計バイト数の上限を超えたら、結んでいない添付は結ばれないまま断る', async () => {
    const h = toolsFor();
    const a = await putBytes(h.stores, 'a.txt', 40);
    const b = await putBytes(h.stores, 'b.txt', 40);
    const out = await h.call('reply_attach', { ids: [a.id, b.id] });
    expect(out).toContain('合計は');
    expect((await h.stores.attachments.getMeta(a.id))?.conversationId).toBeUndefined();
  });

  it('返信先の会話が無いターンでは断り、conversation_post を案内する', async () => {
    const h = toolsFor({ conversationId: () => undefined });
    const meta = await putBytes(h.stores, 'a.txt', 5);
    const out = await h.call('reply_attach', { ids: [meta.id] });
    expect(out).toContain('conversation_post');
    expect(h.attached).toEqual([]);
  });
});

describe('conversation_post の attachments', () => {
  it('本文が空でも添付があれば書き、日誌の outbound exchange に控えが載り、画面へも流れる', async () => {
    const h = toolsFor();
    const meta = await putBytes(h.stores, 'a.txt', 5);
    const out = await h.call('conversation_post', {
      conversationId: 'conv-1',
      attachments: [meta.id],
    });
    expect(out).toContain('添付 1 件つき');
    const [entry] = await h.stores.journal.list({ types: ['exchange'] });
    expect(entry).toMatchObject({ role: 'outbound', text: '', conversationId: 'conv-1' });
    expect(entry?.type === 'exchange' ? entry.attachments?.map((r) => r.id) : []).toEqual([
      meta.id,
    ]);
    expect(h.posted[0]?.attachments?.map((r) => r.id)).toEqual([meta.id]);
    expect((await h.stores.attachments.getMeta(meta.id))?.conversationId).toBe('conv-1');
  });

  it('本文も添付も無ければ断り、日誌に書かない', async () => {
    const h = toolsFor();
    expect(await h.call('conversation_post', { conversationId: 'conv-1' })).toContain('どちらか');
    expect(await h.call('conversation_post', { text: '', attachments: [] })).toContain('text');
    expect(await h.stores.journal.list({ types: ['exchange'] })).toEqual([]);
  });

  it('存在しない添付があれば何も書かない', async () => {
    const h = toolsFor();
    const out = await h.call('conversation_post', {
      conversationId: 'conv-1',
      text: 'hi',
      attachments: ['ghost'],
    });
    expect(out).toContain('ghost');
    expect(await h.stores.journal.list({ types: ['exchange'] })).toEqual([]);
    expect(h.posted).toEqual([]);
  });
});

describe('reply_attach をクローンのターンの中で呼ぶ', () => {
  it('SSE に attachments が出て、本文が空でも返信の exchange に控えが載り、再生にも含まれる', async () => {
    const stores = createMemoryStores();
    const meta = await putBytes(stores, 'r.txt', 5);
    let captured: ToolContext | undefined;
    const steps: ScriptedStep[] = [
      {
        run: async () => {
          const tool = createCloneTools(captured!).find((t) => t.name === 'reply_attach');
          await tool!.handler({ ids: [meta.id] } as never, {});
        },
      },
    ];
    const { fn, settled } = fakeScriptedSdk(() => steps);
    const clone = createClone({
      redeliveryGate: ALWAYS_REDELIVER,
      stores,
      queryFn: fn,
      env: {},
      mcpServerFactory: (context) => {
        captured = context;
        return createCloneMcpServer(context);
      },
      runners: createRunnerRegistry([
        createLocalRunner({ workspacePath: '/work', queryFn: fakeSdk().fn, env: {} }),
      ]),
    });
    const { events } = wireEvents(clone, 'conv-1');
    clone.post(humanMessage('資料を送って'));
    await waitForTerminal(events);
    await Promise.all(settled);

    const ev = events.find((e) => e.type === 'attachments');
    expect(ev).toMatchObject({ attachments: [{ id: meta.id, name: 'r.txt' }] });
    const rows = await stores.journal.list({ types: ['exchange'], with: ['human'], order: 'asc' });
    const outbound = rows.filter((r) => r.type === 'exchange' && r.role === 'outbound');
    expect(outbound).toHaveLength(1);
    expect(outbound[0]?.type === 'exchange' ? outbound[0].attachments?.[0]?.id : '').toBe(meta.id);
    await clone.stop();
  });
});
