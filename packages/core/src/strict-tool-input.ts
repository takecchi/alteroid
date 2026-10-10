import { tool as sdkTool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

/**
 * 道具の入力の shape を、知らない引数を断る object に包む。
 *
 * 包まずに raw shape のまま SDK の `tool()` へ渡すと、SDK はそれを `z.object(shape)`（知らない鍵を strip）にするので、
 * 道具に無い名前で渡した引数は道具に届かないまま呼び出しが成功し、呼び手は捨てられたことに気づけない。
 * 型は shape のまま返す: SDK の `tool()` の型は raw shape しか受けないが、実行時は zod のスキーマもそのまま使うため。
 */
export function strictToolInput<Shape extends object>(shape: Shape): Shape {
  const known = Object.keys(shape);
  const nested = Object.fromEntries(
    Object.entries(shape).map(([key, value]) => [key, strictNested(value as z.ZodType)]),
  );
  return z.strictObject(nested, {
    error: (issue) =>
      issue.code === 'unrecognized_keys' ? describeUnknownToolArgs(issue.keys, known) : undefined,
  }) as unknown as Shape;
}

interface ZodDefLike {
  readonly type: string;
  readonly [key: string]: unknown;
}

/**
 * 引数の値の中の入れ子の object も、知らない鍵を断る写しに組み直す。元のスキーマは変えない: `schema.ts` の共通のスキーマは
 * HTTP API・保存・日誌の検証でも使い、そちらの挙動まで変えないため。
 * 辿るのは object・array・optional・nullable・default・union だけ: 道具の入力に現れる入れ子はこれで尽きており、
 * それ以外（pipe・lazy など）は写さず元のまま返す（断らない側へ倒れる）。`catchall` を持つ object は変えない: 知らない鍵を受けると決めてあるため。
 * 写しには説明などのメタデータを貼り直す: `clone()` で落ち、モデルが読む道具の意味が削れるため（`withMissingArgHint` と同じ理由）。
 */
function strictNested(schema: z.ZodType): z.ZodType {
  const rebuilt = rebuildStrict(
    schema,
    (schema as unknown as { _zod: { def: ZodDefLike } })._zod.def,
  );
  if (rebuilt === schema) return schema;
  const meta = z.globalRegistry.get(schema);
  return meta === undefined ? rebuilt : rebuilt.meta(meta);
}

function rebuildStrict(schema: z.ZodType, def: ZodDefLike): z.ZodType {
  const cloneWith = (patch: Record<string, unknown>): z.ZodType =>
    schema.clone({ ...def, ...patch } as never);
  switch (def.type) {
    case 'object': {
      const shape = (schema as unknown as z.ZodObject).shape as Record<string, z.ZodType>;
      const strictShape = Object.fromEntries(
        Object.entries(shape).map(([key, value]) => [key, strictNested(value)]),
      );
      if (def['catchall'] !== undefined) {
        return Object.keys(shape).every((key) => strictShape[key] === shape[key])
          ? schema
          : cloneWith({ shape: strictShape });
      }
      const known = Object.keys(shape);
      const previous = def['error'];
      return cloneWith({
        shape: strictShape,
        catchall: z.never(),
        error: (issue: { code?: string; keys?: string[]; path?: PropertyKey[] }) =>
          issue.code === 'unrecognized_keys'
            ? describeUnknownNestedKeys(issue.path ?? [], issue.keys ?? [], known)
            : typeof previous === 'function'
              ? (previous as (issue: unknown) => unknown)(issue)
              : undefined,
      });
    }
    case 'array': {
      const element = def['element'] as z.ZodType;
      const strict = strictNested(element);
      return strict === element ? schema : cloneWith({ element: strict });
    }
    case 'optional':
    case 'nullable':
    case 'default': {
      const inner = def['innerType'] as z.ZodType;
      const strict = strictNested(inner);
      return strict === inner ? schema : cloneWith({ innerType: strict });
    }
    case 'union': {
      const options = def['options'] as z.ZodType[];
      const strict = options.map(strictNested);
      return strict.every((option, i) => option === options[i])
        ? schema
        : cloneWith({ options: strict });
    }
    default:
      return schema;
  }
}

/** SDK の `tool()` と同じ形で、入力を `strictToolInput` に包む。 */
export const strictTool: typeof sdkTool = (name, description, inputSchema, handler, extras) =>
  sdkTool(name, description, strictToolInput(inputSchema), handler, extras);

export function describeUnknownToolArgs(
  unknown: readonly string[],
  known: readonly string[],
): string {
  return (
    `この道具に無い引数: ${unknownNamesText(unknown, known)}。黙って捨てずに断った（呼び出しは何もしていない）。` +
    `受け付ける引数: ${known.length === 0 ? '（無い）' : known.join(', ')}`
  );
}

/** 道具の直下の `describeUnknownToolArgs` と同じ形に、場所（`questions[0].options[1]` の形）を添える。 */
export function describeUnknownNestedKeys(
  path: readonly PropertyKey[],
  unknown: readonly string[],
  known: readonly string[],
): string {
  return (
    `${formatArgPath(path)} に無い欄: ${unknownNamesText(unknown, known)}。黙って捨てずに断った（呼び出しは何もしていない）。` +
    `受け付ける欄: ${known.length === 0 ? '（無い）' : known.join(', ')}`
  );
}

function unknownNamesText(unknown: readonly string[], known: readonly string[]): string {
  return unknown
    .map((name) => {
      const near = nearestName(name, known);
      return near === undefined ? name : `${name}（近い名前: ${near}）`;
    })
    .join(', ');
}

function formatArgPath(path: readonly PropertyKey[]): string {
  if (path.length === 0) return '引数の値';
  return path
    .map((part, i) =>
      typeof part === 'number' ? `[${String(part)}]` : `${i === 0 ? '' : '.'}${String(part)}`,
    )
    .join('');
}

// 近いと言うのは、編集距離が長いほうの名前の半分以下のときだけ: 遠い名前まで挙げると、誤った言い換えを促すため
function nearestName(name: string, known: readonly string[]): string | undefined {
  let best: { name: string; score: number } | undefined;
  for (const candidate of known) {
    const score =
      editDistance(name.toLowerCase(), candidate.toLowerCase()) /
      Math.max(name.length, candidate.length);
    if (score <= 0.5 && (best === undefined || score < best.score)) {
      best = { name: candidate, score };
    }
  }
  return best?.name;
}

function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(
        (previous[j] ?? 0) + 1,
        (current[j - 1] ?? 0) + 1,
        (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
}
