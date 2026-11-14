// 直前の完了した UTC の1日の診断の要約を、別の alteroid（送り先）へ日1回送る（診断を出す側の定期送信）。
// デーモンの中で閉じる: LLM もクローンのターンも使わず、受信箱へも積まない（積むと、消費を調べる仕組みが消費を増やす）。
// 結果は日誌の `diagnostics_summary_send` に1試行1行で残し、「その日はもう送ったか」「何回試したか」もそこから読む（再起動しても数え直しにならない）。
// 鍵（`ALTEROID_DIAGNOSTICS_SINK_KEY`）の値は、日誌・標準出力・標準エラー・エラー文・送る要約のどこにも出さない。
import {
  DIAGNOSTICS_SINK_KEY_ENV,
  DIAGNOSTICS_SUMMARY_MAX_BYTES,
  buildDiagnosticsSummary,
  DiagnosticsSummarySecretError,
  ledgerDateTimeZoneFromName,
  ledgerTimeZone,
  parseJournalJsonl,
  placedEnvValue,
  reasonOf,
  writeStderrLine,
  type DiagnosticsSendOutcome,
  type DiagnosticsSendReason,
  type DiagnosticsSummary,
  type JournalCursor,
  type JournalStore,
  type Stores,
} from '@alteroid/core';

import { startPeriodicRun, type PeriodicRun } from './periodic-runner.js';

export const DIAGNOSTICS_SINK_URL_ENV = 'ALTEROID_DIAGNOSTICS_SINK_URL';
export { DIAGNOSTICS_SINK_KEY_ENV };

export const DIAGNOSTICS_SEND_INTERVAL_MS = 60 * 60 * 1000;
export const DIAGNOSTICS_SEND_TIMEOUT_MS = 30_000;
// 1日あたりの試行の上限。試行ごとに1行残るので、失敗の連発が日誌を埋めない（打ち切った後は翌日の分へ）
export const DIAGNOSTICS_SEND_MAX_ATTEMPTS_PER_DAY = 6;
// 日誌の読みの上限（#1283: 上限なしの読みでヒープを使い切って落ちた）。行数と、行を文字列にした総量の両方で締める。超えたら黙って切らず、送らずに too_many_rows で残す
export const DIAGNOSTICS_SEND_MAX_ROWS = 20_000;
export const DIAGNOSTICS_SEND_MAX_ROW_CHARS = 48 * 1024 * 1024;
const JOURNAL_PAGE_SIZE = 200;
// 送信結果の行を読む上限（1日 6 行が上限なので、これを超えるのは異常）
const SEND_ROWS_SCAN_CAP = 500;
const RESPONSE_BODY_MAX_CHARS = 64 * 1024;
const RETRY_AFTER_MAX_MS = 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const DIAGNOSTICS_ROW_TYPES = ['turn_timing', 'turn_usage', 'context_usage'] as const;
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '[::1]']);

export type SinkConfig =
  | { state: 'disabled' }
  | { state: 'partial'; missing: 'url' | 'key' }
  | { state: 'not_configured'; why: string }
  | { state: 'enabled'; endpoint: string; host: string; key: string };

/**
 * 2つの環境変数から送り先を決める。両方が揃い、URL が origin だけ（https、または loopback の http）のときだけ有効。
 * 理由の文に URL・鍵の値は入れない（URL に認証情報が入っていることがあるため）。
 */
export function readDiagnosticsSinkConfig(env: NodeJS.ProcessEnv): SinkConfig {
  const rawUrl = placedEnvValue(env, DIAGNOSTICS_SINK_URL_ENV);
  const key = placedEnvValue(env, DIAGNOSTICS_SINK_KEY_ENV);
  if (rawUrl === null && key === null) return { state: 'disabled' };
  if (rawUrl === null) return { state: 'partial', missing: 'url' };
  if (key === null) return { state: 'partial', missing: 'key' };
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { state: 'not_configured', why: 'URL として読めない' };
  }
  if (url.username !== '' || url.password !== '') {
    return { state: 'not_configured', why: 'URL に認証情報が入っている（origin だけを置く）' };
  }
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '' || /[?#]/.test(rawUrl)) {
    return {
      state: 'not_configured',
      why: 'URL にパス・クエリ・フラグメントが入っている（origin だけを置く）',
    };
  }
  const loopbackHttp = url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname);
  if (url.protocol !== 'https:' && !loopbackHttp) {
    return {
      state: 'not_configured',
      why: 'https でない（鍵を平文で外へ出さないため、http は loopback だけ許す）',
    };
  }
  return { state: 'enabled', endpoint: `${url.origin}/mcp`, host: url.host, key };
}

