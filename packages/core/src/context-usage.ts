import { exactTokens, type ExactTokens } from './quantity.js';

// 軸の件数の上限を二重に定義しない: クローン層とランナー層の両方が使うため。版が上がって軸が増えたときに日誌の1行が黙って伸びるのを塞ぐ
export const CONTEXT_USAGE_CATEGORY_LIMIT = 24;

// ターンの終わりで聞く文脈占有の締め切り。層が2つとも同じこれを使う（#4649）
// 期限を置く: 聞いている間はそのターンの終わりの処理（報告・受信箱の次の合図）が先へ進まず、CLI が生きたまま答えないと永久に止まるため。観測であって仕事ではない
export const CONTEXT_USAGE_READ_TIMEOUT_MS = 10_000;

// 期限を過ぎたら投げる（`undefined` に畳まない）: 呼び出し元の catch が「測れなかった」を `error` として日誌へ残し、黙った回が数えられるようにするため
// 打ち切った後に返ってきた答えと失敗は捨てる（未処理の拒否にしない）
export async function contextUsageWithin<T>(answer: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`getContextUsage が ${String(ms)}ms 以内に返らなかった`));
    }, ms);
  });
  answer.catch(() => undefined);
  try {
    return await Promise.race([answer, expired]);
  } finally {
    clearTimeout(timer);
  }
}

// 分類は kind だけで行い、name の英語の文字列を見ない:
// > [sdk-verbatim SDKControlGetContextUsageResponse.categories.kind]
// > Classify on this, never on the English name.
export const CONTEXT_CATEGORY_KINDS = ['used', 'free', 'buffer', 'deferred'] as const;

export type ContextCategoryKind = (typeof CONTEXT_CATEGORY_KINDS)[number];

export interface ContextCategoryTotals {
  // 素の number にしない: 文字数（HeuristicChars）をトークンとして読み替える経路を tsc に落とさせるため
  tokens: ExactTokens;
  count: number;
}

export interface ContextCategorySummary {
  // free / buffer / deferred / unclassified を used に混ぜない: used は「毎ターン払っている量」として読まれるため
  used: ContextCategoryTotals;
  free: ContextCategoryTotals;
  buffer: ContextCategoryTotals;
  deferred: ContextCategoryTotals;
  // unclassified へ倒す: used に倒すと払っている量に紛れ込み、捨てると合計が食い違って消えた分が見えなくなるため
  unclassified: ContextCategoryTotals;
}

function emptyTotals(): ContextCategoryTotals {
  return { tokens: exactTokens(0), count: 0 };
}

function isContextCategoryKind(value: string | undefined): value is ContextCategoryKind {
  if (value === undefined) return false;
  return (CONTEXT_CATEGORY_KINDS as readonly string[]).includes(value);
}

// 例外を投げない: 未知の kind は unclassified へ入れるだけで呼び出しを止めない
export function summarizeContextCategories(
  categories: readonly { name: string; tokens: number; kind?: string }[] | undefined,
): ContextCategorySummary {
  const summary: ContextCategorySummary = {
    used: emptyTotals(),
    free: emptyTotals(),
    buffer: emptyTotals(),
    deferred: emptyTotals(),
    unclassified: emptyTotals(),
  };
  for (const category of categories ?? []) {
    const bucket = isContextCategoryKind(category.kind)
      ? summary[category.kind]
      : summary.unclassified;
    // += ではなく exactTokens(...) を通す: 算術演算子を通すと素の number に戻るため
    bucket.tokens = exactTokens(bucket.tokens + category.tokens);
    bucket.count += 1;
  }
  return summary;
}
