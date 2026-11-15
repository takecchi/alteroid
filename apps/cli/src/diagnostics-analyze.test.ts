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
    // `prompt`（プロンプトの分析）は後から足された欄。それを除いた残りが既存の欄と1文字も変わらないことは変えずに確かめる
    const { conversation, prompt, ...rest } = parsed;
    expect(prompt).toEqual({ state: 'none', reason: '--prompt も --dir も渡されていない' });
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

// ---- プロンプトの分析（--prompt / --dir の prompt.json）----

const ENV_VALUE = 'dummy-env-secret-value-0123456789';
const PROMPT_TEXT = '導入\n# 立ち位置\n本文\n# 現在の記憶\n\n索引の断片A索引の断片B\n';

function promptJson(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    full: true,
    session: {
      ok: true,
      builtAt: '2026-11-01T23:00:00.000Z',
      resumedFrom: null,
      sessionId: null,
      model: 'opus',
    },
    systemPrompt: { text: PROMPT_TEXT, chars: PROMPT_TEXT.length },
    memoryInPrompt: {
      documents: [
        {
          slug: 'big-doc',
          type: 'premise',
          description: '要旨',
          chars: 900,
          indexChars: 12,
          indexForm: 'premise-card',
          omitted: false,
          indexNote: null,
        },
        {
          slug: `doc-${DUMMY_KEY}`,
          type: 'fact',
          description: null,
          chars: 30,
          indexChars: 3,
          indexForm: 'toc-line',
          omitted: false,
          indexNote: null,
        },
      ],
      omittedDocuments: 0,
    },
    tools: [{ name: 'memory_read', source: 'clone', descriptionChars: 40, inputSchemaChars: 20 }],
    builtinTools: {
      available: false,
      reason: 'SDK は返さない',
      systemTools: null,
      deferredBuiltinTools: null,
    },
    externalMcpServers: [{ name: `srv-${ENV_VALUE}`, type: 'http' }],
    externalMcpServersLive: null,
    plugins: [],
    contextUsage: null,
    notice: ['ターン境界をまだ観測していない'],
    secretScan: { scanned: true, hits: [] },
    ...over,
  });
}

async function promptDir(prompt: string | null): Promise<string> {
  const out = await pullDir();
  if (prompt !== null) await writeFile(join(out, 'prompt.json'), prompt);
  return out;
}

type PromptJsonOutput = {
  prompt: {
    state: string;
    reason?: string;
    systemPrompt?: { chars: number };
    coverage?: { ageAtPullMs: number | null };
  };
};

