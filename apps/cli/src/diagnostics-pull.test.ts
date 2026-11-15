import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chmod, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { parseJournalJsonl } from '@alteroid/core';
import { JOURNAL_DIAGNOSTICS_TYPES } from '@alteroid/core/journal-diagnostics-format';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

import { diagnosticsAnalyzeCommand } from './diagnostics-analyze.js';
import {
  defaultOutDir,
  diagnosticsPullCommand,
  isSafeMemorySlug,
  resolvePullUrl,
  type PullManifest,
} from './diagnostics-pull.js';
import { captureStderr, captureStdout } from './test-support.js';

const scanControl = vi.hoisted(() => ({ failing: false }));

// 走査の失敗を作るため、本物の redactor を包む（通常は素通し）
vi.mock('@alteroid/core', async (importOriginal) => {
  const original = await importOriginal<typeof import('@alteroid/core')>();
  return {
    ...original,
    createSecretRedactor: (options: Parameters<typeof original.createSecretRedactor>[0]) => {
      const real = original.createSecretRedactor(options);
      if (!scanControl.failing) return real;
      return {
        ...real,
        redact: () => {
          throw new Error('boom');
        },
        redactDeep: () => {
          throw new Error('boom');
        },
      };
    },
  };
});

// ダミーの鍵。どこの鍵でもない（繰り返しで作る）
const GITHUB = `ghp_${'a1B2'.repeat(9)}`;
const ANTHROPIC = `sk-ant-api03-${'Zz9_-'.repeat(8)}Q`;
const OPENAI = `sk-${'q1W2e3R4'.repeat(6)}`;
const ENV_VALUE = 'dummy-env-secret-value-0123456789';
const TOKEN = 'dummy-pull-access-token-5c1d9e';
const ALL_SECRETS = [GITHUB, ANTHROPIC, OPENAI, ENV_VALUE, TOKEN];

const NOW = Date.parse('2026-11-14T00:00:00.000Z');

interface Reply {
  status: number;
  body: unknown;
}
interface Row {
  type: string;
  id: string;
  at: string;
  [key: string]: unknown;
}
interface Config {
  usage: Reply;
  prompt: Reply;
  memoryList: Reply;
  memoryDocs: Record<string, Reply>;
  diag: Row[];
  exchanges: Row[];
  journalFailure?: (type: string) => Reply | undefined;
}
interface Seen {
  path: string;
  query: Record<string, string>;
  authorization: string | undefined;
}

const at = (hour: number): string => `2026-11-13T${String(hour).padStart(2, '0')}:00:00.000Z`;

function diagRow(id: string, hour: number, extra: Record<string, unknown> = {}): Row {
  return {
    type: 'turn_usage',
    id,
    at: at(hour),
    layer: 'clone',
    site: 'session',
    managerId: 'm1',
    models: {},
    ...extra,
  };
}

function exchangeRow(id: string, hour: number, partner: string, text: string): Row {
  return {
    type: 'exchange',
    id,
    at: at(hour),
    with: partner,
    role: 'inbound',
    text,
    ...(partner === 'manager' ? { managerId: 'm1' } : {}),
  };
}

function defaultConfig(): Config {
  return {
    usage: {
      status: 200,
      body: { rows: [], turnRows: [], since: null, notice: 'n', ledgerTimeZone: 'Asia/Tokyo' },
    },
    prompt: {
      status: 200,
      body: {
        full: true,
        session: null,
        systemPrompt: { text: `前置き ${OPENAI} 後ろ`, chars: 20 },
        notice: 'ok',
        secretScan: { hits: [] },
      },
    },
    memoryList: {
      status: 200,
      body: {
        documents: [
          { slug: 'persona', title: 'ペルソナ', kind: 'persona', updatedAt: at(1) },
          { slug: 'notes', title: 'メモ', kind: 'note', updatedAt: at(2) },
        ],
      },
    },
    memoryDocs: {
      persona: {
        status: 200,
        body: {
          document: { slug: 'persona', content: `---\ntitle: ペルソナ\n---\nキー ${ANTHROPIC}\n` },
          version: 'v-persona-1',
        },
      },
      notes: {
        status: 200,
        body: { document: { slug: 'notes', content: '普通のメモ\n' }, version: 'v-notes-1' },
      },
    },
    diag: [
      diagRow('d1', 1),
      diagRow('d2', 2, { note: `鍵 ${GITHUB} が混ざった` }),
      diagRow('d3', 3),
      {
        type: 'turn_input',
        id: 'd4',
        at: at(4),
        kind: 'normal',
        triggers: ['manager_message'],
        totalChars: 120,
        bodyChars: 100,
        humanActionsChars: 0,
        freshMemoryChars: 0,
        notices: { situation: 20 },
        signals: [{ kind: 'manager_message', managerId: 'm1', chars: 100 }],
      },
    ],
    exchanges: [
      exchangeRow('e1', 1, 'manager', `依頼 ${GITHUB} です`),
      exchangeRow('e2', 2, 'human', '人間との会話（保存しない）'),
      exchangeRow('e3', 3, 'manager', '[応答] [m1/report] 普通の報告'),
      exchangeRow('e4', 4, 'human', '人間との会話その2'),
      exchangeRow('e5', 5, 'manager', `環境変数の値 ${ENV_VALUE} が写った`),
    ],
  };
}