/** 起動時の1行（値は出さない）。無効（両方無い）のときは言うことが無いので `undefined` */
export function describeDiagnosticsSinkConfig(config: SinkConfig): string | undefined {
  switch (config.state) {
    case 'disabled':
      return undefined;
    case 'partial':
      return (
        `alteroidd: 診断の要約の定期送信は動かない（${config.missing === 'url' ? DIAGNOSTICS_SINK_URL_ENV : DIAGNOSTICS_SINK_KEY_ENV} が無い。` +
        `${DIAGNOSTICS_SINK_URL_ENV} と ${DIAGNOSTICS_SINK_KEY_ENV} は両方そろったときだけ動く）\n`
      );
    case 'not_configured':
      return `alteroidd: 診断の要約の定期送信は動かない（${DIAGNOSTICS_SINK_URL_ENV}: ${config.why}）\n`;
    case 'enabled':
      return `alteroidd: 診断の要約の定期送信を有効にした（送り先 ${config.host}。日1回、直前の完了した UTC の1日ぶん。結果は日誌の diagnostics_summary_send）\n`;
  }
}

export interface SendPeriod {
  start: string;
  end: string;
}

/** `now` の直前の完了した UTC の1日 `[D 00:00Z, D+1 00:00Z)` */
export function previousCompletedUtcDay(now: Date): SendPeriod {
  const endMs = Math.floor(now.getTime() / DAY_MS) * DAY_MS;
  return { start: new Date(endMs - DAY_MS).toISOString(), end: new Date(endMs).toISOString() };
}

export type SendRunResult =
  | { kind: 'idle'; why: 'already_done' | 'attempts_exhausted' | 'paused' | 'unreadable' }
  | { kind: 'recorded'; outcome: DiagnosticsSendOutcome; attempt: number };

type SinkDispatch =
  | { kind: 'outcome'; outcome: 'sent' | 'duplicate'; httpStatus?: number }
  | {
      kind: 'outcome';
      outcome: 'rejected' | 'failed';
      reason: DiagnosticsSendReason;
      httpStatus?: number;
      retryAfterMs?: number;
    };

export interface DiagnosticsSenderDeps {
  config: Extract<SinkConfig, { state: 'enabled' }>;
  journal: Pick<JournalStore, 'listPage' | 'append'>;
  usage: Pick<Stores['usage'], 'aggregate'>;
  now: () => Date;
  fetch: typeof fetch;
  /** 秘密の照合に使う（鍵の値が要約へ紛れていないかを見る）。既定は `process.env` */
  env?: NodeJS.ProcessEnv;
  resolveTimeZone?: () => string | undefined;
  writeLine?: (line: string) => void;
  /** 差し替え口（試験用）。生成側にバグがあっても送る直前の二重の確認が効くことを試すため */
  build?: typeof buildDiagnosticsSummary;
  /** 差し替え口（試験用）。日誌を読む行数の上限 */
  maxRows?: number;
}

export interface DiagnosticsSender {
  /** 1周期ぶん。直前の完了日が済んでいなければ1回送る（投げない） */
  runOnce(): Promise<SendRunResult>;
}

type RowsRead =
  | { kind: 'ok'; jsonl: string }
  | { kind: 'too_many_rows' }
  | { kind: 'read_failed' };

async function readDiagnosticsRows(
  journal: Pick<JournalStore, 'listPage'>,
  period: SendPeriod,
  maxRows: number,
): Promise<RowsRead> {
  // `until` は閉区間なので、窓の終わり（次の日の 00:00Z）を含めないよう 1ms 引く
  const until = new Date(Date.parse(period.end) - 1).toISOString();
  const lines: string[] = [];
  let chars = 0;
  let after: JournalCursor | undefined;
  try {
    for (;;) {
      const page = await journal.listPage({
        types: [...DIAGNOSTICS_ROW_TYPES],
        since: period.start,
        until,
        limit: JOURNAL_PAGE_SIZE,
        ...(after === undefined ? {} : { after }),
      });
      for (const entry of page.entries) {
        const line = JSON.stringify(entry);
        chars += line.length;
        lines.push(line);
        if (lines.length > maxRows || chars > DIAGNOSTICS_SEND_MAX_ROW_CHARS) {
          return { kind: 'too_many_rows' };
        }
      }
      if (page.next === null) return { kind: 'ok', jsonl: lines.join('\n') };
      after = page.next;
    }
  } catch {
    return { kind: 'read_failed' };
  }
}

