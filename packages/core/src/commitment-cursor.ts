import { z } from 'zod';

import type { Commitment } from './schema.js';

// offset という名前を使わない: commitment_list の offset は「何文字目から読むか」という別の単位を持っており、同じ名前に2つの単位を持たせると紛れるため
export interface CommitmentPosition {
  segment: 'open' | 'closed';
  key: string;
  id: string;
}

export function commitmentPosition(
  entry: Pick<Commitment, 'id' | 'at' | 'closedAt'>,
): CommitmentPosition {
  return entry.closedAt === undefined
    ? { segment: 'open', key: entry.at, id: entry.id }
    : { segment: 'closed', key: entry.closedAt, id: entry.id };
}

// apps/daemon の実装を import しない: core は daemon に依存できず、CommitmentStore.list の順序という同じ契約を独立に実装し、ずれたらテストが赤くなるようにしているため
export function compareCommitmentPosition(a: CommitmentPosition, b: CommitmentPosition): number {
  if (a.segment !== b.segment) return a.segment === 'open' ? -1 : 1;
  if (a.segment === 'open') {
    if (a.key !== b.key) return a.key < b.key ? -1 : 1;
  } else {
    if (a.key !== b.key) return a.key > b.key ? -1 : 1;
  }
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
}

const commitmentCursorSchema = z.object({
  segment: z.enum(['open', 'closed']),
  key: z.string().min(1),
  id: z.string().min(1),
  // 錨は刷られた一覧の中でしか意味を持たないので、includeClosed を持つ: 食い違えば MCP 側は 400 を返せないため text で明示のエラーを返す。order / origin / q も同じ理由で持つ
  includeClosed: z.boolean(),
  // `z.enum(['oldest', 'newest']).default('oldest')` にすること。default 無しにすると、order を足す前に発行済みのカーソルが一斉に malformed に化けるため
  order: z.enum(['oldest', 'newest']).default('oldest'),
  // 欄が無い旧いカーソルは「絞っていない」として読む: 絞った呼びで使われたときは必ず mismatch で断られ、黙って別の絞りの続きにはならないため
  origin: z.array(z.string()).optional(),
  // .default('') にしない: undefined と '' は normalizeCommitmentQ が同じ値へ寄せるため、既存の呼び出しに q: '' を書き足させない
  q: z.string().optional(),
});

// 集合として比べる: 絞り込みは並び順を見ないので、順序・重複違いは同じ絞りとして扱う。origin: [] は undefined（絞らない）と区別する
function normalizeCommitmentOrigin(origin: readonly string[] | undefined): string[] | undefined {
  if (origin === undefined) return undefined;
  return [...new Set(origin)].sort();
}

function originsMatch(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  const na = normalizeCommitmentOrigin(a);
  const nb = normalizeCommitmentOrigin(b);
  if (na === undefined || nb === undefined) return na === undefined && nb === undefined;
  if (na.length !== nb.length) return false;
  return na.every((value, index) => value === nb[index]);
}

// 未指定と空文字、大文字小文字の違いを同一視する: 絞り込みは両辺を toLowerCase して部分一致で比べ、空文字はどの文字列にも一致するため
function normalizeCommitmentQ(q: string | undefined): string {
  return (q ?? '').toLowerCase();
}

export type CommitmentCursor = z.infer<typeof commitmentCursorSchema>;

export function encodeCommitmentCursor(cursor: CommitmentCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export type DecodeCommitmentCursorResult = { ok: true; cursor: CommitmentCursor } | { ok: false };

// 実在検査をしない: 比較（keyset）で辿るので、錨が指していた行が別の段へ移っても続きは正しく決まるため
export function decodeCommitmentCursor(raw: string): DecodeCommitmentCursorResult {
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    return { ok: false };
  }
  const parsed = commitmentCursorSchema.safeParse(json);
  if (!parsed.success) return { ok: false };
  return { ok: true, cursor: parsed.data };
}

// entries を並べ替えない: order は比較の向きだけを決め、反転は呼び出し側（ツール層）の仕事で、ストアの契約は変えないため
// 食い違いを黙って先頭からへ倒さない: 辿る方向や絞りが違うまま続きを解決すると、同じ行を繰り返すか間の行を飛ばすため
export function resolveCommitmentCursor(
  entries: readonly Commitment[],
  includeClosed: boolean,
  cursorRaw: string | undefined,
  order: 'oldest' | 'newest' = 'oldest',
  origin?: readonly string[],
  q?: string,
):
  | { kind: 'ok'; view: Commitment[] }
  | { kind: 'malformed' }
  | { kind: 'includeClosed-mismatch'; cursorIncludeClosed: boolean }
  | { kind: 'order-mismatch'; cursorOrder: 'oldest' | 'newest' }
  | { kind: 'origin-mismatch'; cursorOrigin: string[] | undefined }
  | { kind: 'q-mismatch'; cursorQ: string | undefined } {
  if (cursorRaw === undefined) return { kind: 'ok', view: [...entries] };
  const decoded = decodeCommitmentCursor(cursorRaw);
  if (!decoded.ok) return { kind: 'malformed' };
  if (decoded.cursor.includeClosed !== includeClosed) {
    return { kind: 'includeClosed-mismatch', cursorIncludeClosed: decoded.cursor.includeClosed };
  }
  if (decoded.cursor.order !== order) {
    return { kind: 'order-mismatch', cursorOrder: decoded.cursor.order };
  }
  if (!originsMatch(decoded.cursor.origin, origin)) {
    return { kind: 'origin-mismatch', cursorOrigin: decoded.cursor.origin };
  }
  if (normalizeCommitmentQ(decoded.cursor.q) !== normalizeCommitmentQ(q)) {
    return { kind: 'q-mismatch', cursorQ: decoded.cursor.q };
  }
  const pivot: CommitmentPosition = decoded.cursor;
  const view = entries.filter((entry) => {
    const cmp = compareCommitmentPosition(commitmentPosition(entry), pivot);
    return order === 'newest' ? cmp < 0 : cmp > 0;
  });
  return { kind: 'ok', view };
}
