import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';
import {
  attachmentsKeepCommand,
  attachmentsListCommand,
  attachmentsPutCommand,
  attachmentsRemoveCommand,
} from './attachments.js';
import { ConfirmDeclinedError, type ConfirmIo } from './confirm.js';
import { captureStderr, captureStdout, pretendTty } from './test-support.js';

// 確認の対話だけ差し替える（端末の有無・答えを測るため）。確認の本体（confirmIrreversible）は本物
const io = vi.hoisted(() => ({ current: null as ConfirmIo | null }));
vi.mock('./confirm.js', async (orig) => {
  const actual = await orig<typeof import('./confirm.js')>();
  return {
    ...actual,
    confirmIrreversible: (summary: string, options: { yes?: boolean }) =>
      actual.confirmIrreversible(summary, options, io.current ?? undefined),
  };
});

vi.mock('./target.js', async (orig) => ({
  ...(await orig<typeof import('./target.js')>()),
  resolveTarget: async () => ({
    baseUrl: 'http://127.0.0.1:4517',
    headers: { authorization: 'Bearer t' },
    remote: false,
    note: null,
  }),
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  io.current = null;
});

const empty = { count: 0, totalBytes: 0 };
const usage = {
  count: 3,
  totalBytes: 3072,
  byFrom: {
    human: { count: 2, totalBytes: 2048 },
    clone: { count: 1, totalBytes: 1024 },
    manager: empty,
    integration: empty,
    unknown: empty,
  },
};

function meta(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    name: `${id}.log`,
    mediaType: 'text/plain',
    size: 1024,
    sha256: 'x',
    uploadedBy: 'operator',
    createdAt: '2026-10-07T00:00:00Z',
    expiresAt: '2026-10-08T00:00:00Z',
    ...over,
  };
}

function stubFetch(respond: (url: URL, init: RequestInit | undefined) => Response) {
  const calls: { url: URL; init: RequestInit | undefined }[] = [];
  vi.stubGlobal('fetch', (input: unknown, init?: RequestInit) => {
    const raw = input instanceof Request ? input.url : String(input);
    const url = new URL(raw);
    calls.push({ url, init: init ?? (input instanceof Request ? { method: input.method } : {}) });
    return Promise.resolve(respond(url, init));
  });
  return calls;
}