interface PriorAttempts {
  attempts: number;
  done: boolean;
}

async function readPriorAttempts(
  journal: Pick<JournalStore, 'listPage'>,
  period: SendPeriod,
): Promise<PriorAttempts | null> {
  let attempts = 0;
  let done = false;
  let scanned = 0;
  let after: JournalCursor | undefined;
  try {
    for (;;) {
      const page = await journal.listPage({
        types: ['diagnostics_summary_send'],
        // 送信の行は期間の終わり以降にしか書かれない（完了した日だけを送る）
        since: period.end,
        limit: JOURNAL_PAGE_SIZE,
        ...(after === undefined ? {} : { after }),
      });
      for (const entry of page.entries) {
        scanned += 1;
        if (entry.type !== 'diagnostics_summary_send') continue;
        if (entry.period.start !== period.start || entry.period.end !== period.end) continue;
        attempts += 1;
        if (
          entry.outcome === 'sent' ||
          entry.outcome === 'duplicate' ||
          // 診断の行が1行も無い日は、何度試しても同じ（空の要約は送る意味が無い）
          (entry.outcome === 'not_generated' && entry.reason === 'no_diagnostics')
        ) {
          done = true;
        }
      }
      if (page.next === null || scanned >= SEND_ROWS_SCAN_CAP) return { attempts, done };
      after = page.next;
    }
  } catch {
    return null;
  }
}

async function readBoundedText(response: Response): Promise<string | null> {
  const body = response.body;
  if (body === null) return '';
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return text + decoder.decode();
      text += decoder.decode(value, { stream: true });
      if (text.length > RESPONSE_BODY_MAX_CHARS) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
    }
  } catch {
    return null;
  }
}

function parseRetryAfterMs(header: string | null, nowMs: number): number | undefined {
  if (header === null) return undefined;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) return Math.min(Number(trimmed) * 1000, RETRY_AFTER_MAX_MS);
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return undefined;
  return Math.min(Math.max(at - nowMs, 0), RETRY_AFTER_MAX_MS);
}

function classifyHttpStatus(status: number): DiagnosticsSendReason {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 413) return 'payload_too_large';
  if (status === 429) return 'rate_limited';
  return 'http_4xx';
}

/** 受け手の応答（HTTP 200 の JSON-RPC）を分類する。受け手のメッセージは読まない・残さない */
function classifyRpcBody(text: string): SinkDispatch {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: 'outcome', outcome: 'failed', reason: 'unexpected_response' };
  }
  const rpc = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  if (typeof rpc['error'] === 'object' && rpc['error'] !== null) {
    return { kind: 'outcome', outcome: 'rejected', reason: 'receiver_rejected' };
  }
  const result =
    typeof rpc['result'] === 'object' && rpc['result'] !== null
      ? (rpc['result'] as Record<string, unknown>)
      : undefined;
  if (result === undefined) {
    return { kind: 'outcome', outcome: 'failed', reason: 'unexpected_response' };
  }
  if (result['isError'] === true) {
    return { kind: 'outcome', outcome: 'rejected', reason: 'receiver_rejected' };
  }
  const structured = result['structuredContent'];
  const duplicate =
    typeof structured === 'object' && structured !== null
      ? (structured as Record<string, unknown>)['duplicate']
      : undefined;
  const ok =
    typeof structured === 'object' && structured !== null
      ? (structured as Record<string, unknown>)['ok']
      : undefined;
  if (ok !== true || typeof duplicate !== 'boolean') {
    return { kind: 'outcome', outcome: 'failed', reason: 'unexpected_response' };
  }
  return { kind: 'outcome', outcome: duplicate ? 'duplicate' : 'sent' };
}

