import { createHash } from 'node:crypto';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  ALTEROID_REPORT_SOURCE,
  REPORT_PROBLEM_COMPONENTS,
  REPORT_PROBLEM_LIMITS,
  REPORT_PROBLEM_SEVERITIES,
  hasNul,
  isReservedEventSource,
} from '@alteroid/core';
import { Hono } from 'hono';
import { describeRoute } from 'hono-openapi';
import { z } from 'zod';
import type { AppContext } from './app-context.js';
import type { AuthVariables } from './auth.js';
import { deliberateClient, isWellFormedString } from './app-shared.js';
import {
  DIAGNOSTICS_NOT_PERSISTED_MESSAGE,
  acceptDiagnosticsSummary,
  checkDiagnosticsSummary,
} from './diagnostics-summary-intake.js';

// 鍵でない資格（operator・アカウント）が呼ぶときの source は `ALTEROID_REPORT_SOURCE`（core が持つ。読む側と同じ定数）。鍵のときは鍵の source を使い、引数からは変えられない。
// 列挙と上限も core の `REPORT_PROBLEM_*` を参照する（読む側の整形と入口がずれない）。

// 文字列の欄は NUL・孤立サロゲートを断る（pg は NUL を落とし孤立サロゲートを置き換えて残すので、黙って通すと別々の報告が潰れる）。
function text(max: number, min = 0) {
  return z
    .string()
    .min(min)
    .max(max)
    .refine((value) => !hasNul(value), 'NUL を含められない')
    .refine(isWellFormedString, '孤立サロゲートを含められない');
}

// 厳格: 未知の欄（`source` を含む）は黙って捨てず拒否する。
const reportProblemInput = z.strictObject({
  summary: text(REPORT_PROBLEM_LIMITS.summary, 1),
  component: z.enum(REPORT_PROBLEM_COMPONENTS),
  severity: z.enum(REPORT_PROBLEM_SEVERITIES),
  expected: text(REPORT_PROBLEM_LIMITS.expected).optional(),
  actual: text(REPORT_PROBLEM_LIMITS.actual).optional(),
  steps: text(REPORT_PROBLEM_LIMITS.steps).optional(),
  environment: text(REPORT_PROBLEM_LIMITS.environment).optional(),
  logs: text(REPORT_PROBLEM_LIMITS.logs).optional(),
  attachmentIds: z.array(text(200, 1)).max(5).optional(),
});

// 要約の中身は入口の検査（`checkDiagnosticsSummary`）が strict の型で見る。ここで型を直に渡さない: MCP の SDK の検査が失敗すると、zod の文面が入力の値を抱えうるため。object であることだけをここで言う。
const reportDiagnosticsSummaryInput = z.strictObject({
  summary: z.record(z.string(), z.unknown()),
});

const reportProblemOutput = z.object({
  ok: z.literal(true),
  id: z.string(),
  duplicate: z.boolean(),
});

// 同じ問題の言い換えでない揺れ（大文字小文字・前後と連続の空白）だけを畳む。意味の解釈はしない。
function problemIdempotencyKey(component: string, summary: string): string {
  const normalized = summary.trim().replace(/\s+/g, ' ').toLowerCase();
  return `mcp-report:${createHash('sha256')
    .update(JSON.stringify([component, normalized]))
    .digest('hex')}`;
}

function toolError(message: string) {
  return { isError: true as const, content: [{ type: 'text' as const, text: message }] };
}

const NOT_PERSISTED_MESSAGE =
  '受信箱へ書けなかったので、報告を受け付けていない（何も積んでおらず、添付も結んでいない）。送り直してよい。';

