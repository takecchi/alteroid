import { createHash } from 'node:crypto';

import { z } from 'zod';

import { MCP_SERVER_NAME } from './tools.js';

/**
 * 人間の MCP 連携の登録（`.mcp.json` の `mcpServers` と同じ形）を、記憶ストアに
 * 1つ置くための形（#325 段1）。
 *
 * ## なぜファイルではなく記憶ストアか
 *
 * PRD「業務範囲」は「人間が使っている連携が、クローンと作業者からも使えること」を
 * 要件にしているが、Railway には volume が1つも無く（`railway/README.md`）、
 * `/workspace/.mcp.json` も `/data/alteroid/.mcp.json` も器と一緒に消える。
 * ⟹ **置き場を器の外（記憶ストア。Railway では PostgreSQL）へ出し、SDK の
 * `Options.mcpServers` でコードから直接渡す**（#325 の 2026-09-24 のコメント
 * 「第4の道」）。実行環境プロファイル（`profile.ts`）が `.zprofile` を記憶ストアへ
 * 出したのと同じ形で、**器を焼き直さずに連携を足し引きできる**。
 *
 * ## 形を SDK の型から写してある理由
 *
 * 人間の手元の `.mcp.json` をそのまま貼れば通る形にしたい（書き直させると
 * 「人間が使っている連携がそのまま」ではなくなる）。⟹ 受けるのは SDK の
 * `McpStdioServerConfig` / `McpSSEServerConfig` / `McpHttpServerConfig`
 * （`@anthropic-ai/claude-agent-sdk` の `sdk.d.ts`）のうち、**JSON で書ける
 * 欄だけ**である。インプロセスの `sdk` 型（生きた `McpServer` を持つ）は
 * シリアライズできないので受けない。
 *
 * **未知の欄は黙って捨てずに拒む**（`z.strictObject`）。捨てると、綴りを間違えた
 * `headers` が「保存できたのに効かない」になる —— 人間からは成功に見える形の失敗
 * である（AGENTS.md「静かに失敗する道具」）。SDK が欄を増やしたら、ここへ足す。
 *
 * ## ⚠️ 値に鍵が入りうる
 *
 * `env` / `headers` / `args` には API キーのような秘密がそのまま入りうる。⟹ 読み書き
 * の口は実行環境プロファイルと同じく持ち主だけに絞り（`apps/daemon/src/app.ts` の
 * `/mcp-servers`）、日誌には**名前だけ**を書く（`mcpServerNames`）。
 *
 * ## どこまで届くか（#325 の段2・段3）
 *
 * - **クローン**（本セッションと蒸留）: 段2。`claude-provider.ts` の
 *   `buildCloneSessionOptions` / `buildCloneDistillOptions`
 * - **マネージャー・作業者**: 段3。runner は記憶ストアを読めない（鍵を持たない）ので、
 *   **デーモンが runner の名乗り（`hello`）のたびに降ろし**（`mcp-server-service.ts`・
 *   `manager.ts` の `#pushMcpServers`）、runner はそれを `buildManagerSessionOptions`
 *   の `mcpServers` へ渡す。作業者は `agents` の定義に `mcpServers` を書かず、親の
 *   接続を継承する（`claude-provider.ts` の同じ欄の doc に根拠がある）
 *
 * **CLI / Web UI の入口はまだ無い**（#325 の段4）。
 */

/**
 * 登録名。`claude mcp add` が受ける文字（英数字・`-`・`_`）に揃えてある。
 *
 * 名前は道具名の一部（`mcp__<名前>__<道具>`）になるので、ここで緩めると
 * `allowedTools` の照合や日誌の読み手が壊れる形の名前が入りうる。
 */
const MCP_SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * alteroid 自身のインプロセス MCP（`tools.ts` の `MCP_SERVER_NAME`）と同じ名前は
 * 登録させない。
 *
 * **大文字小文字を無視して比べる。** 道具名の接頭辞（`mcp__alteroid__`）で
 * 自作ツールを許可している（`CLONE_ALLOWED_TOOLS`）ので、見分けにくい綴りの
 * 別サーバが並ぶこと自体を入口で止める。合成の側でも自作が必ず勝つようにして
 * ある（`claude-provider.ts` の `cloneMcpServers`）—— ここはその手前の、
 * 「保存できたのに効かない」を作らないための門である。
 */