describe('alteroid attachments ls', () => {
  it('端末では使用量・行・続きの案内を標準出力へ。新しい順（返った順）で、保存中は期限を出さない', async () => {
    const restore = pretendTty(true);
    try {
      const calls = stubFetch(() =>
        Response.json({
          items: [
            meta('att-2', { keptAt: '2026-10-07T01:00:00Z', expiresAt: undefined }),
            meta('att-1', { uploadedBy: 'clone' }),
          ],
          nextCursor: 'CUR',
          usage,
        }),
      );
      const out = captureStdout();
      const err = captureStderr();
      await attachmentsListCommand({ kept: false });
      const text = out();
      expect(text).toContain('使用量: 合計 3 件 3.0 KB（人間 2 件 2.0 KB / クローン 1 件 1.0 KB）');
      expect(text).toMatch(
        /att-2 {2}att-2\.log {2}\(text\/plain, 1\.0 KB\) {2}人間 {2}保存中（期限なし） {2}2026/,
      );
      expect(text).toMatch(
        /att-1 {2}att-1\.log .* {2}クローン {2}2026-10-08T00:00:00Z に消える {2}2026/,
      );
      expect(text.indexOf('att-2')).toBeLessThan(text.indexOf('att-1'));
      expect(text).toContain('--cursor CUR');
      expect(text).not.toContain('undefined');
      expect(err()).toBe('');
      expect(calls).toHaveLength(1);
      expect(calls[0]!.url.pathname).toBe('/attachments');
    } finally {
      restore();
    }
  });

  it('パイプでは標準出力は行だけ（id が先頭）。使用量と案内は標準エラーへ', async () => {
    const restore = pretendTty(false);
    try {
      stubFetch(() => Response.json({ items: [meta('att-1')], nextCursor: 'CUR', usage }));
      const out = captureStdout();
      const err = captureStderr();
      await attachmentsListCommand({});
      expect(out()).toMatch(/^att-1 {2}att-1\.log .*\n$/);
      expect(err()).toContain('使用量: 合計');
      expect(err()).toContain('--cursor CUR');
    } finally {
      restore();
    }
  });

  it('絞り込みはクエリへ載る（--kept / --not-kept / --from / --conversation / --query / --limit / --cursor）', async () => {
    const calls = stubFetch(() => Response.json({ items: [], usage }));
    captureStdout();
    captureStderr();
    await attachmentsListCommand({
      notKept: true,
      from: 'human',
      conversation: 'c-1',
      query: 'LOG',
      limit: '7',
      cursor: 'C0',
    });
    const q = calls[0]!.url.searchParams;
    expect(Object.fromEntries(q)).toEqual({
      kept: '0',
      from: 'human',
      conversationId: 'c-1',
      q: 'LOG',
      limit: '7',
      cursor: 'C0',
    });
    await attachmentsListCommand({ kept: true });
    expect(calls[1]!.url.searchParams.get('kept')).toBe('1');
  });

  it('0 件のときはそう言う。不正な指定は呼ぶ前に断る', async () => {
    const calls = stubFetch(() => Response.json({ items: [], usage }));
    const err = captureStderr();
    const out = captureStdout();
    await attachmentsListCommand({});
    expect(out() + err()).toContain('添付はありません');
    await expect(attachmentsListCommand({ kept: true, notKept: true })).rejects.toThrow('同時に');
    await expect(attachmentsListCommand({ from: 'robot' })).rejects.toThrow('--from');
    await expect(attachmentsListCommand({ limit: '0' })).rejects.toThrow('--limit');
    await expect(attachmentsListCommand({ limit: '201' })).rejects.toThrow('--limit');
    await expect(attachmentsListCommand({ all: true, cursor: 'x' })).rejects.toThrow('--cursor');
    expect(calls).toHaveLength(1);
  });

  it('HTTP の失敗は理由つきの例外にする', async () => {
    stubFetch(() => Response.json({ error: '入力の形が不正: cursor' }, { status: 400 }));
    await expect(attachmentsListCommand({ cursor: 'bad' })).rejects.toThrow('HTTP 400');
  });

  it('--json は API の応答（items と usage）をそのまま出す。続きがあれば nextCursor も', async () => {
    const body = { items: [meta('att-1')], nextCursor: 'CUR', usage };
    stubFetch(() => Response.json(body));
    const out = captureStdout();
    await attachmentsListCommand({ json: true });
    expect(JSON.parse(out())).toEqual(body);
  });

  it('--all は cursor を辿って全部連結し、--json では items を連結して usage を付ける', async () => {
    const pages: Record<string, unknown> = {
      '': { items: [meta('a'), meta('b')], nextCursor: 'P2', usage },
      P2: { items: [meta('c')], nextCursor: 'P3', usage },
      P3: { items: [meta('d')], usage },
    };
    const calls = stubFetch((url) => Response.json(pages[url.searchParams.get('cursor') ?? '']));
    const out = captureStdout();
    await attachmentsListCommand({ all: true, json: true, limit: '2' });
    const parsed = JSON.parse(out());
    expect(parsed.items.map((i: { id: string }) => i.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(parsed.usage).toEqual(usage);
    expect(parsed.nextCursor).toBeUndefined();
    expect(calls.map((c) => c.url.searchParams.get('cursor'))).toEqual([null, 'P2', 'P3']);
    expect(calls.every((c) => c.url.searchParams.get('limit') === '2')).toBe(true);
  });

  it('--all で cursor が進まなければ打ち切る', async () => {
    stubFetch(() => Response.json({ items: [meta('a')], nextCursor: 'SAME', usage }));
    captureStdout();
    await expect(attachmentsListCommand({ all: true, json: true })).rejects.toThrow('進まない');
  });
});

describe('alteroid attachments keep / unkeep', () => {
  it('keep は PATCH {kept:true} を送り、保存中と出す', async () => {
    const calls = stubFetch(() =>
      Response.json(meta('att-1', { keptAt: '2026-10-07T01:00:00Z', expiresAt: undefined })),
    );
    const out = captureStdout();
    await attachmentsKeepCommand('att-1', true);
    expect(calls[0]!.url.pathname).toBe('/attachments/att-1');
    expect(calls[0]!.init?.method).toBe('PATCH');
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ kept: true });
    expect(out()).toContain('保存中（期限なし）');
  });

  it('unkeep は PATCH {kept:false} を送り、いつ消えるかを出す', async () => {
    const calls = stubFetch(() =>
      Response.json(meta('att-1', { releasedAt: '2026-10-07T02:00:00Z' })),
    );
    const out = captureStdout();
    await attachmentsKeepCommand('att-1', false);
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ kept: false });
    expect(out()).toContain('2026-10-08T00:00:00Z に消える');
  });

  it('404 は「そんな添付はありません」', async () => {
    stubFetch(() => Response.json({ error: 'not found' }, { status: 404 }));
    await expect(attachmentsKeepCommand('nope', true)).rejects.toThrow('そんな添付はありません');
    await expect(attachmentsKeepCommand('nope', false)).rejects.toThrow('そんな添付はありません');
  });
});

