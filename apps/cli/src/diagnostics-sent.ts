import {
  describeUnreadableJournalTimeBoundary,
  normalizeJournalTimeBoundary,
} from '@alteroid/core';

import { createClient } from './client.js';
import { describeFailedResponse } from './format.js';
import { resolveTarget } from './target.js';
import { stdout } from './terminal-out.js';

// `GET /journal?type=diagnostics_summary_send` だけを使う（経路は足さない）。このデーモンが別の alteroid へ診断の要約を送った試みの結果（デーモンの定期送信が1試行1行で残す）を読む。
// 送信が有効かどうかは、デーモンの起動時の1行ログと、ここに直近の行が在るかで分かる。

const LIST_LIMIT_DEFAULT = 20;
const LIST_LIMIT_MAX = 200;
const PAGE_SIZE = 100;
// 絞りに当たらない行を読み続けて終わらなくならないよう、読む頁数に蓋をする。蓋に当たったら黙らずに言う
const MAX_PAGES = 20;

export interface DiagnosticsSentOptions {
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

interface SentEntry {
  id: string;
  at: string;
  period: { start: string; end: string };
  outcome: string;
  attempt: number;
  httpStatus?: number | undefined;
  reason?: string | undefined;
  sinkHost: string;
}

/** 送信の結果を新しい順に1件1行で並べる（日時・period・outcome・attempt・reason） */
export async function diagnosticsSentCommand(options: DiagnosticsSentOptions = {}): Promise<void> {
  const limit = resolveLimit(options.limit);
  const since = boundary('since', options.since);
  const until = boundary('until', options.until);
  const target = await resolveTarget();
  if (target.note !== null) throw new Error(target.note);
  const client = createClient(target.baseUrl, target.headers);

  const found: SentEntry[] = [];
  let after: { id: string; at: string } | null = null;
  let pages = 0;
  let exhausted = false;
  while (found.length < limit && pages < MAX_PAGES) {
    const response = await client.journal.$get({
      query: {
        type: 'diagnostics_summary_send',
        limit: String(Math.min(PAGE_SIZE, limit - found.length)),
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
      if (entry.type !== 'diagnostics_summary_send') {
        throw new Error(`要求していない型の行が返りました（type=${entry.type}）`);
      }
      found.push(entry);
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
          period: entry.period,
          outcome: entry.outcome,
          attempt: entry.attempt,
          httpStatus: entry.httpStatus ?? null,
          reason: entry.reason ?? null,
          sinkHost: entry.sinkHost,
        })),
        complete: exhausted || found.length >= limit,
      })}\n`,
    );
    return;
  }
  if (found.length === 0) {
    stdout.write(
      exhausted
        ? '診断の要約の送信の記録は無い（送り先が設定されていないか、まだ送っていない。有効かはデーモンの起動時のログで分かる）\n'
        : `診断の要約の送信の記録は見つからなかった（${String(pages)} 頁まで読んで打ち切った。--since で窓を狭める）\n`,
    );
    return;
  }
  for (const entry of found) {
    stdout.write(
      `${entry.at}  ${entry.period.start} 〜 ${entry.period.end}  ${entry.outcome}  attempt=${String(entry.attempt)}` +
        `${entry.reason === undefined ? '' : `  reason=${entry.reason}`}` +
        `${entry.httpStatus === undefined ? '' : `  http=${String(entry.httpStatus)}`}  → ${entry.sinkHost}\n`,
    );
  }
  if (!exhausted && found.length >= limit) {
    stdout.write(
      `（--limit ${String(limit)} で打ち切った。続きは --until ${found.at(-1)?.at ?? ''}）\n`,
    );
  }
}
