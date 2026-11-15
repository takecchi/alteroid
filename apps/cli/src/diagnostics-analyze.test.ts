import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { analyzeDiagnostics, parseJournalJsonl, renderDiagnosticsAnalysis } from '@alteroid/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

import { diagnosticsAnalyzeCommand } from './diagnostics-analyze.js';
import { captureStderr, captureStdout } from './test-support.js';

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

// ダミーの鍵（どこの鍵でもない。繰り返しで作る）
const DUMMY_KEY = `ghp_${'a1B2'.repeat(9)}`;

const exchangeRow = (
  id: string,
  minute: number,
  text: string,
  extra: Record<string, unknown> = {},
) => ({
  type: 'exchange',
  id,
  at: `2026-11-01T10:${String(minute).padStart(2, '0')}:00.000Z`,
  with: 'manager',
  role: 'inbound',
  text,
  ...extra,
});
const EXCHANGES = [
  { ...exchangeRow('e1', 0, '[応答] [m1] 依頼です'), role: 'outbound', managerId: 'm1' },
  exchangeRow('e2', 1, `[応答] [m1/report] 結果 ${DUMMY_KEY} です`, { managerId: 'm1' }),
  exchangeRow('e3', 2, '[応答] [m1/question] どうしますか', { managerId: 'm1' }),
]
  .map((r) => JSON.stringify(r))
  .join('\n');
const MANIFEST = JSON.stringify({
  version: 1,
  pulledAt: '2026-11-02T00:00:00.000Z',
  window: { since: '2026-11-01T00:00:00.000Z', until: '2026-11-02T00:00:00.000Z' },
  requested: { memory: true, exchanges: true },
  skippedNonManager: 4,
  truncated: [],
  failures: [],
});

async function pullDir(parts: { exchanges?: boolean; manifest?: boolean; journal?: boolean } = {}) {
  const out = join(dir, 'pulled');
  await mkdir(out, { recursive: true });
  if (parts.journal !== false) await writeFile(join(out, 'journal.jsonl'), JOURNAL);
  await writeFile(join(out, 'usage.json'), USAGE);
  if (parts.exchanges !== false) await writeFile(join(out, 'exchanges.jsonl'), `${EXCHANGES}\n`);
  if (parts.manifest !== false) await writeFile(join(out, 'manifest.json'), MANIFEST);
  return out;
}