describe('diagnosticsAnalyzeCommand: プロンプトの分析', () => {
  it('既存の出力は1文字も変わらず、プロンプトの節が最後に足される。--prompt も --dir も無いときは「入力が無い」', async () => {
    const f = await files();
    const expected = renderDiagnosticsAnalysis(
      analyzeDiagnostics(parseJournalJsonl(JOURNAL), { usage: JSON.parse(USAGE), topN: 10 }),
    );
    const read = captureStdout();
    await diagnosticsAnalyzeCommand({ journal: f.journal, usage: f.usage, env: {} });
    const text = read();
    expect(text).toContain(`${expected}\n`);
    expect(text.indexOf('## B. 会話')).toBeLessThan(text.indexOf('# プロンプトの大きさの分析'));
    expect(text.endsWith('\n')).toBe(true);
    const section = text.slice(text.indexOf('# プロンプトの大きさの分析'));
    expect(section).toContain('入力が無い: --prompt も --dir も渡されていない');
    expect(section).toContain('取れない（0 ではない）');
    // 新しい節より前は、この変更の前と同じ並び（既存の2つの節と、その間の空行）
    const before = text.slice(0, text.indexOf('# プロンプトの大きさの分析'));
    expect(before.startsWith('# 会話の分析の coverage')).toBe(true);
    expect(before.endsWith('\n\n')).toBe(true);
  });

  it('--prompt <file> を読み、節ごとの大きさ・索引の突き合わせ・削減候補を出す', async () => {
    const f = await files();
    const path = join(dir, 'prompt.json');
    await writeFile(path, promptJson());
    const read = captureStdout();
    await diagnosticsAnalyzeCommand({ ...f, prompt: path, env: {} });
    const text = read();
    expect(text).toContain('# プロンプトの大きさの分析');
    expect(text).toContain('# 現在の記憶:');
    expect(text).toContain('索引の合計 15字');
    expect(text).toContain('big-doc（premise）: 索引 12字');
    expect(text).toContain('## P8. 定義を短くできる余地の大きい順');
    expect(text).toContain('能力を減らす候補ではなく、定義の簡潔化の候補');
    // contextUsage が無いので、SDK 実測のトークンは「取れない」（0 ではない）
    expect(text).toContain('contextUsage: 未取得');
    expect(text).toContain('トークンの候補: 取れない');
    expect(fetchCalls).toBe(0);
    expect(await readFile(path, 'utf8')).toBe(promptJson());
  });

  it('--dir は prompt.json を既定の名前で読み、manifest の pulledAt から経過を出す。個別の --prompt が優先する', async () => {
    const out = await promptDir(promptJson());
    const read = captureStdout();
    await diagnosticsAnalyzeCommand({ dir: out, env: {}, json: true });
    const parsed = JSON.parse(read()) as PromptJsonOutput;
    expect(parsed.prompt.state).toBe('read');
    expect(parsed.prompt.systemPrompt?.chars).toBe(PROMPT_TEXT.length);
    // builtAt 2026-11-01T23:00 → pulledAt 2026-11-02T00:00
    expect(parsed.prompt.coverage?.ageAtPullMs).toBe(3_600_000);

    const other = join(dir, 'other-prompt.json');
    const otherText = '別の本文\n';
    await writeFile(
      other,
      promptJson({ systemPrompt: { text: otherText, chars: otherText.length } }),
    );
    const read2 = captureStdout();
    await diagnosticsAnalyzeCommand({ dir: out, prompt: other, env: {}, json: true });
    const parsed2 = JSON.parse(read2()) as PromptJsonOutput;
    expect(parsed2.prompt.systemPrompt?.chars).toBe(otherText.length);
  });

  it('prompt.json が無い・壊れている・形が違うときは、落とさず節に「入力が無い／読めない」と理由を出す', async () => {
    const missing = await promptDir(null);
    const read = captureStdout();
    await diagnosticsAnalyzeCommand({ dir: missing, env: {} });
    expect(read()).toContain('入力が無い: prompt.json が --dir に無い');

    const broken = await promptDir('{not json');
    const read2 = captureStdout();
    await diagnosticsAnalyzeCommand({ dir: broken, env: {} });
    expect(read2()).toContain('読めない: JSON として読めない');

    const wrongShape = join(dir, 'wrong.json');
    await writeFile(wrongShape, JSON.stringify({ full: 'yes' }));
    const read3 = captureStdout();
    await diagnosticsAnalyzeCommand({ dir: broken, prompt: wrongShape, env: {} });
    const text3 = read3();
    expect(text3).toContain('読めない: GET /self/prompt の応答の形と合わない');
    expect(text3).toContain('full（invalid_type）');

    // 明示した --prompt のファイルが無くても落とさない
    const read4 = captureStdout();
    await diagnosticsAnalyzeCommand({ dir: missing, prompt: join(dir, 'nope.json'), env: {} });
    const text4 = read4();
    expect(text4).toContain('入力が無い: --prompt のファイルが無い');
    // 既存の節は出ている
    expect(text4).toContain('# 会話の分析の coverage');
  });

  it('--json: 既存の欄と conversation はそのまま、プロンプトの分析は prompt として足される', async () => {
    const f = await files();
    const path = join(dir, 'prompt.json');
    await writeFile(path, promptJson());
    const read = captureStdout();
    await diagnosticsAnalyzeCommand({ ...f, prompt: path, json: true, env: {} });
    const parsed = JSON.parse(read()) as Record<string, unknown> & PromptJsonOutput;
    const { conversation, prompt, ...rest } = parsed;
    expect(rest).toEqual(
      JSON.parse(
        JSON.stringify(
          analyzeDiagnostics(parseJournalJsonl(JOURNAL), { usage: JSON.parse(USAGE), topN: 10 }),
        ),
      ),
    );
    expect(Object.keys(conversation as object).sort()).toEqual([
      'contamination',
      'coverage',
      'estimate',
      'exchanges',
      'measured',
    ]);
    expect(Object.keys(prompt).sort()).toEqual([
      'builtin',
      'candidates',
      'coverage',
      'externalMcp',
      'memory',
      'occupancy',
      'state',
      'systemPrompt',
      'tools',
    ]);
    // prompt.json が無ければ、prompt は state と理由だけ
    const read2 = captureStdout();
    await diagnosticsAnalyzeCommand({ ...f, json: true, env: {} });
    const none = JSON.parse(read2()) as PromptJsonOutput;
    expect(none.prompt).toEqual({
      state: 'none',
      reason: '--prompt も --dir も渡されていない',
    });
  });

  it('表示の直前にもう一度伏せ字を掛ける（slug・サーバ名）。標準エラーには規則名と件数だけで、値は出ない', async () => {
    const out = await promptDir(promptJson());
    const readOut = captureStdout();
    const readErr = captureStderr();
    await diagnosticsAnalyzeCommand({ dir: out, env: { MY_SERVICE_API_KEY: ENV_VALUE } });
    const text = readOut();
    const err = readErr();
    const promptSection = text.slice(text.indexOf('# プロンプトの大きさの分析'));
    for (const secret of [DUMMY_KEY, ENV_VALUE]) {
      expect(promptSection).not.toContain(secret);
      expect(err).not.toContain(secret);
    }
    expect(promptSection).toContain('[redacted:');
    expect(err).toContain('伏せ字: プロンプトの分析（表示の直前の再走査）');
    expect(err).toContain('env:MY_SERVICE_API_KEY 1 件');
    expect(err).toMatch(/ 1 件/);
  });

  it('--top は削減候補の件数に効く', async () => {
    const out = await promptDir(promptJson());
    const read = captureStdout();
    await diagnosticsAnalyzeCommand({ dir: out, top: '1', json: true, env: {} });
    const parsed = JSON.parse(read()) as {
      prompt: { candidates: { chars: { rows: unknown[]; total: number } } };
    };
    expect(parsed.prompt.candidates.chars.rows).toHaveLength(1);
    expect(parsed.prompt.candidates.chars.total).toBeGreaterThan(1);
  });
});
