import { z } from 'zod';

// 錨の位置を探索しない: 費用は増える一方なので、値の比較だけで頁を切れるため
// asOf の比較を `>=` にしない: asOf を作った行自身が呼ぶたびに risen へ載り続けるため。旧形式の cursor（tiedAtAsOf なし）は断らず `>` のみで読む
const usageCursorSchema = z.object({
  axis: z.string().min(1),
  label: z.string(),
  cost: z.number(),
  asOf: z.string().optional(),
  tiedAtAsOf: z.array(z.object({ label: z.string(), cost: z.number() })).optional(),
});

export type UsageCursor = z.infer<typeof usageCursorSchema>;

export function encodeUsageCursor(cursor: UsageCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export type DecodeUsageCursorResult = { ok: true; cursor: UsageCursor } | { ok: false };

export function decodeUsageCursor(raw: string): DecodeUsageCursorResult {
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    return { ok: false };
  }
  const parsed = usageCursorSchema.safeParse(json);
  if (!parsed.success) return { ok: false };
  return { ok: true, cursor: parsed.data };
}

export interface UsageCursorEntry {
  label: string;
  cost: number;
  updatedAt: string;
}

// `<`/`>` にしない: 並べ替え側が localeCompare で、ロケール依存の文字で頁の境界と実際の並びがずれるため
function isAfterAnchor(
  axis: string,
  entry: Pick<UsageCursorEntry, 'label' | 'cost'>,
  anchor: Pick<UsageCursor, 'axis' | 'label' | 'cost'>,
): boolean {
  if (axis === 'date') return entry.label.localeCompare(anchor.label) < 0;
  const costDiff = entry.cost - anchor.cost;
  if (costDiff !== 0) return costDiff < 0;
  return entry.label.localeCompare(anchor.label) > 0;
}

export type UsageCursorTie = { label: string; cost: number };

export function findUsageCursorTies<T extends UsageCursorEntry>(
  entries: readonly T[],
  axis: string,
  anchor: Pick<UsageCursorEntry, 'label' | 'cost'>,
  asOf: string | undefined,
): UsageCursorTie[] {
  if (asOf === undefined) return [];
  return entries
    .filter((entry) => !isAfterAnchor(axis, entry, { axis, ...anchor }) && entry.updatedAt === asOf)
    .map((entry) => ({ label: entry.label, cost: entry.cost }));
}

export type ResolveUsageCursorResult<T> =
  { kind: 'malformed' } | { kind: 'wrong-axis' } | { kind: 'ok'; page: T[]; risen: T[] };

// malformed / wrong-axis を黙って先頭へ倒さない: 別の文脈の cursor を使い回すと、壊れた頁が黙って返るため
export function resolveUsageCursor<T extends UsageCursorEntry>(
  entries: readonly T[],
  axis: string,
  cursorRaw: string | undefined,
): ResolveUsageCursorResult<T> {
  if (cursorRaw === undefined) return { kind: 'ok', page: [...entries], risen: [] };
  const decoded = decodeUsageCursor(cursorRaw);
  if (!decoded.ok) return { kind: 'malformed' };
  const anchor = decoded.cursor;
  if (anchor.axis !== axis) return { kind: 'wrong-axis' };

  const page = entries.filter((entry) => isAfterAnchor(axis, entry, anchor));
  const asOf = anchor.asOf;
  const tiedAtAsOf = anchor.tiedAtAsOf;
  const wasAlreadyShown = (entry: Pick<UsageCursorEntry, 'label' | 'cost'>): boolean =>
    (tiedAtAsOf ?? []).some((tie) => tie.label === entry.label && tie.cost === entry.cost);
  const risen =
    asOf === undefined
      ? []
      : entries.filter((entry) => {
          if (isAfterAnchor(axis, entry, anchor)) return false;
          if (entry.updatedAt > asOf) return true;
          if (entry.updatedAt < asOf) return false;
          return tiedAtAsOf !== undefined && !wasAlreadyShown(entry);
        });
  return { kind: 'ok', page, risen };
}
