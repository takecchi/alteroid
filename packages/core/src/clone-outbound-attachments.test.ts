import { access, mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

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
  maxLargeFileBytes: 0,
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

  it('画像の上限を超える画像は、octet-stream として入れて1行そう言う（その他の上限までは受ける）', async () => {
    const dir = await makeTempDir('alteroid-file-put-');
    const png = new Uint8Array(50).fill(7);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    await writeFile(join(dir, 'big.png'), png);
    const h = toolsFor({
      attachmentLimits: { ...LIMITS, maxImageBytes: 10, maxFileBytes: 100 },
    });
    const out = await h.call('file_put', { path: join(dir, 'big.png') });
    const id = /id=(\S+)/.exec(out)?.[1];
    expect(out).toContain('type=application/octet-stream');
    expect(out).toContain('画像の上限');
    expect((await h.stores.attachments.getMeta(id!))?.mediaType).toBe('application/octet-stream');
  });

  it('寸法が 8000px を超える画像は、octet-stream として入れてファイルとして入れた旨を言う（#4131）', async () => {
    const dir = await makeTempDir('alteroid-file-put-');
    const be32 = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
    const png = Uint8Array.from([
      0x89,
      0x50,
      0x4e,
      0x47,
      0x0d,
      0x0a,
      0x1a,
      0x0a,
      ...be32(13),
      0x49,
      0x48,
      0x44,
      0x52,
      ...be32(8001),
      ...be32(10),
      8,
      6,
      0,
      0,
      0,
    ]);
    await writeFile(join(dir, 'wide.png'), png);
    const h = toolsFor();
    const out = await h.call('file_put', { path: join(dir, 'wide.png') });
    const id = /id=(\S+)/.exec(out)?.[1];
    expect(out).toContain('type=application/octet-stream');
    expect(out).toContain('画像の寸法の上限を超えるので');
    expect(out).toContain('画像ではなくファイル');
    expect((await h.stores.attachments.getMeta(id!))?.mediaType).toBe('application/octet-stream');
  });

  it('画像の上限を超え、その他の上限も超える画像は読まずに断る', async () => {
    const dir = await makeTempDir('alteroid-file-put-');
    await writeFile(join(dir, 'huge.png'), new Uint8Array(101));
    const out = await toolsFor({
      attachmentLimits: { ...LIMITS, maxImageBytes: 10, maxFileBytes: 100 },
    }).call('file_put', { path: join(dir, 'huge.png') });
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

describe('file_put の keep', () => {
  it('keep: true なら保存の印つきで入れ、1時間で消えるとは言わない', async () => {
    const dir = await makeTempDir('alteroid-file-put-keep-');
    await writeFile(join(dir, 'note.txt'), 'hello');
    const h = toolsFor();
    const out = await h.call('file_put', { path: join(dir, 'note.txt'), keep: true });
    const id = /id=(\S+)/.exec(out)?.[1];
    expect(out).toContain('保存の印つきで入れた');
    expect(out).not.toContain('1時間で消える');
    const meta = await h.stores.attachments.getMeta(id!);
    expect(meta?.keptAt).toBeDefined();
    expect(meta?.expiresAt).toBeUndefined();
    // 未結び付けのまま1時間以上たっても、掃除で消えない
    expect(await h.stores.attachments.prune(new Date(Date.now() + 2 * 60 * 60_000))).toBe(0);
    expect(await h.stores.attachments.getMeta(id!)).toBeDefined();
  });

  it('keep を省けば保存の印は付かず、未結び付けのまま1時間たつと掃除で消える', async () => {
    const dir = await makeTempDir('alteroid-file-put-keep-');
    await writeFile(join(dir, 'note.txt'), 'hello');
    const h = toolsFor();
    const out = await h.call('file_put', { path: join(dir, 'note.txt') });
    const id = /id=(\S+)/.exec(out)?.[1];
    expect(out).toContain('1時間で消える');
    expect((await h.stores.attachments.getMeta(id!))?.keptAt).toBeUndefined();
    expect(await h.stores.attachments.prune(new Date(Date.now() + 2 * 60 * 60_000))).toBe(1);
  });
});

describe('file_list', () => {
  async function seeded() {
    const h = toolsFor();
    const human = await h.stores.attachments.put({
      name: 'report.pdf',
      mediaType: 'application/pdf',
      bytes: new Uint8Array(2048).fill(1),
      uploadedBy: 'operator',
      conversationId: 'conv-a',
    });
    const clone = await h.stores.attachments.put({
      name: 'result.csv',
      mediaType: 'text/csv',
      bytes: new Uint8Array(10).fill(66),
      uploadedBy: 'clone',
      kept: true,
    });
    const manager = await h.stores.attachments.put({
      name: 'log.txt',
      mediaType: 'text/plain',
      bytes: new Uint8Array(5).fill(67),
      uploadedBy: 'manager:mgr-1',
      conversationId: 'conv-b',
    });
    return { h, human, clone, manager };
  }

  it('先頭に使用量（合計と出所ごと）を出し、1行に id・名前・種類・大きさ・出所・保存中か期限・作成日時を出す', async () => {
    const { h, human, clone } = await seeded();
    const out = await h.call('file_list', {});
    const [total, byFrom] = out.split('\n');
    expect(total).toContain('3 件');
    expect(byFrom).toContain('人間 1 件 2.0 KiB');
    expect(byFrom).toContain('クローン 1 件');
    expect(byFrom).toContain('マネージャー 1 件');
    const entryOf = (id: string) => {
      const lines = out.split('\n');
      const start = lines.findIndex((line) => line.startsWith(`- ${id} `));
      return lines.slice(start, start + 3).join('\n');
    };
    const cloneEntry = entryOf(clone.id);
    expect(cloneEntry).toContain('- ' + clone.id + ' result.csv');
    expect(cloneEntry).toContain('text/csv');
    expect(cloneEntry).toContain('10 B');
    expect(cloneEntry).toContain('出所:クローン');
    expect(cloneEntry).toContain('保存中');
    expect(cloneEntry).toContain(`作成: ${clone.createdAt}`);
    const humanEntry = entryOf(human.id);
    expect(humanEntry).toContain('出所:人間');
    expect(humanEntry).toContain(`期限 ${human.expiresAt}`);
  });

  it('kept・from・conversationId・query で絞れる', async () => {
    const { h, human, clone, manager } = await seeded();
    const idsOf = (out: string) => [...out.matchAll(/^- (\S+) /gm)].map((m) => m[1]);
    expect(idsOf(await h.call('file_list', { kept: true }))).toEqual([clone.id]);
    expect(idsOf(await h.call('file_list', { kept: false })).sort()).toEqual(
      [human.id, manager.id].sort(),
    );
    expect(idsOf(await h.call('file_list', { from: 'manager' }))).toEqual([manager.id]);
    expect(idsOf(await h.call('file_list', { conversationId: 'conv-a' }))).toEqual([human.id]);
    expect(idsOf(await h.call('file_list', { query: 'RESULT' }))).toEqual([clone.id]);
    expect(await h.call('file_list', { query: 'nothing-like-this' })).toContain(
      'この条件に合う添付は無い',
    );
  });

  it('中身を読まない（置き場の get を呼ばない）', async () => {
    const { h } = await seeded();
    const get = vi.spyOn(h.stores.attachments, 'get');
    await h.call('file_list', {});
    expect(get).not.toHaveBeenCalled();
  });

  it('文字数の予算で切れたら、省いた件数と、続きを読む cursor を出し、cursor で続きが重複も欠けもなく読める', async () => {
    const h = toolsFor();
    const ids: string[] = [];
    for (let index = 0; index < 40; index += 1) {
      const meta = await h.stores.attachments.put({
        name: `${String(index).padStart(3, '0')}-${'あ'.repeat(120)}.txt`,
        mediaType: 'text/plain',
        bytes: new Uint8Array(3).fill(65),
        conversationId: 'conv-x',
      });
      ids.push(meta.id);
    }
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const out: string = await h.call('file_list', cursor === undefined ? {} : { cursor });
      expect(out.length).toBeLessThan(8_000);
      seen.push(...[...out.matchAll(/^- (\S+) /gm)].map((m) => m[1]!));
      cursor = /file_list cursor=([A-Za-z0-9_-]+) /.exec(out)?.[1];
      pages += 1;
      if (cursor !== undefined) expect(out).toMatch(/…ほか \d+ 件は省略/);
    } while (cursor !== undefined && pages < 20);
    expect(pages).toBeGreaterThan(1);
    expect([...seen].sort()).toEqual([...ids].sort());
    expect(new Set(seen).size).toBe(ids.length);
  });

  it('読めない cursor は、自分で組み立てないよう案内する', async () => {
    const { h } = await seeded();
    expect(await h.call('file_list', { cursor: 'not-a-cursor' })).toContain('cursor が読めない');
  });
});

describe('file_keep', () => {
  it('保存の印を付けると期限なしで残り、未結び付けの掃除にも掛からない', async () => {
    const h = toolsFor();
    const meta = await putBytes(h.stores, 'a.txt', 5);
    const out = await h.call('file_keep', { id: meta.id, keep: true });
    expect(out).toContain('保存の印を付けた');
    expect((await h.stores.attachments.getMeta(meta.id))?.keptAt).toBeDefined();
    expect(await h.stores.attachments.prune(new Date(Date.now() + 2 * 60 * 60_000))).toBe(0);
  });

  it('外すと、いつ消えるか（期限）を言い、期限が入る', async () => {
    const h = toolsFor();
    const meta = await putBytes(h.stores, 'a.txt', 5);
    await h.call('file_keep', { id: meta.id, keep: true });
    const out = await h.call('file_keep', { id: meta.id, keep: false });
    const after = await h.stores.attachments.getMeta(meta.id);
    expect(after?.keptAt).toBeUndefined();
    expect(after?.expiresAt).toBeDefined();
    expect(out).toContain('保存していない');
    expect(out).toContain(`期限 ${after!.expiresAt}`);
  });

  it('無い id は「無い（期限切れか id の誤り）」と返す', async () => {
    const out = await toolsFor().call('file_keep', { id: 'no-such-id', keep: true });
    expect(out).toContain('無い');
    expect(out).toContain('id の誤り');
  });
});

describe('file_delete', () => {
  it('保存中のものも中身ごと消し、名前と id を応答に残し、日誌に残ると言う', async () => {
    const h = toolsFor();
    const meta = await h.stores.attachments.put({
      name: 'keep-me.txt',
      mediaType: 'text/plain',
      bytes: new Uint8Array(4).fill(65),
      kept: true,
    });
    const out = await h.call('file_delete', { id: meta.id });
    expect(out).toContain('keep-me.txt');
    expect(out).toContain(meta.id);
    expect(out).toContain('日誌に残る');
    expect(await h.stores.attachments.getMeta(meta.id)).toBeUndefined();
    expect(await h.stores.attachments.get(meta.id)).toBeUndefined();
  });

  it('消す前の控え（id・名前・種類・大きさ・sha256・出所・保存中だったか）を日誌へ自分で書き、中身は書かない', async () => {
    const h = toolsFor();
    const meta = await h.stores.attachments.put({
      name: 'secret-looking.txt',
      mediaType: 'text/plain',
      bytes: new TextEncoder().encode('MARKER-BODY'),
      uploadedBy: 'operator',
      kept: true,
    });
    await h.call('file_delete', { id: meta.id });
    const entries = await h.stores.journal.list({ limit: 10 });
    expect(entries).toHaveLength(1);
    const written = JSON.stringify(entries[0]);
    for (const part of [
      meta.id,
      'secret-looking.txt',
      'text/plain',
      `size=${meta.size}`,
      `sha256=${meta.sha256}`,
      '出所=人間',
      '保存中だった',
    ]) {
      expect(written).toContain(part);
    }
    expect(written).not.toContain('MARKER-BODY');
  });

  it('日誌へ書けなかったら、何も消さず、やり直してよいと伝える', async () => {
    const copies = await makeTempDir('alteroid-file-delete-copies-');
    const h = toolsFor({ attachmentCopiesDir: copies });
    const meta = await putBytes(h.stores, 'a.txt', 5);
    vi.spyOn(h.stores.journal, 'append').mockRejectedValue(new Error('journal down'));
    await expect(h.call('file_delete', { id: meta.id })).rejects.toThrow('やり直してよい');
    expect(await h.stores.attachments.getMeta(meta.id)).toBeDefined();
  });

  it('無い id では日誌に何も書かない', async () => {
    const h = toolsFor();
    await h.call('file_delete', { id: 'no-such-id' });
    expect(await h.stores.journal.list({ limit: 10 })).toEqual([]);
  });

  it('attachment_fetch で取り出した写しも消す', async () => {
    const copies = await makeTempDir('alteroid-file-delete-copies-');
    const h = toolsFor({ attachmentCopiesDir: copies });
    const meta = await putBytes(h.stores, 'copy.txt', 5);
    const fetched = await h.call('attachment_fetch', { id: meta.id });
    const path = /path=(.+)/.exec(fetched)![1]!;
    await expect(access(path)).resolves.toBeUndefined();
    await h.call('file_delete', { id: meta.id });
    await expect(access(path)).rejects.toThrow();
    await expect(access(join(copies, meta.id))).rejects.toThrow();
  });

  it('本体が無くても、取り残された写しは消し、「無い」と返す', async () => {
    const copies = await makeTempDir('alteroid-file-delete-copies-');
    const h = toolsFor({ attachmentCopiesDir: copies });
    await mkdir(join(copies, 'orphan-id'));
    await writeFile(join(copies, 'orphan-id', 'x.txt'), 'x');
    const out = await h.call('file_delete', { id: 'orphan-id' });
    expect(out).toContain('無い');
    await expect(access(join(copies, 'orphan-id'))).rejects.toThrow();
  });

  it('パス区切りや .. を含む id では、写しの置き場の外を消さない', async () => {
    const copies = await makeTempDir('alteroid-file-delete-copies-');
    await mkdir(join(copies, 'keep'));
    await writeFile(join(copies, 'keep', 'x.txt'), 'x');
    const h = toolsFor({ attachmentCopiesDir: join(copies, 'keep') });
    await h.call('file_delete', { id: '..' });
    await expect(access(join(copies, 'keep', 'x.txt'))).resolves.toBeUndefined();
  });

  it('無い id は「無い（期限切れか id の誤り）」と返す', async () => {
    const out = await toolsFor().call('file_delete', { id: 'no-such-id' });
    expect(out).toContain('無い');
    expect(out).toContain('id の誤り');
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

  it('担い手の報告に結ばれた添付（P2b）は、結び直そうとして断られず、そのまま人間へ添えられる', async () => {
    const h = toolsFor();
    const meta = await putBytes(h.stores, 'report.txt', 5);
    await h.stores.attachments.bindToManagerReport([meta.id], 'report-1');
    const out = await h.call('reply_attach', { ids: [meta.id] });
    expect(out).not.toContain('何も添えていない');
    expect(h.attached.map((r) => r.id)).toEqual([meta.id]);
    const after = await h.stores.attachments.getMeta(meta.id);
    expect(after?.managerReportId).toBe('report-1');
    expect(after?.conversationId).toBeUndefined();
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
  /** 書く先の会話を日誌に在らせる（#4149 から、在る会話へしか書けない）。 */
  async function seedConversation(stores: ReturnType<typeof createMemoryStores>, id: string) {
    await stores.journal.append({
      type: 'exchange',
      with: 'human',
      role: 'inbound',
      text: '人間の発言',
      conversationId: id,
    });
  }

  it('本文が空でも添付があれば書き、日誌の outbound exchange に控えが載り、画面へも流れる', async () => {
    const h = toolsFor();
    await seedConversation(h.stores, 'conv-1');
    const meta = await putBytes(h.stores, 'a.txt', 5);
    const out = await h.call('conversation_post', {
      conversationId: 'conv-1',
      attachments: [meta.id],
    });
    expect(out).toContain('添付 1 件つき');
    const [entry] = await h.stores.journal.list({ types: ['exchange'], limit: 1 });
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
    await seedConversation(h.stores, 'conv-1');
    const out = await h.call('conversation_post', {
      conversationId: 'conv-1',
      text: 'hi',
      attachments: ['ghost'],
    });
    expect(out).toContain('ghost');
    expect(await h.stores.journal.list({ types: ['exchange'], with: ['human'] })).toHaveLength(1);
    expect(h.posted).toEqual([]);
  });

  it('無い会話の id へ添付を添えようとしたら断り、添付をその id へ結ばない（#4149）', async () => {
    const h = toolsFor();
    const meta = await putBytes(h.stores, 'a.txt', 5);
    const out = await h.call('conversation_post', {
      conversationId: 'conv-missing',
      text: 'hi',
      attachments: [meta.id],
    });
    expect(out).toContain('会話 conv-missing は無い');
    expect(await h.stores.journal.list({ types: ['exchange'] })).toEqual([]);
    expect(h.posted).toEqual([]);
    expect((await h.stores.attachments.getMeta(meta.id))?.conversationId).toBeUndefined();
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
