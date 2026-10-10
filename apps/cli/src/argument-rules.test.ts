import { afterEach, describe, expect, it, vi } from 'vitest';

import { AttachmentDraft } from './attachments.js';
import { parseJournalSearchTokens, runSlashCommand } from './chat.js';
import { createClient } from './client.js';
import { normalizeCommandWord, parseCountArg } from './command-args.js';
import type { Target } from './target.js';
import { captureStdout } from './test-support.js';
import { surplusRefusal } from './tui/app.js';

const target: Target = {
  baseUrl: 'http://127.0.0.1:4517',
  headers: { authorization: 'Bearer t' },
  remote: false,
  note: null,
};

const listed = () => ({
  approvals: [],
  managerAnchors: {},
  commitments: [],
  conversations: [],
  managers: [],
  waiting: [],
  messages: [],
  messagesConversationId: null,
  messageAttachments: {},
  messageTexts: {},
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function stubDaemon(): string[] {
  const urls: string[] = [];
  vi.stubGlobal('fetch', (input: unknown) => {
    const url = input instanceof Request ? input.url : String(input);
    urls.push(url);
    if (url.includes('/commitments')) {
      return Promise.resolve(Response.json({ entries: [], unreadable: [], trimmedClosed: 0 }));
    }
    throw new Error(`想定外の要求: ${url}`);
  });
  return urls;
}

async function run(line: string): Promise<{ out: string; failed: string[]; urls: string[] }> {
  const urls = stubDaemon();
  const out = captureStdout();
  const failed: string[] = [];
  await runSlashCommand(
    line,
    createClient(target.baseUrl, target.headers),
    listed(),
    null,
    undefined,
    undefined,
    (reason) => failed.push(reason),
  );
  return { out: out(), failed, urls };
}

describe('件数・分の数は /^\\d+$/ と上限で読む', () => {
  it.each(['1e1', '0x10', '+5', '1.0', '0', '-1', ''])('%s は断る', (token) => {
    expect(parseCountArg(token).ok).toBe(false);
  });

  it('10 は 10 と読み、上限を超えれば断る', () => {
    expect(parseCountArg('10')).toEqual({ ok: true, value: 10 });
    expect(parseCountArg('11', 10).ok).toBe(false);
  });

  it('/journal の件数（CLI の chat と TUI が共有する読み方）は 1e1 を断る', () => {
    expect(parseJournalSearchTokens(['1e1']).ok).toBe(false);
    expect(parseJournalSearchTokens(['10'])).toMatchObject({ ok: true, limit: '10' });
  });
});

describe('キーワードとコマンドの語は大文字小文字を区別しない', () => {
  it('コマンドの語だけを小文字にそろえ、引数と // で始まる本文は変えない', () => {
    expect(normalizeCommandWord('/HELP')).toBe('/help');
    expect(normalizeCommandWord('/Attach /Users/A.txt')).toBe('/attach /Users/A.txt');
    expect(normalizeCommandWord('//Hello')).toBe('//Hello');
  });

  it('/detach ALL は all と同じに読む', () => {
    const draft = new AttachmentDraft();
    expect(draft.remove('ALL')).toEqual({ ok: true, removed: [] });
  });

  it('/commitments ALL は片付いた行も読む', async () => {
    const { urls, failed } = await run('/commitments ALL');
    expect(failed).toEqual([]);
    expect(urls.some((url) => url.includes('includeClosed=true'))).toBe(true);
  });
});

describe('余分な語・知らない語は、使い方の誤りとして断り、デーモンへ送らない', () => {
  it.each([
    ['/commitments foo', '使わない語です: foo（使えるのは /commitments、/commitments all）'],
    ['/unschedule a b', '使い方: /unschedule <kind>'],
    ['/run a b', '使い方: /run <kind>'],
    ['/help me', '使わない語です: me（使えるのは /help だけ。引数は取りません）'],
    ['/waiting x', '使わない語です: x（使えるのは /waiting だけ。引数は取りません）'],
    ['/memory a b', '使わない語です: b（使えるのは /memory、/memory <slug>）'],
    ['/report 2026-10-01 x', '使わない語です: x（使えるのは /report、/report <YYYY-MM-DD>）'],
    ['/reports 1e1', '件数は 1 以上の整数で指定する（1e1）'],
    ['/journal 0x10', '件数は 1〜1000 の整数で指定する（0x10）'],
  ])('%s', async (line, message) => {
    const { out, failed, urls } = await run(line);
    expect(out).toContain(message);
    expect(failed).toHaveLength(1);
    expect(urls).toEqual([]);
  });
});

describe('TUI も同じ規則で断る', () => {
  it('引数を取らないコマンドに語が付いたら断る', () => {
    expect(surplusRefusal('new', 'x')).toBe(
      '使わない語です: x（使えるのは /new だけ。引数は取りません）',
    );
    expect(surplusRefusal('memory', 'x')).toBe(
      '使わない語です: x（使えるのは /memory だけ。引数は取りません）',
    );
    expect(surplusRefusal('new', '')).toBeUndefined();
  });

  it('参照を1つだけ取るコマンドに語が余ったら断る', () => {
    expect(surplusRefusal('resume', 'c1 extra')).toBe(
      '使わない語です: extra（使えるのは /resume、/resume <id>）',
    );
    expect(surplusRefusal('approvals', 'a1')).toBeUndefined();
  });
});
