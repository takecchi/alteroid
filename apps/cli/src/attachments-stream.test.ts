import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  attachmentTooLargeMessage,
  DEFAULT_ATTACHMENT_LIMITS,
  type AttachmentLimits,
} from '@alteroid/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';
import {
  AttachmentDraft,
  attachmentsGetCommand,
  uploadAttachment,
  uploadDraft,
} from './attachments.js';
import type { Target } from './target.js';

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

const MIB = 1024 * 1024;

// 大きいファイルの枠が有る（外部ストレージ）。maxFileBytes を超えるものが流れる
const LARGE_TIER: AttachmentLimits = {
  ...DEFAULT_ATTACHMENT_LIMITS,
  maxFileBytes: MIB,
  maxLargeFileBytes: 16 * MIB,
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function consume(body: unknown): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of body as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks) as Buffer;
}

function bigBytes(size: number): Buffer {
  const bytes = Buffer.alloc(size);
  for (let i = 0; i < size; i += 1) bytes[i] = (i * 31 + 7) & 0xff;
  return bytes;
}

const stored = (size: number) => ({
  id: 'att-1',
  name: 'big.bin',
  mediaType: 'application/octet-stream',
  size,
  sha256: 'x',
});

describe('上げは画像以外を流す', () => {
  it('(a) 大きい画像以外は、fetch の本文が Uint8Array ではなくストリームで、content-length は stat の大きさ', async () => {
    const dir = await makeTempDir('alteroid-cli-attach-stream-');
    const path = join(dir, 'big.bin');
    const content = bigBytes(3 * MIB + 5);
    await writeFile(path, content);
    const seen: { init: RequestInit; received: Buffer }[] = [];
    vi.stubGlobal('fetch', async (_url: unknown, init: RequestInit) => {
      seen.push({ init, received: await consume(init.body) });
      return Response.json(stored(content.length));
    });
    const draft = new AttachmentDraft(LARGE_TIER);
    expect((await draft.add(path)).ok).toBe(true);
    const result = await uploadDraft(draft, (file) => uploadAttachment(target, file));
    expect(result.ok).toBe(true);
    const { init, received } = seen[0]!;
    expect(init.body).not.toBeInstanceOf(Uint8Array);
    expect(typeof (init.body as ReadableStream).getReader).toBe('function');
    expect((init as { duplex?: string }).duplex).toBe('half');
    expect((init.headers as Record<string, string>)['content-length']).toBe(
      String((await stat(path)).size),
    );
    expect(received.equals(content)).toBe(true);
  });

  it('実際の HTTP でも、content-length が付いてそのバイトが届く', async () => {
    const dir = await makeTempDir('alteroid-cli-attach-stream-');
    const path = join(dir, 'big.bin');
    const content = bigBytes(2 * MIB + 3);
    await writeFile(path, content);
    let length: string | undefined;
    let got: Buffer = Buffer.alloc(0);
    const server = createServer((req, res) => {
      length = req.headers['content-length'];
      void consume(req).then((body) => {
        got = body;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(stored(body.length)));
      });
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    try {
      const port = (server.address() as AddressInfo).port;
      const meta = await uploadAttachment(
        { ...target, baseUrl: `http://127.0.0.1:${port}` },
        {
          name: 'big.bin',
          mediaType: 'application/octet-stream',
          bytes: { path, length: content.length },
        },
      );
      expect(meta.size).toBe(content.length);
      expect(length).toBe(String(content.length));
      expect(got.equals(content)).toBe(true);
    } finally {
      await new Promise((done) => server.close(done));
    }
  });

  it('(b) stat で上限を超えるものは、送らずに断る。0 バイトも送らない', async () => {
    const dir = await makeTempDir('alteroid-cli-attach-stream-');
    const path = join(dir, 'grow.bin');
    await writeFile(path, Buffer.alloc(2 * MIB));
    const limits: AttachmentLimits = { ...LARGE_TIER, maxLargeFileBytes: 2 * MIB };
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const draft = new AttachmentDraft(limits);
    expect((await draft.add(path)).ok).toBe(true);
    await writeFile(path, Buffer.alloc(3 * MIB));
    expect(await uploadDraft(draft, (file) => uploadAttachment(target, file))).toEqual({
      ok: false,
      reason: `grow.bin: ${attachmentTooLargeMessage('file', 3 * MIB, 2 * MIB)}`,
    });
    await writeFile(path, '');
    const empty = await uploadDraft(draft, (file) => uploadAttachment(target, file));
    expect(empty.ok ? '' : empty.reason).toContain('空のファイルは添えられない');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('送る間にファイルが縮んだら、読み終えた時点で大きさが合わないと断る', async () => {
    const dir = await makeTempDir('alteroid-cli-attach-stream-');
    const path = join(dir, 'shrink.bin');
    await writeFile(path, Buffer.alloc(2 * MIB));
    vi.stubGlobal('fetch', async (_url: unknown, init: RequestInit) => {
      await writeFile(path, Buffer.alloc(10));
      await consume(init.body);
      return Response.json(stored(0));
    });
    await expect(
      uploadAttachment(target, {
        name: 'shrink.bin',
        mediaType: 'application/octet-stream',
        bytes: { path, length: 2 * MIB },
      }),
    ).rejects.toThrow(`ファイルが送る間に変わった（${2 * MIB} バイトのはずが 10 バイト読めた）`);
  });
});

describe('取り出しは流して書く', () => {
  const body = bigBytes(2 * MIB + 11);

  function stubBody(stream: ReadableStream<Uint8Array>): void {
    vi.stubGlobal('fetch', () => Promise.resolve(new Response(stream)));
  }

  it('(c) ファイルへ流して書き、同じバイトになる。バイト数を言う', async () => {
    const dir = await makeTempDir('alteroid-cli-attach-stream-');
    const out = join(dir, 'out.bin');
    const chunks = [body.subarray(0, MIB), body.subarray(MIB)];
    stubBody(
      new ReadableStream({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(new Uint8Array(chunk));
          controller.close();
        },
      }),
    );
    const err: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      err.push(String(chunk));
      return true;
    });
    await attachmentsGetCommand('att-1', { output: out });
    expect((await readFile(out)).equals(body)).toBe(true);
    expect(err.join('')).toContain(`${out} に書いた（${body.length} バイト）`);
  });

  it('-o - は標準出力へ流す', async () => {
    stubBody(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(body.subarray(0, 1000)));
          controller.enqueue(new Uint8Array(body.subarray(1000, 2000)));
          controller.close();
        },
      }),
    );
    const written: Buffer[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      written.push(Buffer.from(chunk as Uint8Array));
      return true;
    });
    await attachmentsGetCommand('att-1', { output: '-' });
    expect(Buffer.concat(written).equals(body.subarray(0, 2000))).toBe(true);
  });

  it('(d) 途中で失敗したら、書きかけのファイルは残らない', async () => {
    const dir = await makeTempDir('alteroid-cli-attach-stream-');
    const out = join(dir, 'half.bin');
    stubBody(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(body.subarray(0, MIB)));
        },
        pull(controller) {
          controller.error(new Error('接続が切れた'));
        },
      }),
    );
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await expect(attachmentsGetCommand('att-1', { output: out })).rejects.toThrow();
    expect(await readdir(dir)).toEqual([]);
  });

  it('既にあるファイルは上書きせず、失敗しても消さない', async () => {
    const dir = await makeTempDir('alteroid-cli-attach-stream-');
    const out = join(dir, 'keep.bin');
    await writeFile(out, 'mine');
    stubBody(new ReadableStream({ start: (c) => c.close() }));
    await expect(attachmentsGetCommand('att-1', { output: out })).rejects.toThrow('上書きしない');
    expect(await readFile(out, 'utf8')).toBe('mine');
  });
});
