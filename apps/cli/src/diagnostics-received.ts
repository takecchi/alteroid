import {
  compareDiagnosticsSummaries,
  describeDiagnosticsSummaryDigest,
  describeUnreadableJournalTimeBoundary,
  normalizeJournalTimeBoundary,
  readStoredDiagnosticsSummary,
  renderSummaryComparison,
  type ReceivedSummaryRef,
} from '@alteroid/core';

import { createClient } from './client.js';
import { describeFailedResponse } from './format.js';
import { resolveTarget } from './target.js';
import { stdout } from './terminal-out.js';

// `GET /journal?type=diagnostics_summary` と `GET /journal/:id` だけを使う（経路は足さない）。別の alteroid が `report_diagnostics_summary` で送ってきた要約を読む。

const LIST_LIMIT_DEFAULT = 20;
const LIST_LIMIT_MAX = 200;
// 1頁の件数。1件が最大 16 KiB なので、頁を大きくしない
const PAGE_SIZE = 50;
// 絞りに当たらない行を読み続けて終わらなくならないよう、読む頁数に蓋をする。蓋に当たったら黙らずに言う
const MAX_PAGES = 40;

export interface DiagnosticsReceivedListOptions {
  source?: string;
  since?: string;
  until?: string;
  limit?: string;
  json?: boolean;
}

function resolveLimit(raw: string | undefined): number {
  if (raw === undefined) return LIST_LIMIT_DEFAULT;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > LIST_LIMIT_MAX) {
    throw new Error(`--limit は 1〜${LIST_LIMIT_MAX} の整数で指定してください`);
  }
  return value;
}

function boundary(flag: 'since' | 'until', value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = normalizeJournalTimeBoundary(value);
  if (normalized === null) throw new Error(describeUnreadableJournalTimeBoundary(flag, value));
  return normalized;
}

async function connect() {
  const target = await resolveTarget();
  if (target.note !== null) throw new Error(target.note);
  return { target, client: createClient(target.baseUrl, target.headers) };
}

type ReceivedEntry = {
  type: 'diagnostics_summary';
  id: string;
  at: string;
  source: string;
  principalKind: string;
  keyId?: string | undefined;
  payload: Record<string, unknown>;
};

function isReceived(entry: { type: string }): entry is ReceivedEntry {
  return entry.type === 'diagnostics_summary';
}

/** 受け取った要約を新しい順に1件1行で並べる。出す数字は要点だけ（全文は `show`） */
export async function diagnosticsReceivedListCommand(
  options: DiagnosticsReceivedListOptions = {},
): Promise<void> {
  const limit = resolveLimit(options.limit);
  const since = boundary('since', options.since);
  const until = boundary('until', options.until);
  const { target, client } = await connect();

  const found: ReceivedEntry[] = [];
  let after: { id: string; at: string } | null = null;
  let pages = 0;
  let exhausted = false;
  while (found.length < limit && pages < MAX_PAGES) {
    const response = await client.journal.$get({
      query: {
        type: 'diagnostics_summary',
        limit: String(PAGE_SIZE),
        ...(since === undefined ? {} : { since }),
        ...(until === undefined ? {} : { until }),
        ...(after === null ? {} : { afterId: after.id, afterAt: after.at }),
      },
    });
    if (!response.ok) {
      throw new Error(
        await describeFailedResponse(
          `日誌を読めませんでした（HTTP ${String(response.status)}）`,
          response,
          target,
        ),
      );
    }
    const page = await response.json();
    pages += 1;
    for (const entry of page.entries) {
      if (!isReceived(entry)) {
        throw new Error(`要求していない型の行が返りました（type=${entry.type}）`);
      }
      if (options.source !== undefined && entry.source !== options.source) continue;
      if (found.length < limit) found.push(entry);
    }
    if (page.next === null) {
      exhausted = true;
      break;
    }
    after = page.next;
  }

  if (options.json === true) {
    stdout.writeRaw(
      `${JSON.stringify({
        entries: found.map((entry) => ({
          id: entry.id,
          at: entry.at,
          source: entry.source,
          principalKind: entry.principalKind,
          summary: readStoredDiagnosticsSummary(entry.payload),
        })),
        complete: exhausted || found.length >= limit,
      })}\n`,
    );
    return;
  }
  if (found.length === 0) {
    stdout.write(
      exhausted
        ? '受け取った診断の要約は無い（絞りに合う行が無かった）\n'
        : `受け取った診断の要約は見つからなかった（${String(pages)} 頁まで読んで打ち切った。--since で窓を狭める）\n`,
    );
    return;
  }
  for (const entry of found) {
    stdout.write(
      `${entry.at}  ${entry.source}  ${describeDiagnosticsSummaryDigest(entry.payload)}  id=${entry.id}\n`,
    );
  }
  if (!exhausted && found.length >= limit) {
    stdout.write(
      `（--limit ${String(limit)} で打ち切った。続きは --until ${found.at(-1)?.at ?? ''}）\n`,
    );
  } else if (!exhausted) {
    stdout.write(
      `（${String(pages)} 頁まで読んで打ち切った。続きがあるかもしれない。--since で窓を狭める）\n`,
    );
  }
}

async function fetchReceived(
  client: ReturnType<typeof createClient>,
  target: Awaited<ReturnType<typeof resolveTarget>>,
  id: string,
): Promise<ReceivedEntry> {
  const response = await client.journal[':id'].$get({ param: { id } });
  if (!response.ok) {
    if (response.status === 404) {
      throw new Error(`日誌 ${id} は無い（id が違う。\`diagnostics received list\` で見つける）`);
    }
    if (response.status === 409) {
      throw new Error(`日誌 ${id} は在るが読めない形で入っている（消されたのではない）`);
    }
    throw new Error(
      await describeFailedResponse(
        `日誌を読めませんでした（HTTP ${String(response.status)}）`,
        response,
        target,
      ),
    );
  }
  const entry = await response.json();
  if (!isReceived(entry)) {
    throw new Error(`日誌 ${id} は受け取った診断の要約ではない（type=${entry.type}）`);
  }
  return entry;
}

/** 要約の JSON 全文を出す（`--json` は受信の行ごと1行で） */
export async function diagnosticsReceivedShowCommand(
  id: string,
  options: { json?: boolean } = {},
): Promise<void> {
  const { target, client } = await connect();
  const entry = await fetchReceived(client, target, id);
  if (options.json === true) {
    stdout.writeRaw(`${JSON.stringify(entry)}\n`);
    return;
  }
  stdout.writeRaw(`${JSON.stringify(entry.payload, null, 2)}\n`);
}

function toRef(entry: ReceivedEntry): ReceivedSummaryRef {
  const summary = readStoredDiagnosticsSummary(entry.payload);
  if (summary === null) {
    throw new Error(
      `日誌 ${entry.id} の要約は、この版の型では読めない（版が違う。\`show\` で全文を見る）`,
    );
  }
  return { id: entry.id, at: entry.at, source: entry.source, summary };
}

/** 同じ source の2件を並べる。source が違えば断る。結論は出さず、事実の並べだけ */
export async function diagnosticsReceivedCompareCommand(
  idA: string,
  idB: string,
  options: { json?: boolean } = {},
): Promise<void> {
  const { target, client } = await connect();
  const a = toRef(await fetchReceived(client, target, idA));
  const b = toRef(await fetchReceived(client, target, idB));
  const comparison = compareDiagnosticsSummaries(a, b);
  if (options.json === true) {
    stdout.writeRaw(`${JSON.stringify(comparison)}\n`);
    return;
  }
  stdout.write(`${renderSummaryComparison(comparison)}\n`);
}
