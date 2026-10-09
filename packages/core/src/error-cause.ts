/**
 * `Error.prototype.cause` の連鎖を、stderr の跡にもクローンへ返す本文にも安全に載せられる1行へ畳む。
 *
 * 1行目だけを取る: `DrizzleQueryError` の `message` は2行目に `params: <束縛パラメータ>` として
 * insert しようとした行の値を並べるため。
 *
 * 構造化フィールドは `code` / `constraint` / `table` / `schema` / `column` / `routine` /
 * `severity` の7つだけを拾う。`detail` / `hint` / `where` / `internalQuery` / `query` は拾わない:
 * 一意制約違反の `detail` が `Key (id)=(挿入しようとした値) already exists.` と行の値を転記するなど、
 * 値を含みうるため。要る欄を足す前に、同じ基準で値を含まないか検算すること。
 *
 * 各段の message は、1行目を取る前に `redactErrorText` を通す: 「1行目だけ」はドライバの改行の位置に
 * 頼った守りで保証ではなく、200字の境界で割れたトークンの断片は伏せ字に合わなくなって残るため。
 * 段ごとに通すのは、段の境界（` <- `）をまたぐ規則の誤作動を避けるため。
 */

import { redactErrorText } from './denial-input-head.js';
import { codePointBoundary } from './excerpt.js';

const REDACT_INPUT_LIMIT = 8192;

/** 1段目は `reasonOf` の既存の上限と同じ値にして、`.cause` を持たない error の出力を変えない。 */
const HEAD_LIMIT = 200;

const CHAIN_LEVEL_LIMIT = 120;

const FIELD_LIMIT = 64;

const MAX_LEVELS = 4;

const STRUCTURED_KEYS = [
  'code',
  'constraint',
  'table',
  'schema',
  'column',
  'routine',
  'severity',
] as const;

export function collapseErrorCause(error: unknown): string {
  const levels: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  for (let depth = 0; depth < MAX_LEVELS; depth += 1) {
    if (current === null || current === undefined) break;
    if (seen.has(current)) {
      levels.push('(循環する cause を検出したためここで打ち切り)');
      break;
    }
    seen.add(current);
    levels.push(levelText(current, depth === 0 ? HEAD_LIMIT : CHAIN_LEVEL_LIMIT));
    if (!(current instanceof Error)) break;
    const next: unknown = current.cause;
    if (next === undefined) break;
    current = next;
  }
  return levels.join(' <- ');
}

function levelText(value: unknown, limit: number): string {
  const head =
    value instanceof Error
      ? clip(safeLine(`${value.name}: ${value.message}`), limit)
      : clip(safeLine(String(value)), limit);
  const fields = structuredFieldsOf(value);
  return fields === '' ? head : `${head} ${fields}`;
}

/** 切るのは伏せ字の後。先に切ると、境界で割れた断片が伏せ字に合わず残る。 */
function safeLine(text: string): string {
  return firstLine(redactErrorText(text.slice(0, REDACT_INPUT_LIMIT), process.env));
}

/** 型で判定しない: `DatabaseError`（`pg`）を import すると `@alteroid/core` が `pg` に依存してしまう。 */
function structuredFieldsOf(value: unknown): string {
  if (typeof value !== 'object' || value === null) return '';
  const record = value as Record<string, unknown>;
  return STRUCTURED_KEYS.flatMap((key) => {
    const raw = record[key];
    return typeof raw === 'string' && raw !== ''
      ? [`${key}=${clip(safeLine(raw), FIELD_LIMIT)}`]
      : [];
  }).join(' ');
}

function firstLine(text: string): string {
  return text.split('\n', 1)[0] ?? '';
}

function clip(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, codePointBoundary(text, limit))}…` : text;
}
