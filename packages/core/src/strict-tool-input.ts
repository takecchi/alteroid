import { tool as sdkTool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

/**
 * 道具の入力の shape を、知らない引数を断る object に包む。
 *
 * 包まずに raw shape のまま SDK の `tool()` へ渡すと、SDK はそれを `z.object(shape)`（知らない鍵を strip）にするので、
 * 道具に無い名前で渡した引数は道具に届かないまま呼び出しが成功し、呼び手は捨てられたことに気づけない
 * （クローンが `ask_human` に `questions` ではなく `options` を渡し、選択肢の無い承認待ちが積まれた実例）。
 * 型は shape のまま返す: SDK の `tool()` の型は raw shape しか受けないが、実行時は zod のスキーマもそのまま使うため。
 */
export function strictToolInput<Shape extends object>(shape: Shape): Shape {
  const known = Object.keys(shape);
  return z.strictObject(shape as z.ZodRawShape, {
    error: (issue) =>
      issue.code === 'unrecognized_keys' ? describeUnknownToolArgs(issue.keys, known) : undefined,
  }) as unknown as Shape;
}

/** SDK の `tool()` と同じ形で、入力を `strictToolInput` に包む。 */
export const strictTool: typeof sdkTool = (name, description, inputSchema, handler, extras) =>
  sdkTool(name, description, strictToolInput(inputSchema), handler, extras);

export function describeUnknownToolArgs(
  unknown: readonly string[],
  known: readonly string[],
): string {
  const parts = unknown.map((name) => {
    const near = nearestName(name, known);
    return near === undefined ? name : `${name}（近い名前: ${near}）`;
  });
  return (
    `この道具に無い引数: ${parts.join(', ')}。黙って捨てずに断った（呼び出しは何もしていない）。` +
    `受け付ける引数: ${known.length === 0 ? '（無い）' : known.join(', ')}`
  );
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
