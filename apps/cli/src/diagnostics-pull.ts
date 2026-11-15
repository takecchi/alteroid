import { chmod, mkdir, open, readdir, rename, rm, type FileHandle } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import {
  createSecretRedactor,
  ROTATABLE_CREDENTIAL_KEYS,
  WITHHELD_ENV_KEYS,
  type SecretHit,
  type SecretRedactor,
} from '@alteroid/core';
import { JOURNAL_DIAGNOSTICS_TYPES } from '@alteroid/core/journal-diagnostics-format';
import { writeFileAtomic } from '@alteroid/storage-fs/light';

import {
  narrowDiagnosticsTypes,
  resolveDiagnosticsWindow,
  resolvePageSize,
} from './diagnostics.js';
import { describeFailedResponse } from './format.js';
import { REMOTE_URL_ENV, remoteTarget, type Target } from './target.js';
import { stderr, stdout } from './terminal-out.js';
import { withDiagnosticsFields } from './usage.js';

// 暴走防止。超えたら止めて manifest に残す（黙って切らない）
export const PULL_MAX_ROWS = 200_000;
export const PULL_MAX_BYTES = 256 * 1024 * 1024;

const REQUEST_TIMEOUT_MS = 60_000;
const MEMORY_SLUG_MAX_LENGTH = 128;

export interface DiagnosticsPullOptions {
  url?: string;
  out?: string;
  since?: string;
  until?: string;
  // commander の `--no-memory` / `--no-exchanges`（既定 true）
  memory?: boolean;
  exchanges?: boolean;
  tokenFile?: string;
  pageSize?: string;
  json?: boolean;
  // 試験の口
  now?: number;
  env?: NodeJS.ProcessEnv;
  limits?: { maxRows?: number; maxBytes?: number };
}

interface Failure {
  part: string;
  status: number | null;
  reason: string;
}

interface Truncation {
  part: string;
  reason: 'rows' | 'bytes';
  limit: number;
  rows: number;
  bytes: number;
}

interface RedactionRecord {
  scanned: true;
  hits: SecretHit[];
}

interface FileRecord {
  bytes: number;
  rows?: number;
}

export interface PullManifest {
  version: 1;
  url: string;
  pulledAt: string;
  window: { since: string; until: string };
  usageRange: { from: string; to: string; note: string };
  requested: { memory: boolean; exchanges: boolean };
  redacted: true;
  files: Record<string, FileRecord>;
  failures: Failure[];
  redaction: Record<string, RedactionRecord>;
  skippedNonManager: number | null;
  truncated: Truncation[];
}

// ---- 接続先 ----

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return host === 'localhost' || host === '::1' || /^127(\.\d{1,3}){3}$/.test(host);
}

// 値（資格・クエリ）を持ち込ませない: manifest とエラー文に載せる URL は origin だけにするため。エラー文にも入力の URL を載せない
export function resolvePullUrl(raw: string | undefined, env: NodeJS.ProcessEnv): URL {
  const given = (raw ?? env[REMOTE_URL_ENV] ?? '').trim();
  if (given === '') {
    throw new Error(
      `--url が必要です（向こうの origin。${REMOTE_URL_ENV} でも指定できます）。` +
        '手元のデーモンへは暗黙に繋ぎません',
    );
  }
  let url: URL;
  try {
    url = new URL(given);
  } catch {
    throw new Error('--url が URL として読めません（例: https://alteroid.example.com）');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('--url は http か https の URL にしてください');
  }
  if (url.username !== '' || url.password !== '') {
    throw new Error('--url に資格を含めないでください（--token-file か alteroid login を使う）');
  }
  if ((url.pathname !== '/' && url.pathname !== '') || url.search !== '' || url.hash !== '') {
    throw new Error('--url は origin だけにしてください（パス・クエリ・# は付けない）');
  }
  // 鍵が平文で飛ぶ: loopback 以外の http は断る
  if (url.protocol === 'http:' && !isLoopbackHost(url.hostname)) {
    throw new Error(
      'http は loopback（localhost / 127.x / ::1）にだけ使えます。' +
        'アクセストークンが平文で送られるため、https の URL を指定してください',
    );
  }
  return url;
}

