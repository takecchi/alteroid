import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

import { diagnosticsSummarizeCommand } from './diagnostics-summarize.js';
import { captureStderr, captureStdout } from './test-support.js';

const turnUsage = (managerId: string) => ({
  type: 'turn_usage',
  id: `u-${managerId}`,
  at: '2026-11-01T16:00:00.000Z',
  layer: 'clone',
  site: 'session',
  managerId,
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
});
const USAGE = JSON.stringify({
  rows: [],
  resets: [{ layer: 'clone', managerId: 'm1', resets: 2, lastResetAt: null }],
  ledgerDateTimeZone: { state: 'unavailable', note: 'x' },
});

let dir: string;
let originalFetch: typeof fetch;
let fetchCalls: number;

beforeEach(async () => {
  dir = await makeTempDir('alteroid-summarize-');
  originalFetch = globalThis.fetch;
  fetchCalls = 0;
  globalThis.fetch = (() => {
    fetchCalls += 1;
    return Promise.reject(new Error('通信しないはず'));
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

async function write(name: string, text: string): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, text);
  return path;
}

async function failureOf(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('reject するはずが resolve した');
}

describe('diagnosticsSummarizeCommand', () => {
  it('標準出力に要約の JSON を 1 つ、標準エラーに「送る内容のすべて」の旨を出す。通信せず入力を書き換えない', async () => {
    const text = `${JSON.stringify(turnUsage('m1'))}\nnot json\n`;
    const journal = await write('diag.jsonl', text);
    const usage = await write('usage.json', USAGE);
    const out = captureStdout();
    const err = captureStderr();
    await diagnosticsSummarizeCommand({ journal, usage });
    const lines = out().trim().split('\n');
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0] as string) as {
      schemaVersion: number;
      rows: { invalidLines: number };
      truncated: string[];
      resets: { ledger: { state: string; total: number } };
    };
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.rows.invalidLines).toBe(1);
    expect(parsed.truncated).toEqual([]);
    expect(parsed.resets.ledger).toMatchObject({ state: 'known', total: 2 });
    const note = err();
    expect(note).toContain('この JSON が送る内容のすべて');
    expect(note).toContain('畳んだ節: なし');
    expect(note).toMatch(/\d+ \/ 16384 バイト/);
    expect(fetchCalls).toBe(0);
    expect(await readFile(journal, 'utf8')).toBe(text);
  });

  it('秘密らしい値が許可欄にあれば、何も出さずに断る', async () => {
    const journal = await write(
      'diag.jsonl',
      `${JSON.stringify(turnUsage('altk_abcdefgh12345678'))}\n`,
    );
    const out = captureStdout();
    const error = await failureOf(diagnosticsSummarizeCommand({ journal }));
    expect(error.message).toContain('生成を断った');
    expect(error.message).not.toContain('abcdefgh12345678');
    expect(out()).toBe('');
  });

  it('--top は 1〜20。不正な IANA 名・欠けた入力は理由つきで断る', async () => {
    const journal = await write('diag.jsonl', `${JSON.stringify(turnUsage('m1'))}\n`);
    expect(
      (await failureOf(diagnosticsSummarizeCommand({ journal, top: '21' }))).message,
    ).toContain('--top');
    expect((await failureOf(diagnosticsSummarizeCommand({ journal, top: '0' }))).message).toContain(
      '--top',
    );
    expect(
      (await failureOf(diagnosticsSummarizeCommand({ journal, ledgerTz: 'Mars/Base' }))).message,
    ).toContain('IANA');
    expect((await failureOf(diagnosticsSummarizeCommand({}))).message).toContain('--journal');
    expect(
      (await failureOf(diagnosticsSummarizeCommand({ journal: join(dir, 'nothing') }))).message,
    ).toContain('読めませんでした');
    const bad = await write('bad.json', '{not json');
    expect(
      (await failureOf(diagnosticsSummarizeCommand({ journal, usage: bad }))).message,
    ).toContain('JSON として読めません');
  });
});
