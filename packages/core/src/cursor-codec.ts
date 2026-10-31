import type { z } from 'zod';

// 一覧の続きを指すカーソルの共通の符号化: JSON を base64url にし、読むときは zod で検める。
// 種類ごとの違い（スキーマ・encode 前の整形・錨の探し方）は各 `*-cursor.ts` に残す。
export type DecodeCursorResult<T> = { ok: true; cursor: T } | { ok: false };

// キーの並びは渡した値の並びのまま（出回っているカーソルの文字列を変えない）。
export function encodeCursor(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

// 読めない（base64url/JSON でない・スキーマに合わない）ときは `{ ok: false }`。文言は呼び手が決める。
export function decodeCursor<S extends z.ZodType>(
  schema: S,
  raw: string,
): DecodeCursorResult<z.output<S>> {
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    return { ok: false };
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) return { ok: false };
  return { ok: true, cursor: parsed.data };
}

// schema を1つ渡すと、その一覧の encode / decode の対が得られる。各 `*-cursor.ts` はキーの形（schema）と比べ方だけを持つ。
export function cursorCodec<S extends z.ZodType>(
  schema: S,
): {
  encode: (cursor: z.output<S>) => string;
  decode: (raw: string) => DecodeCursorResult<z.output<S>>;
} {
  return {
    encode: (cursor) => encodeCursor(cursor),
    decode: (raw) => decodeCursor(schema, raw),
  };
}