describe('diagnosticsAnalyzeCommand: 会話の分析', () => {
  it('既存の出力は1文字も変わらず、会話の分析の節が足される（--journal だけでも出る）', async () => {
    const f = await files();
    const expected = renderDiagnosticsAnalysis(
      analyzeDiagnostics(parseJournalJsonl(JOURNAL), { usage: JSON.parse(USAGE), topN: 10 }),
    );
    const read = captureStdout();
    await diagnosticsAnalyzeCommand({ journal: f.journal, usage: f.usage, env: {} });
    const text = read();
    expect(text).toContain(`${expected}\n`);
    // coverage が先頭、会話の節が既存の出力の後ろ
    expect(text.indexOf('# 会話の分析の coverage')).toBe(0);
    expect(text.indexOf('# 診断の集計')).toBeLessThan(text.indexOf('## A. ターンの入力'));
    // 入力の無い節は落とさず「入力が無い」と出す
    expect(text).toContain('exchanges.jsonl: 入力が無い');
    expect(text).toContain('## B. 会話');
    expect(text).toContain('入力が無い: --exchanges も --dir も渡されていない');
  });

  it('--json: 既存の欄はそのまま、会話の分析は conversation として同じ内容が入る', async () => {
    const f = await files();
    await writeFile(join(dir, 'ex.jsonl'), `${EXCHANGES}\n`);
    const read = captureStdout();
    await diagnosticsAnalyzeCommand({
      ...f,
      exchanges: join(dir, 'ex.jsonl'),
      json: true,
      env: {},
    });
    const parsed = JSON.parse(read()) as Record<string, unknown> & {
      conversation: {
        exchanges: { state: string; byKind: Array<{ kind: string; count: number }> };
      };
    };
    const { conversation, ...rest } = parsed;
    expect(rest).toEqual(
      JSON.parse(
        JSON.stringify(
          analyzeDiagnostics(parseJournalJsonl(JOURNAL), { usage: JSON.parse(USAGE), topN: 10 }),
        ),
      ),
    );
    expect(Object.keys(conversation).sort()).toEqual([
      'contamination',
      'coverage',
      'estimate',
      'exchanges',
      'measured',
    ]);
    expect(conversation.exchanges.state).toBe('read');
    expect(conversation.exchanges.byKind.filter((k) => k.count > 0).map((k) => k.kind)).toEqual([
      'report',
      'question',
      'clone_request',
    ]);
  });

  it('--dir は pull の出力を既定の名前で読む（journal・usage・exchanges・manifest）', async () => {
    const out = await pullDir();
    const read = captureStdout();
    await diagnosticsAnalyzeCommand({ dir: out, env: {} });
    const text = read();
    expect(text).toContain('窓 2026-11-01T00:00:00.000Z 〜 2026-11-02T00:00:00.000Z');
    expect(text).toContain('人間との会話の行（保存せず）4');
    expect(text).toContain('読めない行 1'); // journal.jsonl の不正な行
    expect(text).toContain('台帳: 行 1');
    expect(text).toContain('質問（配達行 [id/question]）');
  });

  it('個別の旗が --dir より優先する', async () => {
    const out = await pullDir();
    const other = join(dir, 'other-exchanges.jsonl');
    await writeFile(
      other,
      `${JSON.stringify(exchangeRow('o1', 0, '[応答] [m9/permission] 許可確認', { managerId: 'm9' }))}\n`,
    );
    const read = captureStdout();
    await diagnosticsAnalyzeCommand({ dir: out, exchanges: other, json: true, env: {} });
    const parsed = JSON.parse(read()) as {
      conversation: { exchanges: { byKind: Array<{ kind: string; count: number }> } };
    };
    const counts = Object.fromEntries(
      parsed.conversation.exchanges.byKind.map((k) => [k.kind, k.count]),
    );
    expect(counts).toMatchObject({ permission: 1, report: 0, question: 0 });

    // --journal も同じ（dir の journal.jsonl ではなく、渡したものを読む）
    const journal = join(dir, 'only.jsonl');
    await writeFile(journal, `${JSON.stringify({ ...turnUsage, id: 'u2' })}\n`);
    const read2 = captureStdout();
    await diagnosticsAnalyzeCommand({ dir: out, journal, json: true, env: {} });
    const parsed2 = JSON.parse(read2()) as { header: { invalidLines: number } };
    expect(parsed2.header.invalidLines).toBe(0);
  });

  it('--dir に exchanges.jsonl・manifest.json が無いときは落とさず「入力が無い」と理由を出す。journal.jsonl が無ければ断る', async () => {
    const out = await pullDir({ exchanges: false, manifest: false });
    const read = captureStdout();
    await diagnosticsAnalyzeCommand({ dir: out, env: {} });
    const text = read();
    expect(text).toContain('exchanges.jsonl: 入力が無い（exchanges.jsonl が --dir に無い');
    expect(text).toContain(
      'pull の記録（manifest.json）: 入力が無い（manifest.json が --dir に無い）',
    );

    const none = join(dir, 'empty-dir');
    await mkdir(none, { recursive: true });
    const error = await failureOf(diagnosticsAnalyzeCommand({ dir: none, env: {} }));
    expect(error.message).toContain('journal.jsonl を読めませんでした');
  });

  it('表示の直前にもう一度伏せ字を掛ける。標準エラーには規則名と件数だけで、値は出ない', async () => {
    const out = await pullDir();
    const readOut = captureStdout();
    const readErr = captureStderr();
    await diagnosticsAnalyzeCommand({ dir: out, env: {} });
    const text = readOut();
    const err = readErr();
    expect(text).not.toContain(DUMMY_KEY);
    expect(text).toContain('[redacted:');
    expect(err).toContain('伏せ字: 会話の文面（表示の直前の再走査）');
    expect(err).toMatch(/ 1 件/);
    expect(err).not.toContain(DUMMY_KEY);
  });

  it('--top は会話の上位の件数にも効く', async () => {
    const out = await pullDir();
    const read = captureStdout();
    await diagnosticsAnalyzeCommand({ dir: out, top: '1', json: true, env: {} });
    const parsed = JSON.parse(read()) as { conversation: { exchanges: { top: unknown[] } } };
    expect(parsed.conversation.exchanges.top).toHaveLength(1);
  });
});
