import {
  describeUnreadableJournalTimeBoundary,
  normalizeJournalTimeBoundary,
} from '@alteroid/core';
import { JOURNAL_DIAGNOSTICS_TYPES } from '@alteroid/core/journal-diagnostics-format';

import { createClient } from './client.js';
import { describeFailedResponse } from './format.js';
import { resolveTarget } from './target.js';
import { stderr, stdout } from './terminal-out.js';

// 既定に http_timing を入れない: 他の3つより行が大きく、まず見たいのはターンの消費と時間のため
export const DIAGNOSTICS_DEFAULT_TYPES = ['turn_timing', 'turn_usage', 'context_usage'] as const;

const DAY_MS = 86_400_000;
export const DIAGNOSTICS_DEFAULT_WINDOW_MS = DAY_MS;
export const DIAGNOSTICS_MAX_WINDOW_MS = 7 * DAY_MS;

const PAGE_SIZE_DEFAULT = 500;
// `GET /journal` の `limit` の上限（`app-routes-journal.ts` の `journalQuery`）
const PAGE_SIZE_MAX = 1000;

export interface DiagnosticsExportOptions {
  type?: string;
  since?: string;
  until?: string;
  pageSize?: string;
  // 試験が時計を固定するための口。省略すれば現在時刻
  now?: number;
}

type DiagnosticsType = (typeof JOURNAL_DIAGNOSTICS_TYPES)[number];

function isDiagnosticsType(value: string): value is DiagnosticsType {
  return (JOURNAL_DIAGNOSTICS_TYPES as readonly string[]).includes(value);
}

// 許可リストで断る: `exchange` / `external_event` など会話や依頼の本文を持ちうる型を、デーモンが受けるからといって書き出さないため
export function narrowDiagnosticsTypes(raw: string | undefined): DiagnosticsType[] {
  if (raw === undefined) return [...DIAGNOSTICS_DEFAULT_TYPES];
  const requested = [
    ...new Set(
      raw
        .split(',')
        .map((value) => value.trim())
        .filter((value) => value.length > 0),
    ),
  ];
  if (requested.length === 0) {
    throw new Error(`--type が空です（指定できるのは ${JOURNAL_DIAGNOSTICS_TYPES.join(' / ')}）`);
  }
  const refused = requested.filter((value) => !isDiagnosticsType(value));
  if (refused.length > 0) {
    throw new Error(
      `--type に診断の型ではない値が入っています: ${refused.join(', ')}。` +
        'この書き出しは診断の型だけを扱います（会話・依頼・報告・記憶の本文を含みうる型は書き出さない）。' +
        `指定できるのは ${JOURNAL_DIAGNOSTICS_TYPES.join(' / ')} です`,
    );
  }
  return requested.filter(isDiagnosticsType);
}

export function resolveDiagnosticsWindow(
  options: Pick<DiagnosticsExportOptions, 'since' | 'until'>,
  now: number,
): { since: string; until: string } {
  const parse = (flag: 'since' | 'until', value: string): number => {
    const normalized = normalizeJournalTimeBoundary(value);
    if (normalized === null) throw new Error(describeUnreadableJournalTimeBoundary(flag, value));
    return Date.parse(normalized);
  };
  const untilMs =
    options.until === undefined
      ? options.since === undefined
        ? now
        : parse('since', options.since) + DIAGNOSTICS_DEFAULT_WINDOW_MS
      : parse('until', options.until);
  const sinceMs =
    options.since === undefined
      ? untilMs - DIAGNOSTICS_DEFAULT_WINDOW_MS
      : parse('since', options.since);
  if (sinceMs >= untilMs) {
    throw new Error('--since は --until より前にしてください');
  }
  // 黙って切り詰めない: 「全部書き出した」と読める出力が嘘になるため
  if (untilMs - sinceMs > DIAGNOSTICS_MAX_WINDOW_MS) {
    throw new Error(
      `窓が長すぎます（${(untilMs - sinceMs) / DAY_MS} 日。1回の窓は最大 ${DIAGNOSTICS_MAX_WINDOW_MS / DAY_MS} 日）。` +
        '期間を分けて何回かに分けて書き出してください',
    );
  }
  return { since: new Date(sinceMs).toISOString(), until: new Date(untilMs).toISOString() };
}

