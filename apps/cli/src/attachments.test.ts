import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { DEFAULT_ATTACHMENT_LIMITS } from '@alteroid/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';
import {
  AttachmentDraft,
  attachmentsGetCommand,
  attachmentsMetaCommand,
  createAttachmentDraft,
  describeAttachment,
  fetchAttachmentLimits,
  interpretAttachPath,
  mediaTypeOfName,
  uploadAttachment,
  uploadDraft,
} from './attachments.js';
import { runAttachmentCommand, sendMessage } from './chat.js';
import { renderConversationDetail } from './conversations.js';
import type { Target } from './target.js';
import { captureStdout } from './test-support.js';

vi.mock('./target.js', async (orig) => ({
  ...(await orig<typeof import('./target.js')>()),
  resolveTarget: async () => ({
    baseUrl: 'http://127.0.0.1:4517',
    headers: { authorization: 'Bearer t' },
    remote: false,
    note: null,
  }),
}));

const target: Target = {
  baseUrl: 'http://127.0.0.1:4517',
  headers: { authorization: 'Bearer t' },
  remote: false,
  note: null,
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('/attach から送るまで', () => {
  it('POST /attachments は octet-stream で呼ばれ、返った id が /chat の attachments に入り、受理後に添えかけが空になる', async () => {
    const dir = await makeTempDir('alteroid-cli-attach-');
    const path = join(dir, 'run.log');
    await writeFile(path, 'hello log');
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal('fetch', (input: unknown, init: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.includes('/attachments')) {
        return Promise.resolve(
          Response.json({
            id: 'att-1',
            name: 'run.log',
            mediaType: 'text/plain',
            size: 9,
            sha256: 'x',
          }),
        );
      }
      return Promise.resolve(
        new Response('event: done\ndata: {"type":"done"}\n\n', {
          headers: { 'content-type': 'text/event-stream' },
        }),
      );
    });
    const out = captureStdout();
    const draft = new AttachmentDraft();
    await runAttachmentCommand(`/attach ${path}`, draft);
    await runAttachmentCommand('/attachments', draft);
    expect(out()).toContain('run.log');
    expect(draft.count).toBe(1);

    const uploaded = await uploadDraft(draft, (f) => uploadAttachment(target, f));
    expect(uploaded.ok).toBe(true);
    await sendMessage(target, '見て', null, undefined, {
      attachments: uploaded.ok ? uploaded.uploaded.map((a) => a.id) : [],
      onAccepted: () => draft.clear(),
    });

    const upload = calls[0]!;
    expect(upload.url).toBe(`${target.baseUrl}/attachments?name=run.log&type=text%2Fplain`);
    expect((upload.init.headers as Record<string, string>)['content-type']).toBe(
      'application/octet-stream',
    );
    expect(Buffer.from(upload.init.body as Uint8Array).toString()).toBe('hello log');
    expect(JSON.parse(String(calls[1]!.init.body))).toMatchObject({
      text: '見て',
      attachments: ['att-1'],
    });
    expect(draft.count).toBe(0);
  });

  it('上げるのに失敗したら添えかけは残り、理由が返る。再送では上げ済みを上げ直さない', async () => {
    const dir = await makeTempDir('alteroid-cli-attach-');
    const a = join(dir, 'a.txt');
    const b = join(dir, 'b.txt');
    await writeFile(a, 'a');
    await writeFile(b, 'b');
    const draft = new AttachmentDraft();
    await draft.add(a);
    await draft.add(b);
    let n = 0;
    const meta = (id: string) => ({ id, name: id, mediaType: 'text/plain', size: 1, sha256: 'x' });
    const failing = await uploadDraft(draft, async () => {
      n += 1;
      if (n === 2) throw new Error('デーモンに繋がらない');
      return meta('att-a');
    });
    expect(failing).toEqual({ ok: false, reason: 'b.txt: デーモンに繋がらない' });
    expect(draft.count).toBe(2);
    n = 0;
    const retry = await uploadDraft(draft, async () => {
      n += 1;
      return meta('att-b');
    });
    expect(n).toBe(1);
    expect(retry.ok && retry.uploaded.map((u) => u.id)).toEqual(['att-a', 'att-b']);
  });

  it('上限は先に検査する（大きすぎる・個数超過・無いファイル）。/detach で外せる', async () => {
    const dir = await makeTempDir('alteroid-cli-attach-');
    const big = join(dir, 'big.bin');
    await writeFile(big, Buffer.alloc(100));
    const small = new AttachmentDraft({
      maxImageBytes: 10,
      maxFileBytes: 50,
      maxPerMessage: 1,
      maxTotalBytes: 1000,
      retentionDays: 1,
    });
    const tooBig = await small.add(big);
    expect(tooBig.ok ? '' : tooBig.reason).toContain('大きすぎる');
    const ok = join(dir, 'ok.txt');
    await writeFile(ok, 'x');
    expect((await small.add(ok)).ok).toBe(true);
    const many = await small.add(ok);
    expect(many.ok ? '' : many.reason).toContain('1 個まで');
    const missing = await small.add(join(dir, 'nope'));
    expect(missing.ok).toBe(false);
    expect(small.remove('9').ok).toBe(false);
    expect(small.remove('1').ok).toBe(true);
    expect(small.count).toBe(0);
  });

  it('0 バイトのファイルは先に断る（Web と同じ文。#3327）', async () => {
    const dir = await makeTempDir('alteroid-cli-attach-empty-');
    const empty = join(dir, 'empty.txt');
    await writeFile(empty, '');
    const draft = new AttachmentDraft();
    const result = await draft.add(empty);
    expect(result.ok ? '' : result.reason).toContain('空のファイルは添えられない');
    expect(draft.count).toBe(0);
  });

  it('サーバの 400 empty も同じ文で出る（#3327）', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: '空のファイルは添えられない', code: 'empty' }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    try {
      await expect(
        uploadAttachment(target, {
          name: 'e.txt',
          mediaType: 'text/plain',
          bytes: new Uint8Array(0),
        }),
      ).rejects.toThrow('空のファイルは添えられない');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('MIME は拡張子の表から。分からなければ octet-stream', () => {
    expect(mediaTypeOfName('a.PNG')).toBe('image/png');
    expect(mediaTypeOfName('x.mp4')).toBe('video/mp4');
    expect(mediaTypeOfName('noext')).toBe('application/octet-stream');
    expect(mediaTypeOfName('a.weird')).toBe('application/octet-stream');
  });
});

describe('alteroid attachments get / 表示', () => {
  it('get は中身を書き、既存のファイルは上書きしない', async () => {
    const dir = await makeTempDir('alteroid-cli-attach-');
    vi.stubGlobal('fetch', () => Promise.resolve(new Response(Uint8Array.from([1, 2, 3, 255]))));
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const out = join(dir, 'out.bin');
    await attachmentsGetCommand('att-1', { output: out });
    expect([...(await readFile(out))]).toEqual([1, 2, 3, 255]);
    await expect(attachmentsGetCommand('att-1', { output: out })).rejects.toThrow('上書きしない');
  });

  it('meta は、外部イベントへ結び付いた添付の externalEventId を出す（在るときだけ。#3523）', async () => {
    const meta = {
      id: 'att-1',
      name: 'a.txt',
      mediaType: 'text/plain',
      size: 3,
      sha256: 'x',
      createdAt: '2026-10-07T00:00:00Z',
      expiresAt: '2026-10-08T00:00:00Z',
    };
    const bodies = [
      { ...meta, externalEventId: 'ev-1', uploadedBy: 'integration:key-1' },
      meta,
    ];
    vi.stubGlobal('fetch', () => Promise.resolve(Response.json(bodies.shift())));
    const out = captureStdout();
    await attachmentsMetaCommand('att-1');
    const bound = out();
    expect(bound).toContain('externalEventId: ev-1\n');
    expect(bound).toContain('uploadedBy: integration:key-1\n');
    await attachmentsMetaCommand('att-1');
    expect(out().slice(bound.length)).not.toContain('externalEventId');
  });

  it('名前が - の添付は、-o を省くと ./- に書く（標準出力へは流さない）', async () => {
    const dir = await makeTempDir('alteroid-cli-attach-');
    vi.stubGlobal('fetch', (input: unknown) => {
      const url = input instanceof Request ? input.url : String(input);
      return Promise.resolve(
        url.endsWith('/meta')
          ? Response.json({ id: 'att-1', name: '-', mediaType: 'text/plain', size: 3, sha256: 'x' })
          : new Response(Uint8Array.from([7, 8, 9])),
      );
    });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const written: unknown[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      written.push(chunk);
      return true;
    });
    const previous = process.cwd();
    process.chdir(dir);
    try {
      await attachmentsGetCommand('att-1', {});
    } finally {
      process.chdir(previous);
    }
    expect(written).toEqual([]);
    expect([...(await readFile(join(dir, '-')))]).toEqual([7, 8, 9]);
  });

  it('添付のある発言は [添付] name (type, size) id=… で出る（中身は出ない）', () => {
    const line = describeAttachment({
      id: 'i1',
      name: 'a.png',
      mediaType: 'image/png',
      size: 2048,
    });
    expect(line).toBe('[添付] a.png (image/png, 2.0 KB) id=i1');
    const text = renderConversationDetail(
      'c1',
      [
        {
          id: 'm1',
          at: '2026-10-06T00:00:00Z',
          role: 'inbound',
          text: '見て',
          attachments: [{ id: 'i1', name: 'a.png', mediaType: 'image/png', size: 2048 }],
        },
      ],
      1,
      true,
      0,
    );
    expect(text).toContain(line);
  });
});