export function isReservedMcpServerName(name: string): boolean {
  return name.toLowerCase() === MCP_SERVER_NAME.toLowerCase();
}

export const mcpServerNameSchema = z
  .string()
  .regex(MCP_SERVER_NAME_PATTERN, '英数字・-・_ の1〜64文字で書くこと')
  .refine((name) => !isReservedMcpServerName(name), {
    message: `「${MCP_SERVER_NAME}」は alteroid 自身の MCP サーバの名前なので使えない`,
  });

const stringMapSchema = z.record(z.string(), z.string());

/** 3種に共通する任意の欄（SDK の同名の欄と同じ意味）。 */
const commonFields = {
  timeout: z.number().int().positive().optional(),
  alwaysLoad: z.boolean().optional(),
};

export const mcpStdioServerConfigSchema = z.strictObject({
  type: z.literal('stdio').optional(),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: stringMapSchema.optional(),
  ...commonFields,
});

export const mcpHttpServerConfigSchema = z.strictObject({
  type: z.literal('http'),
  url: z.string().min(1),
  headers: stringMapSchema.optional(),
  ...commonFields,
});

export const mcpSseServerConfigSchema = z.strictObject({
  type: z.literal('sse'),
  url: z.string().min(1),
  headers: stringMapSchema.optional(),
  ...commonFields,
});

export const mcpServerConfigSchema = z.union([
  mcpStdioServerConfigSchema,
  mcpHttpServerConfigSchema,
  mcpSseServerConfigSchema,
]);

/** 名前 → 登録。`.mcp.json` の `mcpServers` の値と同じ形。 */
export const mcpServersSchema = z.record(mcpServerNameSchema, mcpServerConfigSchema);

export type McpServerEntryConfig = z.infer<typeof mcpServerConfigSchema>;
export type McpServers = z.infer<typeof mcpServersSchema>;

/** 記憶ストアに置いた登録。 */
export interface StoredMcpServers {
  mcpServers: McpServers;
  updatedAt: string;
}

/**
 * 登録の名前だけを昇順で返す。**日誌・応答に値を載せないための口**である
 * （`env` / `headers` には鍵が入りうる）。
 */
export function mcpServerNames(servers: McpServers): string[] {
  return Object.keys(servers).sort();
}

/**
 * 器（fs / pg / インメモリ）が書き込みの前に通す検査。**3実装が同じ関数を呼ぶ**
 * —— 器ごとに検査を書くと、1つだけ緩い器が生まれる（`practice-contract.ts` の
 * doc が引く #370 と同じ形）。
 *
 * 投げる例外の文言には**値を載せない**（どの名前・どの欄かだけ）。
 */
export function parseMcpServers(input: unknown): McpServers {
  const result = mcpServersSchema.safeParse(input);
  if (result.success) return result.data;
  const first = result.error.issues[0];
  const where = first === undefined ? '' : first.path.map(String).join('.');
  throw new Error(
    `MCP サーバの登録の形が不正: ${where === '' ? '' : `${where}: `}${first?.message ?? '理由不明'}`,
  );
}

/**
 * 登録の同一性（**値を出さずに**「同じ版が届いているか」を突き合わせるための指紋）。
 * #325 段3。実行環境プロファイルの `fingerprintOf`（`profile.ts`）と同じ桁数
 * （sha256 の先頭12桁）にそろえてある。
 *
 * **鍵の順序に依存させない。** pg の `jsonb` はキーを並べ替えて返すので、書いた
 * ときの JSON 文字列をそのまま指紋にすると、同じ登録なのに「デーモンが持つ版」と
 * 「runner に届いた版」の指紋が食い違う（＝届いているのに届いていないと見える）。
 * ⟹ 全階層のキーを昇順に並べ直した正規形から取る。配列（`args`）の順序は
 * 意味を持つのでそのまま。
 *
 * 空の登録（`{}`）にも指紋は付くが、呼び出し側は「置いていない」を指紋では
 * なく `undefined` で表す（`RunnerHost.mcpServers()` の doc）。
 */
export function mcpServersFingerprintOf(servers: McpServers): string {
  return createHash('sha256').update(canonicalJson(servers), 'utf8').digest('hex').slice(0, 12);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