interface Fake {
  origin: string;
  seen: Seen[];
  config: Config;
  close: () => Promise<void>;
}

async function startFake(configure: (config: Config) => void = () => undefined): Promise<Fake> {
  const config = defaultConfig();
  configure(config);
  const seen: Seen[] = [];
  const server: Server = createServer((req: IncomingMessage, res) => {
    const url = new URL(req.url ?? '/', 'http://fake');
    const query = Object.fromEntries(url.searchParams.entries());
    seen.push({ path: url.pathname, query, authorization: req.headers.authorization });
    const send = (reply: Reply): void => {
      res.writeHead(reply.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply.body));
    };
    if (url.pathname === '/usage') return send(config.usage);
    if (url.pathname === '/self/prompt') return send(config.prompt);
    if (url.pathname === '/memory') return send(config.memoryList);
    if (url.pathname.startsWith('/memory/')) {
      const slug = decodeURIComponent(url.pathname.slice('/memory/'.length));
      return send(config.memoryDocs[slug] ?? { status: 404, body: { error: 'not found' } });
    }
    if (url.pathname === '/journal') {
      const type = query['type'] ?? '';
      const failure = config.journalFailure?.(type);
      if (failure !== undefined) return send(failure);
      const source = type === 'exchange' ? config.exchanges : config.diag;
      const start =
        query['afterId'] === undefined ? 0 : source.findIndex((r) => r.id === query['afterId']) + 1;
      const limit = Number(query['limit'] ?? '50');
      const entries = source.slice(start, start + limit);
      const last = entries.at(-1);
      const more = start + limit < source.length;
      return send({
        status: 200,
        body: { entries, next: more && last !== undefined ? { id: last.id, at: last.at } : null },
      });
    }
    return send({ status: 404, body: { error: 'unknown' } });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${String(port)}`,
    seen,
    config,
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}

let dir: string;
let fake: Fake | null = null;
let tokenPath: string;
let stderrText: () => string;
let stdoutText: () => string;

beforeEach(async () => {
  dir = await makeTempDir('alteroid-cli-pull-test-');
  tokenPath = join(dir, 'token');
  await writeFile(tokenPath, `${TOKEN}\n`, { mode: 0o600 });
  await chmod(tokenPath, 0o600);
  scanControl.failing = false;
  stderrText = captureStderr();
  stdoutText = captureStdout();
});

afterEach(async () => {
  process.exitCode = undefined;
  scanControl.failing = false;
  vi.restoreAllMocks();
  await fake?.close();
  fake = null;
});

async function start(configure?: (config: Config) => void): Promise<Fake> {
  fake = await startFake(configure);
  return fake;
}

function pull(
  server: Fake,
  extra: Partial<Parameters<typeof diagnosticsPullCommand>[0]> = {},
): Promise<PullManifest> {
  return diagnosticsPullCommand({
    url: server.origin,
    out: join(dir, 'out'),
    tokenFile: tokenPath,
    now: NOW,
    env: {},
    ...extra,
  });
}

async function allFiles(root: string, prefix = ''): Promise<string[]> {
  const names: string[] = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) names.push(...(await allFiles(root, rel)));
    else names.push(rel);
  }
  return names.sort();
}

const out = (name: string): string => join(dir, 'out', name);
const readOut = (name: string): Promise<string> => readFile(out(name), 'utf8');
const linesOf = (text: string): string[] => text.split('\n').filter((l) => l !== '');

describe('diagnostics pull: 全部取れる', () => {
  it('ファイルを書き、ディレクトリは 0700・ファイルは 0600、終了コードは 0', async () => {
    const server = await start();
    const manifest = await pull(server);

    expect(process.exitCode).toBeUndefined();
    expect(manifest.failures).toEqual([]);
    expect(await allFiles(join(dir, 'out'))).toEqual([
      'exchanges.jsonl',
      'journal.jsonl',
      'manifest.json',
      'memory/index.json',
      'memory/notes.md',
      'memory/persona.md',
      'prompt.json',
      'usage.json',
    ]);
    expect((await stat(join(dir, 'out'))).mode & 0o777).toBe(0o700);
    expect((await stat(out('memory'))).mode & 0o777).toBe(0o700);
    for (const name of await allFiles(join(dir, 'out'))) {
      expect((await stat(out(name))).mode & 0o777).toBe(0o600);
    }
  });

  it('全部の要求に、トークンファイルのトークンが Bearer で付く', async () => {
    const server = await start();
    await pull(server);
    expect(server.seen.length).toBeGreaterThan(0);
    for (const request of server.seen) expect(request.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('日誌は診断の型の許可リスト全部（http_timing を含む）で、窓と昇順を渡す', async () => {
    const server = await start();
    await pull(server);
    const journal = server.seen.find(
      (r) => r.path === '/journal' && r.query['type'] !== 'exchange',
    );
    expect((journal?.query['type'] ?? '').split(',').sort()).toEqual(
      [...JOURNAL_DIAGNOSTICS_TYPES].sort(),
    );
    expect(journal?.query['type']).toContain('turn_input');
    expect(journal?.query['type']).toContain('http_timing');
    expect(journal?.query['since']).toBe('2026-11-13T00:00:00.000Z');
    expect(journal?.query['until']).toBe('2026-11-14T00:00:00.000Z');
    expect(journal?.query['order']).toBe('asc');
  });

  it('usage.json は usage --json と同じ形（resets と台帳の時間帯の明示つき）で、台帳の日付を窓から引く', async () => {
    const server = await start();
    await pull(server);
    const usage = JSON.parse(await readOut('usage.json')) as Record<string, unknown>;
    expect(usage['resets']).toBeNull();
    expect(usage['ledgerDateTimeZone']).toEqual({ state: 'known', name: 'Asia/Tokyo' });
    const request = server.seen.find((r) => r.path === '/usage');
    expect(request?.query).toEqual({ from: '2026-11-13', to: '2026-11-14' });
  });

  it('manifest: origin だけの url・窓・行数・バイト数・伏せ字済みの印', async () => {
    const server = await start();
    const manifest = await pull(server);
    const onDisk = JSON.parse(await readOut('manifest.json')) as PullManifest;
    expect(onDisk).toEqual(manifest);
    expect(manifest.url).toBe(server.origin);
    expect(manifest.redacted).toBe(true);
    expect(manifest.window).toEqual({
      since: '2026-11-13T00:00:00.000Z',
      until: '2026-11-14T00:00:00.000Z',
    });
    expect(manifest.files['journal.jsonl']?.rows).toBe(4);
    expect(manifest.files['exchanges.jsonl']?.rows).toBe(3);
    expect(manifest.files['journal.jsonl']?.bytes).toBe(
      Buffer.byteLength(await readOut('journal.jsonl')),
    );
    expect(manifest.truncated).toEqual([]);
  });

  it('--json は manifest を標準出力へ出す', async () => {
    const server = await start();
    const manifest = await pull(server, { json: true });
    expect(JSON.parse(stdoutText())).toEqual(manifest);
  });
});

describe('diagnostics pull: 既存の analyze に食わせられる', () => {
  it('journal.jsonl は parseJournalJsonl が全行読め、analyze --journal --usage がそのまま通る', async () => {
    const server = await start();
    await pull(server);

    const parsed = parseJournalJsonl(await readOut('journal.jsonl'));
    expect(parsed.invalidLines).toBe(0);
    expect(parsed.rows).toHaveLength(4);
    // 診断の新しい型（turn_input）も保存され、既存の読み手が読める
    expect(parsed.rows.map((r) => r.type)).toContain('turn_input');

    await diagnosticsAnalyzeCommand({
      journal: out('journal.jsonl'),
      usage: out('usage.json'),
      json: true,
    });
    const analysis = JSON.parse(
      stdoutText()
        .split('\n')
        .filter((l) => l.startsWith('{'))
        .at(-1) ?? '',
    ) as unknown;
    expect(analysis).toBeTypeOf('object');
  });

  it('analyze --dir は pull の出力（偽サーバの応答）を既定の名前でまとめて読み、会話の分析と manifest の要約を出す', async () => {
    const server = await start();
    await pull(server);
    const before = stdoutText().length;

    // pull（この試験では環境の鍵を持たせていない）が伏せなかった環境変数の値も、analyze の再走査が表示の直前に伏せる
    await diagnosticsAnalyzeCommand({
      dir: join(dir, 'out'),
      env: { MY_SERVICE_API_KEY: ENV_VALUE },
    });
    const text = stdoutText().slice(before);
    // manifest の窓と、pull が保存しなかった人間との会話の行数（偽サーバは 2 行返す）
    expect(text).toContain('窓 2026-11-13T00:00:00.000Z 〜 2026-11-14T00:00:00.000Z');
    expect(text).toContain('人間との会話の行（保存せず）2');
    // turn_input は実測の節に入る（偽サーバの行は欄が足りないので「取れない」に数えられ、落ちない）
    expect(text).toContain('## A. ターンの入力（実測');
    expect(text).toContain('ターン 1（');
    // exchanges.jsonl の3行: 配達行の報告が1件、接頭辞の無い行はその他に数える
    expect(text).toContain('報告（配達行 [id/report]）: 1件');
    expect(text).toContain('その他（分類できなかった行）: 2件');
    // pull が伏せた鍵は出力に無く、再走査の結果は標準エラーに規則名と件数だけ出る
    for (const secret of [GITHUB, ANTHROPIC, OPENAI, ENV_VALUE]) expect(text).not.toContain(secret);
    expect(stderrText()).not.toContain(ENV_VALUE);
    expect(stderrText()).toContain('env:MY_SERVICE_API_KEY 1 件');
    expect(stderrText()).toContain('伏せ字: 会話の文面（表示の直前の再走査）');
    expect(process.exitCode).toBeUndefined();
  });
});

describe('diagnostics pull: analyze --dir がプロンプトの分析に読める', () => {
  const PROMPT_TEXT = '導入\n# 立ち位置\n本文\n# 現在の記憶\n\n索引A索引B\n';
  // `GET /self/prompt` の応答の形（#6819 の selfPromptResponseSchema）。偽サーバが返し、pull が保存したものを analyze が読む
  const validPrompt = {
    full: true,
    session: {
      ok: true,
      builtAt: '2026-11-13T22:00:00.000Z',
      resumedFrom: null,
      sessionId: 'sess-1',
      model: 'opus',
    },
    systemPrompt: { text: PROMPT_TEXT, chars: PROMPT_TEXT.length },
    memoryInPrompt: {
      documents: [
        {
          slug: 'notes',
          type: 'fact',
          description: null,
          chars: 40,
          indexChars: 5,
          indexForm: 'toc-line',
          omitted: false,
          indexNote: null,
        },
        {
          slug: 'old',
          type: 'note',
          description: null,
          chars: 4000,
          indexChars: null,
          indexForm: null,
          omitted: true,
          indexNote: '索引の予算を超えた',
        },
      ],
      omittedDocuments: 0,
    },
    tools: [{ name: 'memory_read', source: 'clone', descriptionChars: 30, inputSchemaChars: 10 }],
    builtinTools: {
      available: false,
      reason: 'SDK は返さない',
      systemTools: null,
      deferredBuiltinTools: null,
    },
    externalMcpServers: [],
    externalMcpServersLive: null,
    plugins: [],
    contextUsage: null,
    notice: ['ターン境界をまだ観測していない'],
    secretScan: { scanned: true, hits: [] },
  };

  it('pull の出力（prompt.json）を --dir だけで読み、manifest の pulledAt から経過も出す', async () => {
    const server = await start((config) => {
      config.prompt = { status: 200, body: validPrompt };
    });
    await pull(server);
    const before = stdoutText().length;

    await diagnosticsAnalyzeCommand({ dir: join(dir, 'out'), env: {} });
    const text = stdoutText().slice(before);
    expect(text).toContain('# プロンプトの大きさの分析');
    expect(text).toContain('session: 成功 / builtAt 2026-11-13T22:00:00.000Z / model opus');
    // pulledAt は NOW = 2026-11-14T00:00:00Z
    expect(text).toContain('プロンプトが焼かれてからの経過: 2.0 時間');
    expect(text).toContain('索引の合計 5字');
    expect(text).toContain('notes（fact）: 索引 5字');
    expect(text).toContain('old（note）: 索引から省かれた');
    expect(text).toContain('indexNote: 索引の予算を超えた');
  });

  it('既定の偽サーバの応答（形が合わない prompt.json）でも落とさず、節に「読めない」と理由を出す', async () => {
    const server = await start();
    await pull(server);
    const before = stdoutText().length;
    await diagnosticsAnalyzeCommand({ dir: join(dir, 'out'), env: {} });
    const text = stdoutText().slice(before);
    expect(text).toContain('読めない: GET /self/prompt の応答の形と合わない');
    expect(text).toContain('## B. 会話');
    expect(process.exitCode).toBeUndefined();
  });
});

describe('diagnostics pull: 会話（exchange）', () => {
  it('with が manager の行だけを日誌の行そのままで保存し、それ以外は数だけ manifest に残す', async () => {
    const server = await start();
    const manifest = await pull(server);
    const rows = linesOf(await readOut('exchanges.jsonl')).map((l) => JSON.parse(l) as Row);
    expect(rows.map((r) => r.id)).toEqual(['e1', 'e3', 'e5']);
    expect(rows.every((r) => r['with'] === 'manager')).toBe(true);
    // 欄を足し引きしない（鍵を含まない行はそのまま）
    expect(rows[1]).toEqual(server.config.exchanges[2]);
    expect(manifest.skippedNonManager).toBe(2);
    expect(await readOut('exchanges.jsonl')).not.toContain('人間との会話');
  });

  it('頁送り: afterId と afterAt を組で渡し、next が null になるまで追う', async () => {
    const server = await start();
    await pull(server, { pageSize: '2' });
    const pages = server.seen.filter(
      (r) => r.path === '/journal' && r.query['type'] === 'exchange',
    );
    expect(pages.map((p) => p.query['afterId'])).toEqual([undefined, 'e2', 'e4']);
    for (const page of pages.slice(1)) {
      expect(page.query['afterAt']).toBeDefined();
      expect(page.query['limit']).toBe('2');
    }
    expect(linesOf(await readOut('exchanges.jsonl'))).toHaveLength(3);
  });

  it('行数の上限で止め、黙って切らずに truncated に記録する（失敗ではなく警告: 終了コード 0）', async () => {
    const server = await start();
    const manifest = await pull(server, { pageSize: '2', limits: { maxRows: 4 } });
    expect(linesOf(await readOut('exchanges.jsonl'))).toHaveLength(2);
    expect(manifest.truncated).toEqual([
      expect.objectContaining({ part: 'exchanges', reason: 'rows', limit: 4 }),
    ]);
    expect(manifest.failures).toEqual([]);
    expect(process.exitCode).toBeUndefined();
    expect(stderrText()).toContain('上限');
  });

  it('バイトの上限でも止め、書いた分は上限を超えない', async () => {
    const server = await start();
    const manifest = await pull(server, { limits: { maxBytes: 300 } });
    const text = await readOut('exchanges.jsonl');
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(300);
    const truncated = manifest.truncated.find((t) => t.part === 'exchanges');
    expect(truncated?.reason).toBe('bytes');
    expect(manifest.files['exchanges.jsonl']?.bytes).toBe(Buffer.byteLength(text));
  });

  it('exchange でない行が返ったら、その行を書かずに止めて失敗にする', async () => {
    const server = await start((config) => {
      config.exchanges = [
        exchangeRow('e1', 1, 'manager', 'ok'),
        { type: 'external_event', id: 'x1', at: at(2), with: 'manager', text: '混ざった' },
      ];
    });
    const manifest = await pull(server);
    expect(linesOf(await readOut('exchanges.jsonl'))).toHaveLength(1);
    expect(manifest.failures.map((f) => f.part)).toEqual(['exchanges']);
    expect(process.exitCode).toBe(1);
  });
});

describe('diagnostics pull: --no-memory / --no-exchanges', () => {
  it('--no-memory は記憶を取りに行かず、memory/ を作らない', async () => {
    const server = await start();
    const manifest = await pull(server, { memory: false });
    expect(server.seen.some((r) => r.path.startsWith('/memory'))).toBe(false);
    expect((await allFiles(join(dir, 'out'))).some((f) => f.startsWith('memory/'))).toBe(false);
    expect(manifest.requested).toEqual({ memory: false, exchanges: true });
  });

  it('--no-exchanges は会話を取りに行かず、exchanges.jsonl を作らない', async () => {
    const server = await start();
    const manifest = await pull(server, { exchanges: false });
    expect(server.seen.some((r) => r.query['type'] === 'exchange')).toBe(false);
    expect(await allFiles(join(dir, 'out'))).not.toContain('exchanges.jsonl');
    expect(manifest.skippedNonManager).toBeNull();
    expect(manifest.requested).toEqual({ memory: true, exchanges: false });
  });
});

describe('diagnostics pull: 部分的な失敗は、取れた分を残して終了コード 1', () => {
  const cases: readonly [
    part: string,
    status: number,
    configure: (config: Config) => void,
    kept: string[],
    missing: string[],
  ][] = [
    [
      'usage',
      500,
      (c) => (c.usage = { status: 500, body: { error: '台帳が読めない' } }),
      ['journal.jsonl', 'prompt.json', 'exchanges.jsonl', 'memory/index.json'],
      ['usage.json'],
    ],
    [
      'journal',
      503,
      (c) =>
        (c.journalFailure = (t) =>
          t === 'exchange' ? undefined : { status: 503, body: { error: 'x' } }),
      ['usage.json', 'prompt.json', 'exchanges.jsonl', 'memory/index.json'],
      ['journal.jsonl'],
    ],
    [
      'prompt',
      404,
      (c) => (c.prompt = { status: 404, body: { error: 'not found' } }),
      ['usage.json', 'journal.jsonl', 'exchanges.jsonl', 'memory/index.json'],
      ['prompt.json'],
    ],
    [
      'memory',
      500,
      (c) => (c.memoryList = { status: 500, body: { error: 'x' } }),
      ['usage.json', 'journal.jsonl', 'prompt.json', 'exchanges.jsonl'],
      ['memory/index.json'],
    ],
    [
      'exchanges',
      500,
      (c) =>
        (c.journalFailure = (t) =>
          t === 'exchange' ? { status: 500, body: { error: 'x' } } : undefined),
      ['usage.json', 'journal.jsonl', 'prompt.json', 'memory/index.json'],
      ['exchanges.jsonl'],
    ],
  ];

  it.each(cases)(
    '%s が %i で失敗しても、他は残り終了コードは 1',
    async (part, status, configure, kept, missing) => {
      const server = await start(configure);
      const manifest = await pull(server);
      const files = await allFiles(join(dir, 'out'));
      for (const name of kept) expect(files).toContain(name);
      for (const name of missing) expect(files).not.toContain(name);
      expect(manifest.failures).toEqual([expect.objectContaining({ part, status })]);
      expect(process.exitCode).toBe(1);
      expect(files).toContain('manifest.json');
    },
  );

  it('通信できないときも、失敗を記録して終了コード 1（例外で全部を捨てない）', async () => {
    const server = await start();
    const origin = server.origin;
    await server.close();
    fake = null;
    const manifest = await diagnosticsPullCommand({
      url: origin,
      out: join(dir, 'out'),
      tokenFile: tokenPath,
      now: NOW,
      env: {},
    });
    expect(manifest.failures.length).toBeGreaterThanOrEqual(3);
    expect(manifest.failures.every((f) => f.status === null)).toBe(true);
    expect(process.exitCode).toBe(1);
  });

  it('401 は既存の文言（alteroid login へ誘導）を使い、トークンの値を出さない', async () => {
    const server = await start((config) => {
      const denied = { status: 401, body: { error: '資格が無い' } };
      config.usage = denied;
      config.prompt = denied;
      config.memoryList = denied;
      config.journalFailure = () => denied;
    });
    const manifest = await pull(server);
    expect(manifest.failures.length).toBe(5);
    for (const failure of manifest.failures) {
      expect(failure.status).toBe(401);
      expect(failure.reason).toContain('alteroid login');
    }
    expect(JSON.stringify(manifest)).not.toContain(TOKEN);
    expect(process.exitCode).toBe(1);
  });

  it('途中の頁で失敗したら、それまでの行は残し、どこまで書いたかを理由に書く', async () => {
    const server = await start();
    let calls = 0;
    server.config.journalFailure = (type) => {
      if (type !== 'exchange') return undefined;
      calls += 1;
      return calls === 2 ? { status: 502, body: { error: 'x' } } : undefined;
    };
    const manifest = await pull(server, { pageSize: '2' });
    expect(linesOf(await readOut('exchanges.jsonl'))).toHaveLength(1);
    expect(manifest.failures).toEqual([
      expect.objectContaining({
        part: 'exchanges',
        status: 502,
        reason: expect.stringContaining('1 行'),
      }),
    ]);
    expect(process.exitCode).toBe(1);
  });
});

describe('diagnostics pull: 出力先', () => {
  it('空でない既存の出力先は、通信する前に断る（上書きしない）', async () => {
    const server = await start();
    await writeFile(join(dir, 'already'), 'x');
    await expect(pull(server, { out: dir })).rejects.toThrow(/空ではありません/);
    expect(server.seen).toEqual([]);
    expect(await readFile(join(dir, 'already'), 'utf8')).toBe('x');
  });

  it('既存の空のディレクトリは使え、0700 に絞る', async () => {
    const server = await start();
    const empty = join(dir, 'empty');
    await mkdir(empty, { mode: 0o755 });
    await pull(server, { out: empty });
    expect((await stat(empty)).mode & 0o777).toBe(0o700);
  });

  it('既定の名前は ./diagnostics-pull-<host>-<UTC 時刻>', () => {
    expect(defaultOutDir(new URL('https://alteroid.example.com:8443'), NOW)).toBe(
      './diagnostics-pull-alteroid.example.com-8443-20261114T000000Z',
    );
  });
});

describe('diagnostics pull: 記憶の slug（パストラバーサル）', () => {
  it.each(['../evil', 'a/b', '..', '.hidden', 'UPPER', 'a..b', '', 'x'.repeat(200)])(
    'slug %j は書かず、取りにも行かず、失敗として記録する',
    async (slug) => {
      const server = await start((config) => {
        config.memoryList = {
          status: 200,
          body: {
            documents: [
              { slug, title: 't' },
              { slug: 'notes', title: 'ok' },
            ],
          },
        };
        config.memoryDocs[slug] = {
          status: 200,
          body: { document: { slug, content: '罠' }, version: 'v' },
        };
      });
      const manifest = await pull(server);
      const files = await allFiles(join(dir, 'out'));
      expect(files).toContain('memory/notes.md');
      expect(files.filter((f) => f.startsWith('memory/') && f !== 'memory/index.json')).toEqual([
        'memory/notes.md',
      ]);
      await expect(stat(join(dir, 'evil.md'))).rejects.toThrow();
      await expect(stat(join(dir, 'out', 'evil.md'))).rejects.toThrow();
      expect(
        server.seen.some((r) => r.path.startsWith('/memory/') && r.path !== '/memory/notes'),
      ).toBe(false);
      expect(manifest.failures).toEqual([
        expect.objectContaining({ part: 'memory', status: null }),
      ]);
      expect(process.exitCode).toBe(1);
    },
  );

  it('安全な slug は通す', () => {
    for (const slug of ['persona', 'my-notes_2.v1', 'a.b'])
      expect(isSafeMemorySlug(slug)).toBe(true);
  });
});

describe('diagnostics pull: 伏せ字', () => {
  async function pullWithSecrets(): Promise<{ manifest: PullManifest; server: Fake }> {
    const server = await start();
    const manifest = await pull(server, {
      env: { ALTEROID_DUMMY_API_KEY: ENV_VALUE },
    });
    return { manifest, server };
  }

  it('保存した全ファイルのどこにも、仕込んだ鍵が含まれない', async () => {
    await pullWithSecrets();
    for (const name of await allFiles(join(dir, 'out'))) {
      const text = await readOut(name);
      for (const secret of ALL_SECRETS)
        expect(text, `${name} に ${secret.slice(0, 6)}…`).not.toContain(secret);
    }
  });

  it('伏せた後も、JSONL の各行・JSON ファイルは JSON.parse できる', async () => {
    await pullWithSecrets();
    for (const name of ['journal.jsonl', 'exchanges.jsonl']) {
      for (const line of linesOf(await readOut(name))) expect(() => JSON.parse(line)).not.toThrow();
    }
    for (const name of ['usage.json', 'prompt.json', 'manifest.json', 'memory/index.json']) {
      const text = await readOut(name);
      expect(() => JSON.parse(text)).not.toThrow();
    }
    const first = JSON.parse(linesOf(await readOut('exchanges.jsonl'))[0] ?? '') as Row;
    expect(first['text']).toBe('依頼 [redacted:github-token] です');
    const prompt = JSON.parse(await readOut('prompt.json')) as { systemPrompt: { text: string } };
    expect(prompt.systemPrompt.text).toContain('[redacted:openai-key]');
  });

  it('記憶の本文は伏せ、版はサーバの値のまま、伏せたことを index.json の文書ごとに記録する', async () => {
    await pullWithSecrets();
    expect(await readOut('memory/persona.md')).toBe(
      '---\ntitle: ペルソナ\n---\nキー [redacted:anthropic-key]\n',
    );
    expect(await readOut('memory/notes.md')).toBe('普通のメモ\n');
    const index = JSON.parse(await readOut('memory/index.json')) as {
      documents: { slug: string; version: string; redacted: boolean; file: string }[];
    };
    const persona = index.documents.find((d) => d.slug === 'persona');
    const notes = index.documents.find((d) => d.slug === 'notes');
    expect(persona).toMatchObject({ version: 'v-persona-1', redacted: true, file: 'persona.md' });
    expect(notes).toMatchObject({ version: 'v-notes-1', redacted: false });
  });

  it('標準エラーには規則名と件数だけが出て、値は出ない。当たり 0 件でも走査したと出る', async () => {
    const { manifest } = await pullWithSecrets();
    const text = stderrText();
    expect(text).toContain('伏せ字: exchanges.jsonl — ');
    expect(text).toContain('github-token 1 件');
    expect(text).toContain('env:ALTEROID_DUMMY_API_KEY 1 件');
    expect(text).toContain('伏せ字: usage.json — 走査済み（当たり 0 件）');
    for (const secret of ALL_SECRETS) expect(text).not.toContain(secret);
    expect(manifest.redaction['exchanges.jsonl']).toEqual({
      scanned: true,
      hits: [
        { rule: 'env:ALTEROID_DUMMY_API_KEY', count: 1 },
        { rule: 'github-token', count: 1 },
      ],
    });
    expect(manifest.redaction['journal.jsonl']?.hits).toEqual([{ rule: 'github-token', count: 1 }]);
    expect(manifest.redaction['memory/*.md']?.hits).toEqual([{ rule: 'anthropic-key', count: 1 }]);
    expect(manifest.redaction['usage.json']).toEqual({ scanned: true, hits: [] });
  });

  it('走査が例外で落ちたら、そのファイルを書かずに失敗として記録する（途中の tmp も残さない）', async () => {
    const server = await start();
    scanControl.failing = true;
    const manifest = await pull(server);
    const files = await allFiles(join(dir, 'out'));
    expect(files).toEqual(['manifest.json']);
    expect(manifest.failures.map((f) => f.part).sort()).toEqual([
      'exchanges',
      'journal',
      'memory/index.json',
      'memory/notes',
      'memory/persona',
      'prompt',
      'usage',
    ]);
    for (const failure of manifest.failures) expect(failure.reason).toContain('書かなかった');
    expect(process.exitCode).toBe(1);
  });
});

describe('diagnostics pull: 資格と接続先', () => {
  it('トークンの値は、標準出力・標準エラー・manifest・保存したファイルのどこにも出ない', async () => {
    const server = await start();
    await pull(server, { json: true });
    const everything = [stdoutText(), stderrText()];
    for (const name of await allFiles(join(dir, 'out'))) everything.push(await readOut(name));
    for (const text of everything) expect(text).not.toContain(TOKEN);
  });

  it('権限が緩いトークンファイルは、通信する前に断り、値を出さない', async () => {
    const server = await start();
    await chmod(tokenPath, 0o644);
    const error = await pull(server).catch((e: unknown) => e as Error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('chmod 600');
    expect((error as Error).message).not.toContain(TOKEN);
    expect(server.seen).toEqual([]);
    expect(await readdir(dir)).not.toContain('out');
  });

  it('トークンファイルを指定したのに読めないとき、credentials.json へ落ちない', async () => {
    const server = await start();
    await expect(pull(server, { tokenFile: join(dir, 'nope') })).rejects.toThrow(/ありません/);
    expect(server.seen).toEqual([]);
  });
});

describe('resolvePullUrl', () => {
  const env = {};

  it('--url も ALTEROID_URL も無ければ、手元のデーモンへ繋がず断る', () => {
    expect(() => resolvePullUrl(undefined, env)).toThrow(/--url が必要/);
    expect(() => resolvePullUrl('  ', env)).toThrow(/--url が必要/);
  });

  it('ALTEROID_URL を既定にでき、--url が優先する', () => {
    expect(resolvePullUrl(undefined, { ALTEROID_URL: 'https://a.example.com/' }).origin).toBe(
      'https://a.example.com',
    );
    expect(
      resolvePullUrl('https://b.example.com', { ALTEROID_URL: 'https://a.example.com' }).origin,
    ).toBe('https://b.example.com');
  });

  it('loopback 以外の http は断り、loopback の http と https は通す', () => {
    expect(() => resolvePullUrl('http://alteroid.example.com', env)).toThrow(/loopback/);
    expect(() => resolvePullUrl('http://10.0.0.5:4517', env)).toThrow(/loopback/);
    for (const ok of [
      'http://127.0.0.1:4517',
      'http://localhost:4517',
      'http://[::1]:4517',
      'https://x.example.com',
    ]) {
      expect(() => resolvePullUrl(ok, env)).not.toThrow();
    }
  });

  it('資格・パス・クエリを含む URL は、値を出さずに断る', () => {
    const withCreds = 'https://user:pa55w0rd-dummy@x.example.com';
    const error = (() => {
      try {
        resolvePullUrl(withCreds, env);
      } catch (e) {
        return e as Error;
      }
      throw new Error('断るはず');
    })();
    expect(error.message).not.toContain('pa55w0rd-dummy');
    expect(() => resolvePullUrl('https://x.example.com/api', env)).toThrow(/origin だけ/);
    expect(() => resolvePullUrl('https://x.example.com/?k=v', env)).toThrow(/origin だけ/);
  });

  it('URL でない値・http(s) 以外は断る', () => {
    expect(() => resolvePullUrl('not a url', env)).toThrow(/URL/);
    expect(() => resolvePullUrl('ftp://x.example.com', env)).toThrow(/http か https/);
  });
});
