import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

import { diagnosticsAnalyzeCommand } from './diagnostics-analyze.js';
import { captureStdout } from './test-support.js';

const turnUsage = {
  type: 'turn_usage',
  id: 'u1',
  at: '2026-11-01T16:00:00.000Z',
  layer: 'clone',
  site: 'session',
  managerId: 'm1',
  models: {
    opus: {
      inputTokens: 10,
      outputTokens: 5,
      cacheReadInputTokens: 300,
      cacheCreationInputTokens: 100,
      webSearchRequests: 0,
      costUsd: 0.1,
    },
  },
};
const JOURNAL = `${JSON.stringify(turnUsage)}\nnot json\n`;
const USAGE = JSON.stringify({
  rows: [
    {
      date: '2026-11-02',
      managerId: 'm1',
      model: 'opus',
      layer: 'clone',
      site: 'session',
      totals: {
        inputTokens: 10,
        outputTokens: 5,
        cacheReadInputTokens: 600,
        cacheCreationInputTokens: 100,
        costUsd: 0.1,
      },
    },
  ],
  resets: null,
  ledgerDateTimeZone: { state: 'unavailable', note: 'x' },
});

let dir: string;
let originalFetch: typeof fetch;
let fetchCalls: number;

beforeEach(async () => {
  dir = await makeTempDir('alteroid-analyze-');
  originalFetch = globalThis.fetch;
  fetchCalls = 0;
  globalThis.fetch = (() => {
    fetchCalls += 1;
    return Promise.reject(new Error('通信しないはず'));
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

async function files(): Promise<{ journal: string; usage: string }> {
  const journal = join(dir, 'diag.jsonl');
  const usage = join(dir, 'usage.json');
  await writeFile(journal, JOURNAL);
  await writeFile(usage, USAGE);
  return { journal, usage };
}

async function failureOf(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('reject するはずが resolve した');
}

describe('diagnosticsAnalyzeCommand', () => {
  it('既定は日本語の表。不正な行を数え、通信せず、入力ファイルを書き換えない', async () => {
    const f = await files();
    const read = captureStdout();
    await diagnosticsAnalyzeCommand({ journal: f.journal, usage: f.usage });
    const text = read();
    expect(text).toContain('読めない行 1');
    expect(text).toContain('台帳の resets: 取れない');
    expect(text).toContain('台帳の TZ が不明なので並べない');
    expect(fetchCalls).toBe(0);
    expect(await readFile(f.journal, 'utf8')).toBe(JOURNAL);
    expect(await readFile(f.usage, 'utf8')).toBe(USAGE);
  });

  it('--json は 1 つの JSON を出し、--ledger-tz で日別を並べる（UTC 16:00 は Asia/Tokyo で翌日）', async () => {
    const f = await files();
    const read = captureStdout();
    await diagnosticsAnalyzeCommand({ ...f, ledgerTz: 'Asia/Tokyo', json: true });
    const out = read();
    expect(out.trim().split('\n')).toHaveLength(1);
    const parsed = JSON.parse(out) as {
      header: { invalidLines: number };
      dailyComparison: {
        state: string;
        rows: Array<{ date: string; ledgerOverJournalCacheRead: number | null }>;
      };
    };
    expect(parsed.header.invalidLines).toBe(1);
    expect(parsed.dailyComparison.state).toBe('joined');
    expect(parsed.dailyComparison.rows).toMatchObject([
      { date: '2026-11-02', ledgerOverJournalCacheRead: 2 },
    ]);
  });

  it('不正な IANA 名は理由つきで断る', async () => {
    const f = await files();
    const error = await failureOf(diagnosticsAnalyzeCommand({ ...f, ledgerTz: 'Mars/Base' }));
    expect(error.message).toContain('Mars/Base');
    expect(error.message).toContain('IANA');
  });

  it('--journal が無い・読めない・--usage が JSON でないときは理由を出して断る', async () => {
    const f = await files();
    expect((await failureOf(diagnosticsAnalyzeCommand({}))).message).toContain('--journal');
    expect(
      (await failureOf(diagnosticsAnalyzeCommand({ journal: join(dir, 'nothing') }))).message,
    ).toContain('読めませんでした');
    const bad = join(dir, 'bad.json');
    await writeFile(bad, '{not json');
    expect(
      (await failureOf(diagnosticsAnalyzeCommand({ journal: f.journal, usage: bad }))).message,
    ).toContain('JSON として読めません');
  });

  it('--top は 1 以上の整数', async () => {
    const f = await files();
    const error = await failureOf(diagnosticsAnalyzeCommand({ journal: f.journal, top: '0' }));
    expect(error.message).toContain('--top');
  });
});
