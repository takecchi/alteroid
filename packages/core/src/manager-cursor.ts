import { z } from 'zod';

import { jobStatusSchema, type JobStatus } from './schema.js';
import type { ManagerSummary } from './manager.js';

// `index.ts` へ export しない: `commitment-cursor.ts` / `approval-cursor.ts` は対応する HTTP 側の口があるから公開しているが、3群の並びは `manager_list`（MCP 側）だけの判断で、`GET /managers` の錨（`compareManagerPagingKey`）はこの cursor の対応物ではない。
// 群の分け方は `positionOf` を引数で受け、この関数は知らない: 並び（走行中・返事待ち → `lost` → その他）は台帳10,000本で走行中が0件しか出なかった実測に基づく設計で、cursor のために変えない。
// 錨は `managerId` を同値の破れ役として足した複合（`rank` / `startedAt` / `managerId`）: `rank` と `startedAt` が同値だと、keyset で繋いだときに同じ行を繰り返すか間を飛ばす。
// cursor は `status` を持つ: 錨は刷られた一覧の中でしか意味を持たず、別の絞りの一覧へ繋ぐと行を繰り返すか飛ばす。食い違えば黙ってどちらかへ倒さず `status-mismatch` を返す。
// `status: []` は「絞らない」（`null`）へ倒す。`manager_list` の契約に揃える。
// 実在検査はしない。群は往復しうる（`lost` の前後関係を確かめていない）ので「片道」とも言い切らず、群が動くと同じ行が再び窓に入るか間が飛ぶことはありうる。
export interface ManagerPosition {
  rank: 0 | 1 | 2;
  // 群の中だけの副順位（小さいほど先）。群の境界は動かさない。
  judgementRank: 0 | 1 | 2;
  startedAt: string;
  managerId: string;
}

// `tools.ts` の `compareManagerAttention` はこの関数を呼ぶだけにする: 並び替えと cursor が別々の比較を持つと、片方だけずれて黙って行が飛ぶ。
export function compareManagerPosition(a: ManagerPosition, b: ManagerPosition): number {
  if (a.rank !== b.rank) return a.rank - b.rank;
  // 副順位は群の中だけに効く: `rank` を先に比べているので、群の境界はこの行が何を返しても動かない。
  if (a.judgementRank !== b.judgementRank) return a.judgementRank - b.judgementRank;
  if (a.startedAt !== b.startedAt) return a.startedAt < b.startedAt ? 1 : -1;
  if (a.managerId !== b.managerId) return a.managerId < b.managerId ? -1 : 1;
  return 0;
}

const managerCursorSchema = z.object({
  rank: z.union([z.literal(0), z.literal(1), z.literal(2)]),
  // `.default(0)` を付ける: 副順位を足す前に発行済みの cursor はこの欄を持たず、必須にすると一斉に `malformed` になる。
  // 既定は `0`: 古い錨はどの値でも正しくならず、選べるのは壊れ方だけ。`0` は既に見た行を繰り返す側、`2` は間の行を飛ばす側に倒れる。飛ばすと到達できない委譲が生まれるので、繰り返す側を選んだ。
  judgementRank: z.union([z.literal(0), z.literal(1), z.literal(2)]).default(0),
  startedAt: z.string().min(1),
  managerId: z.string().min(1),
  status: z.array(jobStatusSchema).nullable(),
});

export type ManagerCursor = z.infer<typeof managerCursorSchema>;

// ソートする: 渡す順序の違いで、意味の同じ絞りが別の cursor として食い違い扱いにならないようにするため。
export function normalizeManagerCursorStatus(
  status: readonly JobStatus[] | undefined,
): readonly JobStatus[] | null {
  if (status === undefined || status.length === 0) return null;
  return [...status].sort();
}

function sameStatusFilter(a: readonly JobStatus[] | null, b: readonly JobStatus[] | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.length !== b.length) return false;
  const as = [...a].sort();
  const bs = [...b].sort();
  return as.every((value, index) => value === bs[index]);
}

export function encodeManagerCursor(cursor: ManagerCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export type DecodeManagerCursorResult = { ok: true; cursor: ManagerCursor } | { ok: false };

export function decodeManagerCursor(raw: string): DecodeManagerCursorResult {
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    return { ok: false };
  }
  const parsed = managerCursorSchema.safeParse(json);
  if (!parsed.success) return { ok: false };
  return { ok: true, cursor: parsed.data };
}

// 壊れた cursor や `status` の食い違いを、黙って先頭からへ・どちらかへ倒さない。
// `view` が0件なのはカーソルが一覧の末尾を指していた最後の頁で、エラーではない。
export function resolveManagerCursor(
  entries: readonly ManagerSummary[],
  positionOf: (entry: ManagerSummary) => ManagerPosition,
  statusFilter: readonly JobStatus[] | null,
  cursorRaw: string | undefined,
):
  | { kind: 'ok'; view: ManagerSummary[] }
  | { kind: 'malformed' }
  | { kind: 'status-mismatch'; cursorStatus: readonly JobStatus[] | null } {
  if (cursorRaw === undefined) return { kind: 'ok', view: [...entries] };
  const decoded = decodeManagerCursor(cursorRaw);
  if (!decoded.ok) return { kind: 'malformed' };
  if (!sameStatusFilter(decoded.cursor.status, statusFilter)) {
    return { kind: 'status-mismatch', cursorStatus: decoded.cursor.status };
  }
  const pivot: ManagerPosition = decoded.cursor;
  const view = entries.filter((entry) => compareManagerPosition(positionOf(entry), pivot) > 0);
  return { kind: 'ok', view };
}
