import { z } from 'zod';

// `diagnostics pull` が保存した `prompt.json`（`GET /self/prompt` の応答）を、分析の入力として読む。
// daemon の `selfPromptResponseSchema`（apps/daemon/src/openapi.ts）は core から import できないので、分析が読む欄だけを持つ写しをここに置く。
// 写しは「読む側の寛容」: 未知の欄は許し（zod は既定で捨てる）、分析が使わない欄（mcpInstructions・messageBreakdown・plugins の中身）は読まない。
// 必須の欄が無い・型が違うときは落とさず `unreadable` を返す（分析は節に「読めない」と書く）。

const failureSchema = z.object({ ok: z.literal(false), at: z.string(), error: z.string() });

const axis = <T extends z.ZodType>(value: T) =>
  z.union([
    z.object({ available: z.literal(true), value }),
    z.object({ available: z.literal(false), reason: z.string() }),
  ]);

const rows = <T extends z.ZodType>(row: T) =>
  z.object({ rows: z.array(row), omitted: z.number().int().nonnegative() });

const memoryDocumentSchema = z.object({
  slug: z.string(),
  type: z.string(),
  description: z.string().nullable(),
  chars: z.number().nonnegative(),
  indexChars: z.number().nonnegative().nullable(),
  indexForm: z.string().nullable().optional(),
  omitted: z.boolean(),
  indexNote: z.string().nullable(),
});

const toolSchema = z.object({
  name: z.string(),
  source: z.string().optional(),
  descriptionChars: z.number().nonnegative(),
  inputSchemaChars: z.number().nonnegative(),
});

// `kind` を z.enum にしない: SDK が値を足したとき、読めない入力に倒れず「分類できない」へ入れるため
const categoryRowSchema = z.object({
  name: z.string(),
  tokens: z.number().nonnegative(),
  kind: z.string().optional(),
});

const contextUsageOkSchema = z.object({
  ok: z.literal(true),
  at: z.string(),
  totalTokens: z.number(),
  rawMaxTokens: z.number(),
  percentage: z.number(),
  autoCompactThreshold: z.number().nullable().optional(),
  isAutoCompactEnabled: z.boolean().optional(),
  categories: axis(rows(categoryRowSchema)),
  mcpTools: axis(
    rows(
      z.object({
        name: z.string().nullable(),
        serverName: z.string().nullable(),
        tokens: z.number().nonnegative(),
        isLoaded: z.boolean().nullable().optional(),
      }),
    ),
  ),
  systemPromptSections: axis(
    rows(z.object({ name: z.string().nullable(), tokens: z.number().nonnegative() })),
  ),
  memoryFiles: axis(
    rows(
      z.object({
        path: z.string().nullable(),
        type: z.string().nullable(),
        tokens: z.number().nonnegative(),
      }),
    ),
  ),
  systemTools: axis(rows(z.object({ name: z.string(), tokens: z.number().nonnegative() }))),
  deferredBuiltinTools: axis(
    rows(
      z.object({ name: z.string(), tokens: z.number().nonnegative(), isLoaded: z.boolean() }),
    ),
  ),
});

export const promptJsonSchema = z.object({
  full: z.boolean(),
  session: z.union([
    z.object({
      ok: z.literal(true),
      builtAt: z.string(),
      resumedFrom: z.string().nullable(),
      sessionId: z.string().nullable(),
      model: z.string(),
    }),
    failureSchema,
    z.null(),
  ]),
  systemPrompt: z
    .object({ text: z.string().optional(), chars: z.number().nonnegative() })
    .nullable(),
  memoryInPrompt: z
    .object({
      documents: z.array(memoryDocumentSchema),
      omittedDocuments: z.number().nonnegative(),
    })
    .nullable(),
  tools: z.array(toolSchema).nullable(),
  builtinTools: z
    .object({
      reason: z.string(),
      systemTools: axis(rows(z.object({ name: z.string(), tokens: z.number().nonnegative() }))).nullable(),
      deferredBuiltinTools: axis(
        rows(
          z.object({ name: z.string(), tokens: z.number().nonnegative(), isLoaded: z.boolean() }),
        ),
      ).nullable(),
    })
    .nullable(),
  externalMcpServers: z.array(z.object({ name: z.string(), type: z.string() })).nullable(),
  externalMcpServersLive: z
    .object({ at: z.string(), failed: z.array(z.string()), retained: z.array(z.string()) })
    .nullable()
    .optional(),
  contextUsage: z.union([contextUsageOkSchema, failureSchema]).nullable(),
  notice: z.array(z.string()),
  secretScan: z.object({
    scanned: z.literal(true),
    hits: z.array(z.object({ rule: z.string(), count: z.number() })),
  }),
});

export type PromptJson = z.infer<typeof promptJsonSchema>;

export type PromptInput =
  | { state: 'none'; reason: string }
  | { state: 'unreadable'; reason: string }
  | { state: 'read'; body: PromptJson };

/**
 * `prompt.json` の本文を検査する。理由には欄の経路と種類だけを書く（zod の文言は受け取った値を含みうるので使わない）。
 */
export function parsePromptJson(text: string): PromptInput {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { state: 'unreadable', reason: 'JSON として読めない' };
  }
  const parsed = promptJsonSchema.safeParse(raw);
  if (parsed.success) return { state: 'read', body: parsed.data };
  const shown = parsed.error.issues.slice(0, 5).map((issue) => {
    const path = issue.path.map(String).join('.');
    return `${path === '' ? '(全体)' : path}（${issue.code}）`;
  });
  const more = parsed.error.issues.length - shown.length;
  return {
    state: 'unreadable',
    reason: `GET /self/prompt の応答の形と合わない: ${shown.join('、')}${more > 0 ? ` ほか ${String(more)} 件` : ''}`,
  };
}