export function mcpRoutes(ctx: AppContext) {
  const {
    withEventReceiptLock,
    eventReceiptScopeOf,
    findEventReceiptQuietly,
    recordEventReceiptQuietly,
    acceptExternal,
  } = ctx;

  // リクエストごとに作る（ステートレス）: 呼び手の資格を閉じ込めるので、使い回さない。
  function buildServer(principal: AuthVariables['principal']): McpServer {
    const server = new McpServer({ name: 'alteroid', version: '1' });
    server.registerTool(
      'report_problem',
      {
        title: 'alteroid の問題を報告する',
        description:
          'alteroid（クローン）の不具合・困りごとを、クローンの受信箱へ直接報告する。' +
          '報告は人間の依頼ではなく外部からの知らせとして届く。severity は報告者の自己申告。' +
          '同じ component と同じ summary（空白・大文字小文字の揺れは同じとみなす）の再報告は、' +
          '積まずに duplicate: true を返す。attachmentIds は同じ連携の鍵で POST /attachments に上げた添付だけ。',
        inputSchema: reportProblemInput,
        outputSchema: reportProblemOutput,
      },
      async (args) => {
        const source = principal.kind === 'integration' ? principal.source : ALTEROID_REPORT_SOURCE;
        // 鍵の source は作成時に検査済みだが、`POST /events` と同じ順序・同じ規則でここでも断る。
        if (hasNul(source) || !isWellFormedString(source) || isReservedEventSource(source)) {
          return toolError('この source は使えない（何も積んでいない）。');
        }
        const { attachmentIds, ...fields } = args;
        const payload = Object.fromEntries(
          Object.entries(fields).filter(([, value]) => value !== undefined),
        );
        const idempotencyKey = problemIdempotencyKey(args.component, args.summary);
        const scope = eventReceiptScopeOf(principal);
        try {
          return await withEventReceiptLock(
            JSON.stringify([scope, source, idempotencyKey]),
            async () => {
              // 添付を結ぶ前に見分ける（`POST /events` と同じ）。
              const prior = await findEventReceiptQuietly(scope, source, idempotencyKey);
              const done = (id: string, duplicate: boolean) => {
                const structuredContent = { ok: true as const, id, duplicate };
                return {
                  content: [{ type: 'text' as const, text: JSON.stringify(structuredContent) }],
                  structuredContent,
                };
              };
              if (prior !== null) return done(prior.eventId, true);
              const accepted = await acceptExternal({
                principal,
                source,
                payload,
                attachmentIds,
                onPersisted: (eventId, at) =>
                  recordEventReceiptQuietly({ scope, source, idempotencyKey, eventId, at }),
              });
              if (accepted.kind === 'attach-failed') {
                const retryable = accepted.status >= 500;
                return toolError(
                  `添付を結べなかったので、報告を受け付けていない（何も積んでおらず、何も結んでいない）: ${accepted.body.error}` +
                    (retryable
                      ? '。そのまま送り直してよい。'
                      : '。添付の指定を直さないと同じ理由で断られる。'),
                );
              }
              if (accepted.kind === 'unavailable') return toolError(NOT_PERSISTED_MESSAGE);
              return done(accepted.id, false);
            },
          );
        } catch {
          // 例外の文面（値を抱えうる）は返さない。受け付けたかを確かめられない形ではないので、送り直してよいと書く。
          return toolError(NOT_PERSISTED_MESSAGE);
        }
      },
    );
    server.registerTool(
      'report_diagnostics_summary',
      {
        title: '診断の要約を送る',
        description:
          '別の alteroid の消費の診断の要約（`alteroid diagnostics summarize` の出力）を、日誌へ積んでもらう。' +
          '受信箱へは積まず、クローンは起きない。要約は strict の型（最大 16 KiB）で検査し、通らない・秘密らしい文字列を含むものは何も積まずに断る。' +
          '同じ source・同じ period（start と end）の再送は、積まずに duplicate: true を返す（先着）。period が null の要約は断る。',
        inputSchema: reportDiagnosticsSummaryInput,
        outputSchema: reportProblemOutput,
      },
      async (args) => {
        const source = principal.kind === 'integration' ? principal.source : ALTEROID_REPORT_SOURCE;
        if (hasNul(source) || !isWellFormedString(source) || isReservedEventSource(source)) {
          return toolError('この source は使えない（何も積んでいない）。');
        }
        const checked = checkDiagnosticsSummary(args.summary, process.env);
        if (!checked.ok) return toolError(checked.message);
        const { period } = checked.value;
        // period が null の要約は `acceptDiagnosticsSummary` が断る（錠は取るが何も積まない）
        const lockKey = JSON.stringify([
          'diagnostics-summary',
          source,
          period?.start ?? null,
          period?.end ?? null,
        ]);
        try {
          const result = await withEventReceiptLock(lockKey, () =>
            acceptDiagnosticsSummary({
              journal: ctx.stores.journal,
              principal,
              source,
              summary: checked.value,
            }),
          );
          if (result.kind !== 'accepted') return toolError(result.message);
          const structuredContent = { ok: true as const, id: result.id, duplicate: result.duplicate };
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(structuredContent) }],
            structuredContent,
          };
        } catch {
          return toolError(DIAGNOSTICS_NOT_PERSISTED_MESSAGE);
        }
      },
    );
    return server;
  }

  // 鍵が通れる MCP のメソッドは、この server が持つ道具（tools/list・tools/call と initialize・ping）だけ: 資源・プロンプトなど他の能力は登録しないので「未対応」で断られる。
  return new Hono<{ Variables: AuthVariables }>().post(
    '/mcp',
    describeRoute({
      tags: ['mcp'],
      summary:
        'MCP（Streamable HTTP、ステートレス）。道具は report_problem と report_diagnostics_summary の2本だけ',
      description:
        '外の AI が MCP の道具で、クローンの受信箱へ問題を報告する（`report_problem`）口と、別の alteroid の消費の診断の要約を日誌へ送る（`report_diagnostics_summary`）口。リクエストごとに完結する（セッションも持続接続も無い。JSON 応答）。' +
        '`Accept: application/json, text/event-stream` と `content-type: application/json` が要る。' +
        '連携の鍵（`altk_`）・アカウント・operator のどれでも叩ける。道具は `report_problem` と `report_diagnostics_summary` の2本だけ' +
        '（`tools/list`）。source は引数に無く、鍵の source（鍵でない資格は `alteroid-report`）に固定。' +
        '受け付けた結果は `{ok, id, duplicate}` だけを返す。受信箱へ書けなかった・添付を結べなかったときは' +
        '何も積まず、ツールエラー（`isError: true`）で返す。' +
        '`report_diagnostics_summary` は受信箱へ積まず（クローンを起こさない）、strict の型・秘密の走査に通らない要約や period が null の要約は何も積まずに断り、' +
        '日誌の `diagnostics_summary` の行として積む（読むのは `GET /journal?type=diagnostics_summary`）。応答の本文は JSON-RPC。',
      responses: {
        200: {
          description: 'JSON-RPC の応答（ツールエラーも 200 の `isError: true` で返る）。',
          content: { 'application/json': { schema: {} } },
        },
        202: { description: '通知（応答の無い JSON-RPC メッセージ）を受けた。' },
        400: {
          description: 'JSON-RPC として不正。',
          content: { 'application/json': { schema: {} } },
        },
        401: {
          description: '連携の鍵が無効か期限切れ（未知・失効・期限切れ）。または資格が無い。',
          content: { 'application/json': { schema: {} } },
        },
        406: {
          description: '`Accept` に `application/json` と `text/event-stream` の両方が無い。',
          content: { 'application/json': { schema: {} } },
        },
        413: {
          description: '連携の鍵の本文の上限を超えた。',
          content: { 'application/json': { schema: {} } },
        },
        415: {
          description: 'content-type が application/json でない。',
          content: { 'application/json': { schema: {} } },
        },
        429: {
          description: '連携の鍵の回数の上限を超えた。',
          content: { 'application/json': { schema: {} } },
        },
      },
    }),
    deliberateClient,
    async (c) => {
      const server = buildServer(c.get('principal'));
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      await server.connect(transport);
      try {
        return await transport.handleRequest(c.req.raw);
      } finally {
        await server.close();
      }
    },
  );
}
