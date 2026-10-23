import { collapseErrorCause, writeStderrLine } from '@alteroid/core';
import { sql } from 'drizzle-orm';

import type { Db } from './db.js';
import {
  ensureJournalConversationSeqIndex,
  ensureJournalHumanExchangeSeqIndex,
  ensureJournalHumanRepliesIndex,
  ensureJournalWithdrawalsIndex,
  JOURNAL_CONVERSATION_SEQ_INDEX,
  JOURNAL_HUMAN_EXCHANGE_SEQ_INDEX,
  JOURNAL_HUMAN_REPLIES_INDEX,
  JOURNAL_WITHDRAWALS_INDEX,
} from './migrate.js';

/**
 * 起動の後に書き込みを止めずに作る索引の、1本ぶんの結果。
 * - `valid`: 確かめた時点で既に在って有効だった
 * - `built`: 作って、作り終えた後に有効と確かめた
 * - `failed`: 作れなかった・作った後も有効と確かめられなかった（`reason` に理由）
 */
export interface DeferredIndexOutcome {
  index: string;
  state: 'valid' | 'built' | 'failed';
  /** 確かめ始めてから結果が決まるまでの時間（ms） */
  ms: number;
  reason?: string;
}

/**
 * 起動の後に作る索引の並び。1本ずつ作る: 並べると同じ日誌を2本の走査が同時に読み、器の I/O を一度に食うため。
 * 会話の一覧の窓の索引を先に作る: 人の待ちに直に効くのはこれで、既に在る索引の確かめは一瞬で済むため
 */
const DEFERRED_INDEXES: readonly {
  name: string;
  ensure: (db: Db, warn: (line: string) => void) => Promise<void>;
}[] = [
  { name: JOURNAL_HUMAN_EXCHANGE_SEQ_INDEX, ensure: ensureJournalHumanExchangeSeqIndex },
  { name: JOURNAL_HUMAN_REPLIES_INDEX, ensure: ensureJournalHumanRepliesIndex },
  { name: JOURNAL_WITHDRAWALS_INDEX, ensure: ensureJournalWithdrawalsIndex },
  { name: JOURNAL_CONVERSATION_SEQ_INDEX, ensure: ensureJournalConversationSeqIndex },
];

/** 起動の後に作る索引の名前（並びは作る順） */
export const DEFERRED_INDEX_NAMES: readonly string[] = DEFERRED_INDEXES.map((entry) => entry.name);

function rowsOf(result: unknown): unknown[] {
  return Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? []);
}

/** 有効なら `true`、無い・無効なら `false`、読めなければ `undefined`（分からないものを「有効」にも「無い」にも倒さない） */
async function indexValid(db: Db, name: string): Promise<boolean | undefined> {
  try {
    const result = await db.execute(
      sql`select i.indisvalid as valid from pg_class c join pg_index i on i.indexrelid = c.oid where c.relname = ${name}`,
    );
    const found = rowsOf(result)[0] as { valid?: boolean } | undefined;
    return found?.valid === true;
  } catch {
    return undefined;
  }
}

/**
 * 起動の後に作る索引を1本ずつ作り、索引ごとの結果を返す。投げない（作れなくても遅いだけで、正しさは変わらないため）。
 * 結果を返す: 作れたときは何も出さない作りだと、索引が本当に在って有効かを、本番の DB を見ずに確かめる手が無かったため。
 * 呼び手（デーモン）はこれを日誌へ残す。
 */
export async function buildDeferredIndexes(
  db: Db,
  options: { now?: () => number; warn?: (line: string) => void } = {},
): Promise<DeferredIndexOutcome[]> {
  const now = options.now ?? (() => performance.now());
  const warn = options.warn ?? ((line: string) => writeStderrLine(line));
  const outcomes: DeferredIndexOutcome[] = [];
  for (const { name, ensure } of DEFERRED_INDEXES) {
    const started = now();
    if ((await indexValid(db, name)) === true) {
      outcomes.push({ index: name, state: 'valid', ms: Math.round(now() - started) });
      continue;
    }
    let warned: string | undefined;
    await ensure(db, (line) => {
      warned = line.trim();
      warn(line);
    });
    const valid = await indexValid(db, name);
    const ms = Math.round(now() - started);
    if (valid === true) {
      outcomes.push({ index: name, state: 'built', ms });
    } else {
      outcomes.push({
        index: name,
        state: 'failed',
        ms,
        reason:
          warned ??
          (valid === undefined
            ? '作った後に有効かを読めなかった'
            : '作った後も有効になっていない（作りかけ・無効のまま）'),
      });
    }
  }
  return outcomes;
}

/** 索引を作る接続そのものを開けなかったときの結果（全部 `failed`） */
export function deferredIndexesUnreachable(error: unknown): DeferredIndexOutcome[] {
  const reason = `索引を作る接続を開けなかった: ${collapseErrorCause(error)}`;
  return DEFERRED_INDEX_NAMES.map((index) => ({ index, state: 'failed', ms: 0, reason }));
}