export function createDiagnosticsSender(deps: DiagnosticsSenderDeps): DiagnosticsSender {
  const { config, journal, usage } = deps;
  const env = deps.env ?? process.env;
  const writeLine = deps.writeLine ?? writeStderrLine;
  let pausedUntilMs = 0;

  async function record(
    period: SendPeriod,
    attempt: number,
    outcome: DiagnosticsSendOutcome,
    extra: { reason?: DiagnosticsSendReason; httpStatus?: number },
  ): Promise<void> {
    try {
      await journal.append({
        type: 'diagnostics_summary_send',
        period,
        outcome,
        attempt,
        ...(extra.httpStatus === undefined ? {} : { httpStatus: extra.httpStatus }),
        ...(extra.reason === undefined ? {} : { reason: extra.reason }),
        sinkHost: config.host,
      });
    } catch (error) {
      // 例外の文面は値を抱えうるので `reasonOf`（既存の落とし方）を通した短い理由だけ。鍵は載せない
      writeLine(
        `alteroidd: 診断の要約の送信結果を日誌へ残せませんでした（${outcome}）: ${redact(reasonOf(error))}\n`,
      );
    }
  }

  function redact(text: string): string {
    return text.split(config.key).join('[redacted]');
  }

  async function buildSummary(
    period: SendPeriod,
    jsonl: string,
    now: Date,
  ): Promise<
    | { kind: 'ok'; summary: DiagnosticsSummary; body: string }
    | { kind: 'not_generated'; reason: DiagnosticsSendReason }
  > {
    // 台帳は `GET /usage` と同じ集計（`stores.usage.aggregate`）。範囲は「サーバの TZ の暦日」で、窓が UTC の1日であることとのずれは ledgerDateTimeZone に残る。
    const date = period.start.slice(0, 10);
    let usageJson: unknown;
    let zoneName: string | null = null;
    try {
      const aggregate = await usage.aggregate({ from: date, to: date });
      zoneName = ledgerTimeZone(now, deps.resolveTimeZone);
      usageJson = { ...aggregate, ledgerDateTimeZone: ledgerDateTimeZoneFromName(zoneName) };
    } catch {
      // 台帳が読めなくても日誌ぶんは送れる（台帳は従。取れないことは要約に「台帳なし」として残る）
      usageJson = undefined;
    }
    let summary: DiagnosticsSummary;
    try {
      summary = (deps.build ?? buildDiagnosticsSummary)(
        { journal: parseJournalJsonl(jsonl), usage: usageJson },
        { now, env, ...(zoneName === null ? {} : { ledgerTz: zoneName }) },
      );
    } catch (error) {
      if (error instanceof DiagnosticsSummarySecretError) {
        return { kind: 'not_generated', reason: 'secret_pattern' };
      }
      if (error instanceof Error && error.name === 'ZodError') {
        return { kind: 'not_generated', reason: 'schema_invalid' };
      }
      return { kind: 'not_generated', reason: 'build_failed' };
    }
    if (summary.period === null) return { kind: 'not_generated', reason: 'no_diagnostics' };
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'report_diagnostics_summary', arguments: { summary } },
    });
    // 二重の確認: 生成側（16 KiB 制限・秘密走査）にバグがあっても、送る直前にもう一度見る
    if (Buffer.byteLength(JSON.stringify(summary), 'utf8') > DIAGNOSTICS_SUMMARY_MAX_BYTES) {
      return { kind: 'not_generated', reason: 'oversize' };
    }
    if (body.includes(config.key)) return { kind: 'not_generated', reason: 'secret_pattern' };
    return { kind: 'ok', summary, body };
  }

  async function dispatch(body: string, nowMs: number): Promise<SinkDispatch> {
    let response: Response;
    try {
      response = await deps.fetch(config.endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${config.key}`,
          accept: 'application/json, text/event-stream',
          'content-type': 'application/json',
        },
        body,
        // リダイレクトを辿らない: 鍵を別の宛先へ送らないため
        redirect: 'error',
        signal: AbortSignal.timeout(DIAGNOSTICS_SEND_TIMEOUT_MS),
      });
    } catch (error) {
      const timedOut =
        error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
      return {
        kind: 'outcome',
        outcome: 'failed',
        reason: timedOut ? 'timeout' : 'network',
      };
    }
    const httpStatus = response.status;
    if (httpStatus >= 500) {
      await response.body?.cancel().catch(() => undefined);
      return { kind: 'outcome', outcome: 'failed', reason: 'http_5xx', httpStatus };
    }
    if (httpStatus < 200 || (httpStatus >= 300 && httpStatus < 400)) {
      // 辿らないので 3xx は `redirect: 'error'` で例外になり、ここへは来ない。来たら知らない応答として扱う
      await response.body?.cancel().catch(() => undefined);
      return { kind: 'outcome', outcome: 'failed', reason: 'unexpected_response', httpStatus };
    }
    if (httpStatus >= 400) {
      await response.body?.cancel().catch(() => undefined);
      const retryAfterMs =
        httpStatus === 429 ? parseRetryAfterMs(response.headers.get('retry-after'), nowMs) : undefined;
      return {
        kind: 'outcome',
        outcome: 'rejected',
        reason: classifyHttpStatus(httpStatus),
        httpStatus,
        ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      };
    }
    const text = await readBoundedText(response);
    if (text === null) {
      return { kind: 'outcome', outcome: 'failed', reason: 'unexpected_response', httpStatus };
    }
    return { ...classifyRpcBody(text), httpStatus };
  }

  async function runOnce(): Promise<SendRunResult> {
    const now = deps.now();
    if (now.getTime() < pausedUntilMs) return { kind: 'idle', why: 'paused' };
    const period = previousCompletedUtcDay(now);
    const prior = await readPriorAttempts(journal, period);
    // 済みかどうかが読めないときは送らない（読めないまま送ると、済みの日に重ねて送りうる）
    if (prior === null) return { kind: 'idle', why: 'unreadable' };
    if (prior.done) return { kind: 'idle', why: 'already_done' };
    if (prior.attempts >= DIAGNOSTICS_SEND_MAX_ATTEMPTS_PER_DAY) {
      return { kind: 'idle', why: 'attempts_exhausted' };
    }
    const attempt = prior.attempts + 1;

    const rows = await readDiagnosticsRows(
      journal,
      period,
      deps.maxRows ?? DIAGNOSTICS_SEND_MAX_ROWS,
    );
    if (rows.kind !== 'ok') {
      const reason = rows.kind === 'too_many_rows' ? 'too_many_rows' : 'read_failed';
      await record(period, attempt, 'failed', { reason });
      return { kind: 'recorded', outcome: 'failed', attempt };
    }

    const built = await buildSummary(period, rows.jsonl, now);
    if (built.kind === 'not_generated') {
      await record(period, attempt, 'not_generated', { reason: built.reason });
      return { kind: 'recorded', outcome: 'not_generated', attempt };
    }

    const sent = await dispatch(built.body, now.getTime());
    if (sent.outcome === 'sent' || sent.outcome === 'duplicate') {
      await record(period, attempt, sent.outcome, {
        ...(sent.httpStatus === undefined ? {} : { httpStatus: sent.httpStatus }),
      });
    } else {
      if (sent.retryAfterMs !== undefined) pausedUntilMs = now.getTime() + sent.retryAfterMs;
      await record(period, attempt, sent.outcome, {
        reason: sent.reason,
        ...(sent.httpStatus === undefined ? {} : { httpStatus: sent.httpStatus }),
      });
    }
    return { kind: 'recorded', outcome: sent.outcome, attempt };
  }

  return {
    async runOnce() {
      try {
        return await runOnce();
      } catch (error) {
        // 周期処理を止めない・鍵を出さない
        writeLine(`alteroidd: 診断の要約の送信の回が失敗しました: ${redact(reasonOf(error))}\n`);
        return { kind: 'idle', why: 'unreadable' };
      }
    },
  };
}

export interface StartDiagnosticsSendingOptions {
  env: NodeJS.ProcessEnv;
  stores: Pick<Stores, 'journal' | 'usage'>;
  fetch?: typeof fetch;
  now?: () => Date;
  intervalMs?: number;
  signal?: AbortSignal;
  writeLine?: (line: string) => void;
}

/**
 * 起動時に1回、以後 `intervalMs`（既定1時間）ごとに「直前の完了日の送信が済んでいるか」を日誌で見て、済んでいなければ送る。
 * 設定が揃っていなければ何も読まず何も書かない（`undefined`）。
 */
export function startDiagnosticsSummarySending(
  options: StartDiagnosticsSendingOptions,
): PeriodicRun<SendRunResult> | undefined {
  const writeLine = options.writeLine ?? writeStderrLine;
  const config = readDiagnosticsSinkConfig(options.env);
  const line = describeDiagnosticsSinkConfig(config);
  if (line !== undefined) writeLine(line);
  if (config.state !== 'enabled') return undefined;
  const sender = createDiagnosticsSender({
    config,
    journal: options.stores.journal,
    usage: options.stores.usage,
    now: options.now ?? (() => new Date()),
    fetch: options.fetch ?? fetch,
    env: options.env,
    ...(options.writeLine === undefined ? {} : { writeLine: options.writeLine }),
  });
  return startPeriodicRun({
    intervalMs: options.intervalMs ?? DIAGNOSTICS_SEND_INTERVAL_MS,
    signal: options.signal,
    run: () => sender.runOnce(),
  });
}