function resolvePageSize(raw: string | undefined): number {
  if (raw === undefined) return PAGE_SIZE_DEFAULT;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > PAGE_SIZE_MAX) {
    throw new Error(`--page-size は 1〜${PAGE_SIZE_MAX} の整数で指定してください`);
  }
  return value;
}

/**
 * 日誌の診断の行（turn_timing / turn_usage / context_usage / http_timing）を、1行1JSONで標準出力へ書き出す。
 * 既存の `GET /journal` だけを使う（経路は足さない）。頁の進行と総数は標準エラーへ出す。
 *
 * 行は伏せずに素通しする。診断の4つの型の自由文の欄を調べた結果（本文・鍵が載る経路は見つからなかった）は PR 本文にある。
 */
export async function diagnosticsExportCommand(
  options: DiagnosticsExportOptions = {},
): Promise<void> {
  const types = narrowDiagnosticsTypes(options.type);
  const window = resolveDiagnosticsWindow(options, options.now ?? Date.now());
  const pageSize = resolvePageSize(options.pageSize);

  const target = await resolveTarget();
  if (target.note !== null) {
    // 例外にする: 何も書き出さずに 0 で返すと、定期の送信が「済んだ」と読むため。標準出力にも出さない（JSONL に混ざる）
    throw new Error(target.note);
  }
  const client = createClient(target.baseUrl, target.headers);

  const windowText = `${window.since} 〜 ${window.until}`;
  let rows = 0;
  let pages = 0;
  let resetRows = 0;
  let after: { id: string; at: string } | null = null;
  const seenNext = new Set<string>();

  // 途中で落ちたとき、どこまで出したかを必ず言う: 短い出力が「その窓にはそれだけだった」に見えないため
  const stopped = (reason: string): Error =>
    new Error(
      `${reason}（ここまでに ${String(rows)} 行・${String(pages)} 頁を出した。窓 ${windowText}。出力は途中で終わっている）`,
    );

  for (;;) {
    let response;
    try {
      response = await client.journal.$get({
        query: {
          type: types.join(','),
          since: window.since,
          until: window.until,
          order: 'asc',
          limit: String(pageSize),
          ...(after === null ? {} : { afterId: after.id, afterAt: after.at }),
        },
      });
    } catch (error) {
      throw stopped(
        `日誌を読めませんでした（${error instanceof Error ? error.message : String(error)}）`,
      );
    }
    if (!response.ok) {
      throw stopped(
        await describeFailedResponse(
          `日誌を読めませんでした（HTTP ${String(response.status)}）`,
          response,
          target,
        ),
      );
    }
    const page = await response.json();
    pages += 1;

    // 要求した型の外の行は出さずに止める: 相手が型の絞りを守らなかった場合に、本文を持つ型が混ざらないため
    for (const entry of page.entries) {
      if (!isDiagnosticsType(entry.type) || !types.includes(entry.type)) {
        throw stopped(`要求していない型の行が返りました（type=${entry.type}。出さずに止めた）`);
      }
    }
    for (const entry of page.entries) {
      stdout.writeRaw(`${JSON.stringify(entry)}\n`);
    }
    rows += page.entries.length;
    resetRows += page.entries.filter(
      (entry) => entry.type === 'turn_usage' && entry.reset !== undefined,
    ).length;
    stderr.write(
      `頁 ${String(pages)}: ${String(page.entries.length)} 行（累計 ${String(rows)} 行）\n`,
    );

    if (page.next === null) break;
    const key = `${page.next.id}\u0000${page.next.at}`;
    // 同じ継続点が返り続けたら止める: 終わらずに同じ頁を読み続けないため
    if (seenNext.has(key)) {
      throw stopped(`続きの位置が進みません（next が同じ値を返し続けた: id=${page.next.id}）`);
    }
    seenNext.add(key);
    after = page.next;
  }

  stderr.write(
    `書き出し完了: ${String(rows)} 行 / ${String(pages)} 頁 / 窓 ${windowText} / 型 ${types.join(',')} / ` +
      `reset を持つ turn_usage ${String(resetRows)} 行 / 時刻はすべて UTC（台帳の date はサーバのローカル時刻で別の切り方）\n`,
  );
}