// ---- 出力先 ----

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function utcStamp(now: number): string {
  const d = new Date(now);
  return (
    `${String(d.getUTCFullYear())}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
  );
}

export function defaultOutDir(url: URL, now: number): string {
  const host = url.host.replace(/[^A-Za-z0-9.-]/g, '-');
  return `./diagnostics-pull-${host}-${utcStamp(now)}`;
}

// 上書きしない・--force は作らない: 前回の取得に今回の取得が混ざり、どれがいつの分か分からなくなるため
async function prepareOutDir(path: string): Promise<void> {
  let entries: string[] | null = null;
  try {
    entries = await readdir(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOTDIR') throw new Error(`出力先 ${path} はディレクトリではありません`);
    if (code !== 'ENOENT') {
      throw new Error(
        `出力先 ${path} を確かめられません（${typeof code === 'string' ? code : '原因不明'}）`,
      );
    }
  }
  if (entries !== null && entries.length > 0) {
    throw new Error(
      `出力先 ${path} は空ではありません。上書きしないので、別の --out を指定するか、空にしてください`,
    );
  }
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}

// ---- 伏せ字 ----

function makeRedactorFactory(env: NodeJS.ProcessEnv, target: Target): () => SecretRedactor {
  const bearer = target.headers['authorization'] ?? '';
  const token = bearer.replace(/^Bearer\s+/i, '');
  // 向こうへ送るトークンも走査の対象にする: 応答に写って返ってきても残さないため（名前は env:<名前> で出る。値は出ない）
  const scanEnv: NodeJS.ProcessEnv = {
    ...env,
    ...(token === '' ? {} : { ALTEROID_PULL_ACCESS_TOKEN: token }),
  };
  return () =>
    createSecretRedactor({
      env: scanEnv,
      // 新しい一覧を手書きしない（`GET /self/prompt` が渡すのと同じ core の一覧。AUTH_WITHHELD_ENV_KEYS は daemon の定数で CLI から import できない）
      knownSecretEnvNames: [...WITHHELD_ENV_KEYS, ...ROTATABLE_CREDENTIAL_KEYS],
    });
}

class ScanFailed extends Error {}

// 走査の例外はすべて ScanFailed にする: 走査していない本文を保存しないため
function scanned<T>(run: () => T): T {
  try {
    return run();
  } catch {
    throw new ScanFailed('scan failed');
  }
}

// ---- 取得 ----

type Fetched =
  { ok: true; body: unknown } | { ok: false; failure: { status: number | null; reason: string } };

async function getJson(
  target: Target,
  path: string,
  query: Record<string, string> = {},
): Promise<Fetched> {
  const qs = new URLSearchParams(query).toString();
  let response: Response;
  try {
    response = await fetch(`${target.baseUrl}${path}${qs === '' ? '' : `?${qs}`}`, {
      headers: { ...target.headers, accept: 'application/json' },
      // 別の origin へ資格を連れて行かない
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    const cause = (error as { cause?: { code?: unknown } }).cause;
    const code = typeof cause?.code === 'string' ? cause.code : undefined;
    const name = error instanceof Error ? error.name : 'Error';
    return {
      ok: false,
      failure: { status: null, reason: `通信できませんでした（${code ?? name}）` },
    };
  }
  if (!response.ok) {
    return {
      ok: false,
      failure: {
        status: response.status,
        reason: await describeFailedResponse(`HTTP ${String(response.status)}`, response, target),
      },
    };
  }
  try {
    return { ok: true, body: (await response.json()) as unknown };
  } catch {
    return {
      ok: false,
      failure: { status: response.status, reason: '応答が JSON として読めませんでした' },
    };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface JournalPage {
  entries: unknown[];
  next: { id: string; at: string } | null;
}

function asJournalPage(body: unknown): JournalPage | null {
  if (!isRecord(body) || !Array.isArray(body['entries'])) return null;
  const next = body['next'];
  if (next === null || next === undefined) return { entries: body['entries'], next: null };
  if (isRecord(next) && typeof next['id'] === 'string' && typeof next['at'] === 'string') {
    return { entries: body['entries'], next: { id: next['id'], at: next['at'] } };
  }
  return null;
}

// 頁を `next` が null になるまで追う。`onPage` が false を返したら（上限）止める
async function pageJournal(
  target: Target,
  baseQuery: Record<string, string>,
  onPage: (entries: unknown[]) => Promise<boolean>,
): Promise<{ failure: { status: number | null; reason: string } | null }> {
  let after: { id: string; at: string } | null = null;
  const seenNext = new Set<string>();
  for (;;) {
    const fetched = await getJson(target, '/journal', {
      ...baseQuery,
      ...(after === null ? {} : { afterId: after.id, afterAt: after.at }),
    });
    if (!fetched.ok) return { failure: fetched.failure };
    const page = asJournalPage(fetched.body);
    if (page === null)
      return { failure: { status: 200, reason: '日誌の応答の形が想定と違います' } };
    if (!(await onPage(page.entries))) return { failure: null };
    if (page.next === null) return { failure: null };
    const key = `${page.next.id}\u0000${page.next.at}`;
    // 同じ継続点が返り続けたら止める: 終わらずに同じ頁を読み続けないため
    if (seenNext.has(key)) {
      return {
        failure: { status: 200, reason: '続きの位置が進みません（next が同じ値を返し続けた）' },
      };
    }
    seenNext.add(key);
    after = page.next;
  }
}

// ---- 書き出し ----

// 行を足しながら書く tmp ファイル。最後に rename する（途中で落ちても本名のファイルは半端にならない）
class JsonlSink {
  rows = 0;
  bytes = 0;
  readonly #handle: FileHandle;
  readonly #tmp: string;
  readonly #path: string;

  private constructor(handle: FileHandle, tmp: string, path: string) {
    this.#handle = handle;
    this.#tmp = tmp;
    this.#path = path;
  }

  static async open(path: string): Promise<JsonlSink> {
    const tmp = `${path}.tmp.${String(process.pid)}`;
    return new JsonlSink(await open(tmp, 'w', 0o600), tmp, path);
  }

  async append(lines: string[]): Promise<void> {
    if (lines.length === 0) return;
    const text = lines.join('');
    await this.#handle.write(text);
    this.rows += lines.length;
    this.bytes += Buffer.byteLength(text, 'utf8');
  }

  async commit(): Promise<void> {
    await this.#handle.close();
    await rename(this.#tmp, this.#path);
  }

  async abort(): Promise<void> {
    await this.#handle.close().catch(() => undefined);
    await rm(this.#tmp, { force: true }).catch(() => undefined);
  }
}

interface PullContext {
  target: Target;
  outDir: string;
  newRedactor: () => SecretRedactor;
  manifest: PullManifest;
  limits: { maxRows: number; maxBytes: number };
  pageSize: string;
  window: { since: string; until: string };
}

function fail(ctx: PullContext, part: string, status: number | null, reason: string): void {
  ctx.manifest.failures.push({ part, status, reason });
  stderr.write(`失敗: ${part} — ${reason}\n`);
}

function recordRedaction(ctx: PullContext, name: string, hits: readonly SecretHit[]): void {
  ctx.manifest.redaction[name] = { scanned: true, hits: [...hits] };
  const summary =
    hits.length === 0
      ? '走査済み（当たり 0 件）'
      : hits.map((hit) => `${hit.rule} ${String(hit.count)} 件`).join('、');
  stderr.write(`伏せ字: ${name} — ${summary}\n`);
}

function mergeHits(into: Map<string, number>, hits: readonly SecretHit[]): void {
  for (const hit of hits) into.set(hit.rule, (into.get(hit.rule) ?? 0) + hit.count);
}

function hitsOf(map: Map<string, number>): SecretHit[] {
  return [...map.entries()]
    .map(([rule, count]) => ({ rule, count }))
    .sort((a, b) => a.rule.localeCompare(b.rule));
}

async function writeSmall(ctx: PullContext, name: string, text: string): Promise<void> {
  await writeFileAtomic(join(ctx.outDir, name), text, { mode: 0o600 });
  ctx.manifest.files[name] = { bytes: Buffer.byteLength(text, 'utf8') };
}

const SCAN_FAILED_REASON = '伏せ字の走査に失敗したため、このファイルを書かなかった';

async function pullJsonFile(
  ctx: PullContext,
  part: string,
  file: string,
  path: string,
  query: Record<string, string>,
  shape: (body: unknown) => unknown,
): Promise<void> {
  const fetched = await getJson(ctx.target, path, query);
  if (!fetched.ok) return fail(ctx, part, fetched.failure.status, fetched.failure.reason);
  const body = shape(fetched.body);
  if (body === null) return fail(ctx, part, 200, '応答の形が想定と違います');
  const redactor = ctx.newRedactor();
  let text: string;
  try {
    // 値の文字列だけを置き換えて JSON に戻す: 行全体の文字列へ掛けると、置換が JSON の構造を壊しうるため
    text = `${JSON.stringify(
      scanned(() => redactor.redactDeep(body)),
      null,
      file === 'usage.json' ? 0 : 2,
    )}\n`;
  } catch {
    stderr.write(`伏せ字: ${file} — 走査に失敗したので書かなかった\n`);
    return fail(ctx, part, null, SCAN_FAILED_REASON);
  }
  await writeSmall(ctx, file, text);
  recordRedaction(ctx, file, redactor.hits());
}

// 日誌・会話の行を1行1 JSON で書く。`keep` が false の行は書かずに数だけ返す
async function pullJsonl(
  ctx: PullContext,
  part: string,
  file: string,
  query: Record<string, string>,
  accept: (entry: unknown) => 'keep' | 'skip' | 'invalid',
): Promise<{ skipped: number }> {
  const redactor = ctx.newRedactor();
  const path = join(ctx.outDir, file);
  const state: {
    sink: JsonlSink | null;
    fetchedRows: number;
    skipped: number;
    stop: { status: number | null; reason: string } | null;
  } = { sink: null, fetchedRows: 0, skipped: 0, stop: null };

  const onPage = async (entries: unknown[]): Promise<boolean> => {
    const sink = (state.sink ??= await JsonlSink.open(path));
    const lines: string[] = [];
    let pendingBytes = 0;
    let more = true;
    for (const entry of entries) {
      if (state.fetchedRows >= ctx.limits.maxRows) {
        ctx.manifest.truncated.push({
          part,
          reason: 'rows',
          limit: ctx.limits.maxRows,
          rows: sink.rows + lines.length,
          bytes: sink.bytes + pendingBytes,
        });
        more = false;
        break;
      }
      const verdict = accept(entry);
      if (verdict === 'invalid') {
        state.stop = {
          status: 200,
          reason: '要求していない型・形の行が返りました（その行は書かずに止めた）',
        };
        more = false;
        break;
      }
      state.fetchedRows += 1;
      if (verdict === 'skip') {
        state.skipped += 1;
        continue;
      }
      const line = `${JSON.stringify(scanned(() => redactor.redactDeep(entry)))}\n`;
      const lineBytes = Buffer.byteLength(line, 'utf8');
      if (sink.bytes + pendingBytes + lineBytes > ctx.limits.maxBytes) {
        ctx.manifest.truncated.push({
          part,
          reason: 'bytes',
          limit: ctx.limits.maxBytes,
          rows: sink.rows + lines.length,
          bytes: sink.bytes + pendingBytes,
        });
        more = false;
        break;
      }
      lines.push(line);
      pendingBytes += lineBytes;
    }
    await sink.append(lines);
    return more;
  };

  let result: { failure: { status: number | null; reason: string } | null };
  try {
    result = await pageJournal(ctx.target, query, onPage);
  } catch (error) {
    // 走査が落ちたら、ここまでの分も含めてファイルを残さない
    await state.sink?.abort();
    ctx.manifest.truncated = ctx.manifest.truncated.filter((t) => t.part !== part);
    if (error instanceof ScanFailed) {
      stderr.write(`伏せ字: ${file} — 走査に失敗したので書かなかった\n`);
      fail(ctx, part, null, SCAN_FAILED_REASON);
      return { skipped: state.skipped };
    }
    throw error;
  }
  const opened = state.sink;
  if (opened !== null) {
    await opened.commit();
    ctx.manifest.files[file] = { bytes: opened.bytes, rows: opened.rows };
    recordRedaction(ctx, file, redactor.hits());
  }
  const failure = state.stop ?? result.failure;
  if (failure !== null) {
    fail(
      ctx,
      part,
      failure.status,
      `${failure.reason}（ここまでに ${String(opened?.rows ?? 0)} 行を書いた。出力は途中で終わっている）`,
    );
  }
  const truncated = ctx.manifest.truncated.find((t) => t.part === part);
  if (truncated !== undefined) {
    stderr.write(
      `警告: ${file} は上限（${truncated.reason === 'rows' ? `${String(truncated.limit)} 行` : `${String(truncated.limit)} バイト`}）で止めた。続きは --since / --until で窓を分けて取る\n`,
    );
  }
  return { skipped: state.skipped };
}

// ---- 記憶 ----

// サーバの検証を信用せず、ファイル名にする前に自分でも絞る（パストラバーサル）
export function isSafeMemorySlug(slug: unknown): slug is string {
  return (
    typeof slug === 'string' &&
    slug.length > 0 &&
    slug.length <= MEMORY_SLUG_MAX_LENGTH &&
    /^[a-z0-9._-]+$/.test(slug) &&
    !slug.startsWith('.') &&
    !slug.includes('..')
  );
}

async function pullMemory(ctx: PullContext): Promise<void> {
  const listed = await getJson(ctx.target, '/memory');
  if (!listed.ok) return fail(ctx, 'memory', listed.failure.status, listed.failure.reason);
  const documents =
    isRecord(listed.body) && Array.isArray(listed.body['documents'])
      ? listed.body['documents']
      : null;
  if (documents === null) return fail(ctx, 'memory', 200, '記憶の一覧の形が想定と違います');

  await mkdir(join(ctx.outDir, 'memory'), { recursive: true, mode: 0o700 });
  const bodyHits = new Map<string, number>();
  const index: Record<string, unknown>[] = [];
  let bodiesScanned = 0;

  for (const meta of documents) {
    const metaRecord: Record<string, unknown> = isRecord(meta) ? meta : {};
    const slug = metaRecord['slug'];
    if (!isSafeMemorySlug(slug)) {
      const shown =
        typeof slug === 'string' ? JSON.stringify(slug.slice(0, 40)) : String(typeof slug);
      fail(
        ctx,
        'memory',
        null,
        `slug が安全な文字（a-z 0-9 . _ -）だけではないので書かなかった: ${shown}`,
      );
      index.push({ ...metaRecord, file: null, skipped: 'unsafe-slug' });
      continue;
    }
    const part = `memory/${slug}`;
    const fetched = await getJson(ctx.target, `/memory/${encodeURIComponent(slug)}`);
    if (!fetched.ok) {
      fail(ctx, part, fetched.failure.status, fetched.failure.reason);
      index.push({ ...metaRecord, file: null, skipped: 'fetch-failed' });
      continue;
    }
    const document = isRecord(fetched.body) ? fetched.body['document'] : undefined;
    const content = isRecord(document) ? document['content'] : undefined;
    if (typeof content !== 'string') {
      fail(ctx, part, 200, '記憶の応答の形が想定と違います');
      index.push({ ...metaRecord, file: null, skipped: 'bad-shape' });
      continue;
    }
    const redactor = ctx.newRedactor();
    let text: string;
    try {
      text = scanned(() => redactor.redact(content));
    } catch {
      fail(ctx, part, null, SCAN_FAILED_REASON);
      index.push({ ...metaRecord, file: null, skipped: 'scan-failed' });
      continue;
    }
    await writeSmall(ctx, `memory/${slug}.md`, text);
    bodiesScanned += 1;
    mergeHits(bodyHits, redactor.hits());
    const hits = redactor.hits();
    const version = isRecord(fetched.body) ? fetched.body['version'] : undefined;
    index.push({
      ...metaRecord,
      // 版はサーバの値のまま（伏せた本文から計算し直さない）
      ...(typeof version === 'string' ? { version } : {}),
      file: `${slug}.md`,
      redacted: hits.length > 0,
      redaction: hits,
    });
  }

  if (bodiesScanned > 0 || documents.length === 0)
    recordRedaction(ctx, 'memory/*.md', hitsOf(bodyHits));

  const indexRedactor = ctx.newRedactor();
  try {
    const text = `${JSON.stringify(
      scanned(() => indexRedactor.redactDeep({ documents: index })),
      null,
      2,
    )}\n`;
    await writeSmall(ctx, 'memory/index.json', text);
    recordRedaction(ctx, 'memory/index.json', indexRedactor.hits());
  } catch {
    stderr.write('伏せ字: memory/index.json — 走査に失敗したので書かなかった\n');
    fail(ctx, 'memory/index.json', null, SCAN_FAILED_REASON);
  }
}

// ---- 本体 ----

const USAGE_RANGE_NOTE =
  '台帳は日付（UTC の日付で窓の両端を切った）単位で引く。台帳の date はサーバのローカル時刻で別の切り方のため、窓とは端の日がずれうる';

export async function diagnosticsPullCommand(
  options: DiagnosticsPullOptions = {},
): Promise<PullManifest> {
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now();
  const url = resolvePullUrl(options.url, env);
  // 診断の型は許可リストの全部（既定の3つ + http_timing）。許可リストの外は `narrowDiagnosticsTypes` が断る
  const types = narrowDiagnosticsTypes([...JOURNAL_DIAGNOSTICS_TYPES].join(','));
  const window = resolveDiagnosticsWindow(options, now);
  const pageSize = resolvePageSize(options.pageSize);
  const wantMemory = options.memory !== false;
  const wantExchanges = options.exchanges !== false;

  const target = await remoteTarget(url.origin, {
    env,
    ...(options.tokenFile === undefined ? {} : { tokenFile: options.tokenFile }),
  });
  if (target.note !== null) throw new Error(target.note);

  const outDir = resolve(options.out ?? defaultOutDir(url, now));
  await prepareOutDir(outDir);

  const manifest: PullManifest = {
    version: 1,
    url: url.origin,
    pulledAt: new Date(now).toISOString(),
    window,
    usageRange: {
      from: window.since.slice(0, 10),
      to: window.until.slice(0, 10),
      note: USAGE_RANGE_NOTE,
    },
    requested: { memory: wantMemory, exchanges: wantExchanges },
    redacted: true,
    files: {},
    failures: [],
    redaction: {},
    skippedNonManager: wantExchanges ? 0 : null,
    truncated: [],
  };
  const ctx: PullContext = {
    target,
    outDir,
    newRedactor: makeRedactorFactory(env, target),
    manifest,
    limits: {
      maxRows: options.limits?.maxRows ?? PULL_MAX_ROWS,
      maxBytes: options.limits?.maxBytes ?? PULL_MAX_BYTES,
    },
    pageSize: String(pageSize),
    window,
  };

  stderr.write(`取得: ${url.origin} / 窓 ${window.since} 〜 ${window.until} / 出力 ${outDir}\n`);

  await pullJsonFile(
    ctx,
    'usage',
    'usage.json',
    '/usage',
    { from: manifest.usageRange.from, to: manifest.usageRange.to },
    // `usage --json` と同じ形（resets と台帳の時間帯の明示つき）。`diagnostics analyze --usage` がそのまま読む
    (body) => (isRecord(body) ? withDiagnosticsFields(body) : null),
  );

  await pullJsonl(
    ctx,
    'journal',
    'journal.jsonl',
    {
      type: types.join(','),
      since: window.since,
      until: window.until,
      order: 'asc',
      limit: ctx.pageSize,
    },
    // 要求した型の外の行は書かずに止める: 相手が型の絞りを守らなかった場合に、本文を持つ型が混ざらないため
    (entry) =>
      isRecord(entry) &&
      typeof entry['type'] === 'string' &&
      (types as string[]).includes(entry['type'])
        ? 'keep'
        : 'invalid',
  );

  await pullJsonFile(ctx, 'prompt', 'prompt.json', '/self/prompt', { full: '1' }, (body) =>
    isRecord(body) ? body : null,
  );

  if (wantMemory) await pullMemory(ctx);

  if (wantExchanges) {
    const { skipped } = await pullJsonl(
      ctx,
      'exchanges',
      'exchanges.jsonl',
      {
        type: 'exchange',
        since: window.since,
        until: window.until,
        order: 'asc',
        limit: ctx.pageSize,
      },
      // `GET /journal` は `with` で絞れない: 取ったうえで、人間との会話の行は保存せず数だけ残す
      (entry) => {
        if (!isRecord(entry) || entry['type'] !== 'exchange') return 'invalid';
        return entry['with'] === 'manager' ? 'keep' : 'skip';
      },
    );
    manifest.skippedNonManager = skipped;
  }

  await writeFileAtomic(join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, {
    mode: 0o600,
  });

  if (options.json === true) {
    stdout.writeRaw(`${JSON.stringify(manifest)}\n`);
  } else {
    const names = Object.keys(manifest.files).filter(
      (name) => !name.startsWith('memory/') || name === 'memory/index.json',
    );
    const memoryFiles = Object.keys(manifest.files).filter((name) => name.endsWith('.md')).length;
    stdout.write(
      `取得完了: ${outDir}\n` +
        `  ファイル: ${names.join(', ')}${memoryFiles > 0 ? `, memory/*.md ${String(memoryFiles)} 件` : ''}, manifest.json\n` +
        `  失敗 ${String(manifest.failures.length)} 件 / 上限で止めた ${String(manifest.truncated.length)} 件` +
        `${manifest.skippedNonManager === null ? '' : ` / 人間との会話の行（保存せず）${String(manifest.skippedNonManager)} 行`}\n`,
    );
  }
  // 取れた分は残したうえで 1: 上限での打ち切り（truncated）は失敗ではなく警告
  if (manifest.failures.length > 0) process.exitCode = 1;
  return manifest;
}