describe('添付の上限はデーモンの値で先に検査する（#3204）', () => {
  const MIB = 1024 * 1024;
  const raised = {
    maxImageBytes: 40 * MIB,
    maxFileBytes: 200 * MIB,
    maxPerMessage: 30,
    maxTotalBytes: 400 * MIB,
    retentionDays: 7,
  };
  const lowered = {
    maxImageBytes: 100,
    maxFileBytes: 200,
    maxPerMessage: 2,
    maxTotalBytes: 1000,
    retentionDays: 1,
  };

  /** `GET /attachments/limits` に `reply` を返す偽の fetch。呼ばれた URL を控える。 */
  function stubLimits(reply: () => Response | Promise<Response>): string[] {
    const urls: string[] = [];
    vi.stubGlobal('fetch', (input: unknown) => {
      urls.push(String(input));
      return Promise.resolve(reply());
    });
    return urls;
  }

  it('fetchAttachmentLimits は GET /attachments/limits の値を返す', async () => {
    const urls = stubLimits(() => Response.json(raised));
    expect(await fetchAttachmentLimits(target)).toEqual(raised);
    expect(urls).toEqual(['http://127.0.0.1:4517/attachments/limits']);
  });

  it('古いデーモンの 404 は既定値（確定）、接続失敗・壊れた応答は null（一時的）', async () => {
    stubLimits(() => new Response('not found', { status: 404 }));
    expect(await fetchAttachmentLimits(target)).toEqual(DEFAULT_ATTACHMENT_LIMITS);
    vi.stubGlobal('fetch', () => Promise.reject(new Error('ECONNREFUSED')));
    expect(await fetchAttachmentLimits(target)).toBeNull();
    stubLimits(() => Response.json({ maxImageBytes: 'x' }));
    expect(await fetchAttachmentLimits(target)).toBeNull();
  });

  /** 先頭 `replies` を順に返し、尽きたら最後を返す。 */
  function stubSequence(replies: (() => Response | Promise<Response>)[]): string[] {
    let i = 0;
    return stubLimits(() => replies[Math.min(i++, replies.length - 1)]!());
  }

  async function bigFile(): Promise<string> {
    const dir = await makeTempDir('alteroid-cli-attach-');
    const path = join(dir, 'big.bin');
    await writeFile(path, Buffer.alloc(DEFAULT_ATTACHMENT_LIMITS.maxFileBytes + MIB));
    return path;
  }

  it('接続失敗のあとは覚えず、次の /attach で取り直してデーモンの値を使う', async () => {
    const path = await bigFile();
    const urls = stubSequence([
      () => {
        throw new Error('ECONNREFUSED');
      },
      () => Response.json(raised),
    ]);
    const draft = createAttachmentDraft(target);
    const first = await draft.add(path);
    expect(first.ok ? '' : first.reason).toContain('大きすぎる');
    expect((await draft.add(path)).ok).toBe(true);
    expect((await draft.add(path)).ok).toBe(true);
    expect(urls).toHaveLength(2);
  });

  it('壊れた応答のあとも取り直す', async () => {
    const path = await bigFile();
    const urls = stubSequence([
      () => Response.json({ maxImageBytes: 'x' }),
      () => new Response('<html>', { status: 200 }),
      () => Response.json(raised),
    ]);
    const draft = createAttachmentDraft(target);
    expect((await draft.add(path)).ok).toBe(false);
    expect((await draft.add(path)).ok).toBe(false);
    expect((await draft.add(path)).ok).toBe(true);
    expect(urls).toHaveLength(3);
  });

  it('404（古いデーモン）は覚えて、取り直さない', async () => {
    const path = await bigFile();
    const urls = stubLimits(() => new Response('', { status: 404 }));
    const draft = createAttachmentDraft(target);
    expect((await draft.add(path)).ok).toBe(false);
    expect((await draft.add(path)).ok).toBe(false);
    expect(urls).toHaveLength(1);
  });

  it('上限を上げたデーモンでは、既定値を超えてデーモンの内側にある添付を先に断らず、上げる前の読み込み検査も通す。取るのは1回', async () => {
    const dir = await makeTempDir('alteroid-cli-attach-');
    const path = join(dir, 'big.bin');
    await writeFile(path, Buffer.alloc(DEFAULT_ATTACHMENT_LIMITS.maxFileBytes + MIB));
    const urls = stubLimits(() => Response.json(raised));
    const draft = createAttachmentDraft(target);
    expect((await draft.add(path)).ok).toBe(true);
    expect((await draft.add(path)).ok).toBe(true);
    expect(urls).toHaveLength(1);
    const uploaded = await uploadDraft(draft, async (file) => ({
      id: 'att-1',
      name: file.name,
      mediaType: file.mediaType,
      size: file.bytes.length,
      sha256: 'x',
    }));
    expect(uploaded.ok).toBe(true);
  });

  it('上限を下げたデーモンでは、既定値の内側でも先に断る', async () => {
    const dir = await makeTempDir('alteroid-cli-attach-');
    const path = join(dir, 'a.bin');
    await writeFile(path, Buffer.alloc(300));
    stubLimits(() => Response.json(lowered));
    const draft = createAttachmentDraft(target);
    const result = await draft.add(path);
    expect(result.ok ? '' : result.reason).toContain('大きすぎる');
  });

  it('口が取れないときは既定値で検査する（既定を超えれば断る）', async () => {
    const dir = await makeTempDir('alteroid-cli-attach-');
    const path = join(dir, 'big.bin');
    await writeFile(path, Buffer.alloc(DEFAULT_ATTACHMENT_LIMITS.maxFileBytes + MIB));
    stubLimits(() => new Response('', { status: 404 }));
    const result = await createAttachmentDraft(target).add(path);
    expect(result.ok ? '' : result.reason).toContain('大きすぎる');
  });
});