describe('alteroid attachments rm', () => {
  function fakeIo(over: { isTTY: boolean; answer?: string }) {
    const asked: string[] = [];
    io.current = {
      isTTY: over.isTTY,
      write: () => {},
      ask: async (q) => {
        asked.push(q);
        return over.answer ?? '';
      },
    };
    return asked;
  }

  it('端末で yes と答えれば DELETE する', async () => {
    const asked = fakeIo({ isTTY: true, answer: 'yes' });
    const calls = stubFetch(() => new Response(null, { status: 204 }));
    const out = captureStdout();
    await attachmentsRemoveCommand('att-1', {});
    expect(asked).toHaveLength(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.init?.method).toBe('DELETE');
    expect(calls[0]!.url.pathname).toBe('/attachments/att-1');
    expect(out()).toContain('att-1 を消した');
  });

  it('端末で yes 以外なら何もしない', async () => {
    fakeIo({ isTTY: true, answer: 'no' });
    const calls = stubFetch(() => new Response(null, { status: 204 }));
    await expect(attachmentsRemoveCommand('att-1', {})).rejects.toBeInstanceOf(
      ConfirmDeclinedError,
    );
    expect(calls).toHaveLength(0);
  });

  it('端末でなければ --yes が要り、無ければ呼ばない', async () => {
    fakeIo({ isTTY: false });
    const calls = stubFetch(() => new Response(null, { status: 204 }));
    await expect(attachmentsRemoveCommand('att-1', {})).rejects.toThrow('--yes');
    expect(calls).toHaveLength(0);
  });

  it('--yes は確認せず消す', async () => {
    const asked = fakeIo({ isTTY: false });
    const calls = stubFetch(() => new Response(null, { status: 204 }));
    captureStdout();
    await attachmentsRemoveCommand('att-1', { yes: true });
    expect(asked).toHaveLength(0);
    expect(calls).toHaveLength(1);
  });

  it('404 は「そんな添付はありません」', async () => {
    stubFetch(() => Response.json({ error: 'not found' }, { status: 404 }));
    await expect(attachmentsRemoveCommand('nope', { yes: true })).rejects.toThrow(
      'そんな添付はありません',
    );
  });
});

describe('alteroid attachments put --keep', () => {
  async function file() {
    const dir = await makeTempDir('alteroid-cli-keep-');
    const path = join(dir, 'run.log');
    await writeFile(path, 'hello log');
    return path;
  }

  it('--keep は keep=1 で上げ、「保存した（期限なし）」と出して 1 時間の案内は出さない', async () => {
    const calls = stubFetch(() =>
      Response.json({ ...meta('att-1'), name: 'run.log', size: 9, keptAt: '2026-10-07T01:00:00Z' }),
    );
    const out = captureStdout();
    const err = captureStderr();
    await attachmentsPutCommand(await file(), { keep: true });
    expect(calls[0]!.url.searchParams.get('keep')).toBe('1');
    expect(out()).toBe('att-1\n');
    expect(err()).toContain('保存した（期限なし）');
    expect(err()).not.toContain('1 時間');
  });

  it('--keep が無ければ keep を付けず、従来の案内を出す', async () => {
    const calls = stubFetch(() => Response.json({ ...meta('att-1'), name: 'run.log', size: 9 }));
    captureStdout();
    const err = captureStderr();
    await attachmentsPutCommand(await file());
    expect(calls[0]!.url.searchParams.has('keep')).toBe(false);
    expect(err()).toContain('1 時間以内に発言へ添えないと掃除される');
    expect(err()).not.toContain('保存した');
  });
});