describe('interpretAttachPath（/attach のパスの解釈。#3219）', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('先頭の ~ と ~/ を home に展開する。~user・途中の ~ は触らない', () => {
    vi.stubEnv('HOME', '/home/me');
    expect(interpretAttachPath('~')).toBe('/home/me');
    expect(interpretAttachPath('~/pic.png')).toBe('/home/me/pic.png');
    expect(interpretAttachPath('~other/pic.png')).toBe('~other/pic.png');
    expect(interpretAttachPath('a/~/pic.png')).toBe('a/~/pic.png');
  });

  it('\\ でエスケープされた空白を空白にし、ほかのバックスラッシュは触らない', () => {
    vi.stubEnv('HOME', '/home/me');
    expect(interpretAttachPath('~/My\\ Pics/a\\ b.png')).toBe('/home/me/My Pics/a b.png');
    expect(interpretAttachPath('/x/a\\nb.png')).toBe('/x/a\\nb.png');
  });

  it('引用符で囲まれていれば外すだけ（シェルと同じく、中の ~ や \\ は解釈しない）', () => {
    vi.stubEnv('HOME', '/home/me');
    expect(interpretAttachPath('"/x/a b.png"')).toBe('/x/a b.png');
    expect(interpretAttachPath("'~/a b.png'")).toBe('~/a b.png');
  });

  it('/attach ~/x は home の下のファイルを読んで添えかける（REPL）', async () => {
    const dir = await makeTempDir('alteroid-attach-home-');
    await writeFile(join(dir, 'my pic.txt'), 'hi');
    vi.stubEnv('HOME', dir);
    const out = captureStdout();
    const draft = new AttachmentDraft();
    await runAttachmentCommand('/attach ~/my\\ pic.txt', draft);
    expect(draft.list().map((f) => f.path)).toEqual([join(dir, 'my pic.txt')]);
    expect(out()).not.toContain('添えられません');
  });
});
