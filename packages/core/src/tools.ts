import { randomUUID } from 'node:crypto';

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

import type { ChatStreamEvent, PendingApproval } from './schema.js';
import type { Stores } from './store.js';

/**
 * クローンの道具（インプロセス MCP）。
 *
 * クローンは組み込みツールを持たない。持つのはここにある自作ツールだけであり、
 * これは人間の写像としての配置であってデグレードではない
 * （north_star「適用範囲」）。この理由付けをマネージャー以下に流用しないこと。
 *
 * モデルから見える名前は `mcp__alteroid__<tool>` になる。
 */
export const MCP_SERVER_NAME = 'alteroid';

export interface ToolContext {
  stores: Stores;
  /** いま人間と繋がっている会話へイベントを流す（繋がっていなければ捨てる）。 */
  emit(event: ChatStreamEvent): void;
}

export function qualifiedToolName(name: string): string {
  return `mcp__${MCP_SERVER_NAME}__${name}`;
}

export const CLONE_TOOL_NAMES = [
  'memory_list',
  'memory_read',
  'memory_write',
  'memory_append',
  'journal_write',
  'journal_read',
  'ask_human',
  'manager_start',
  'manager_send',
  'manager_list',
] as const;

/** 自作ツールは確認なしで通す（能力の削除ではなく、道具が道具として使えること）。 */
export const CLONE_ALLOWED_TOOLS = CLONE_TOOL_NAMES.map(qualifiedToolName);

function text(body: string) {
  return { content: [{ type: 'text' as const, text: body }] };
}

const NOT_YET = (name: string) =>
  text(
    `${name} は M2（委譲）で実装される。いまはマネージャーを起こせない。` +
      `実作業が必要な依頼は、その旨を人間に伝えるか記憶に残しておくこと。`,
  );

/** ツール定義そのもの。MCP の配線を通さずに単体テストできるよう分けてある。 */
export function createCloneTools(context: ToolContext) {
  const { stores } = context;

  return [
    // --- 記憶 -----------------------------------------------------------
    tool('memory_list', '記憶の文書一覧を返す。中身は返さない。', {}, async () => {
      const documents = await stores.persona.list();
      if (documents.length === 0) return text('（記憶はまだ空）');
      return text(
        documents.map((doc) => `- ${doc.slug}: ${doc.title} (${doc.updatedAt})`).join('\n'),
      );
    }),

    tool(
      'memory_read',
      '記憶の文書を1つ読む。',
      { slug: z.string().describe('文書のスラッグ（拡張子なし）') },
      async ({ slug }) => {
        const doc = await stores.persona.read(slug);
        return text(doc ? doc.content : `記憶 ${slug} は存在しない。`);
      },
    ),

    tool(
      'memory_write',
      [
        '記憶の文書を全文置換する（無ければ作る）。',
        '人間がこのファイルを直接開いて読むことを前提に、Markdown として読みやすく書くこと。',
        '人間が手で書いた記述を、整形の都合で消さないこと。',
      ].join(' '),
      {
        slug: z.string().describe('文書のスラッグ（英小文字・数字・-・_）'),
        content: z.string().describe('Markdown 全文'),
        summary: z.string().describe('何を更新したかの一行要約（日誌に残る）'),
      },
      async ({ slug, content, summary }) => {
        await stores.persona.write(slug, content);
        await stores.journal.append({ type: 'memory_update', slug, cause: 'clone', summary });
        return text(`記憶 ${slug} を更新した。`);
      },
    ),

    tool(
      'memory_append',
      '記憶の文書の末尾に追記する（無ければ作る）。既存の記述を消したくないときはこちら。',
      {
        slug: z.string().describe('文書のスラッグ'),
        content: z.string().describe('追記する Markdown'),
        summary: z.string().describe('何を追記したかの一行要約（日誌に残る）'),
      },
      async ({ slug, content, summary }) => {
        await stores.persona.append(slug, content);
        await stores.journal.append({ type: 'memory_update', slug, cause: 'clone', summary });
        return text(`記憶 ${slug} に追記した。`);
      },
    ),

    // --- 日誌 -----------------------------------------------------------
    tool(
      'journal_write',
      [
        '判断を日誌に残す（追記専用）。',
        '人間に聞かずに実行した判断は必ずここに残すこと。',
        '人間が後から読んで否定できることが、最終承認の実体である。',
      ].join(' '),
      {
        decision: z.string().describe('何を判断し、何をしたか'),
        grounds: z.string().describe('記憶のどこに根拠があったか。無いなら「根拠なし」と書く'),
      },
      async ({ decision, grounds }) => {
        const entry = await stores.journal.append({ type: 'decision', decision, grounds });
        return text(`日誌に記録した（${entry.id}）。`);
      },
    ),

    tool(
      'journal_read',
      '日誌を新しい順に読む。',
      { limit: z.number().int().min(1).max(200).optional().describe('件数（既定 20）') },
      async ({ limit }) => {
        const entries = await stores.journal.list({ limit: limit ?? 20 });
        if (entries.length === 0) return text('（日誌はまだ空）');
        return text(entries.map((entry) => JSON.stringify(entry)).join('\n'));
      },
    ),

    // --- 人間への確認 ----------------------------------------------------
    tool(
      'ask_human',
      [
        '人間に確認する。記憶に根拠が無いことだけをここへ回す。',
        'これは承認待ちキューに積むだけで、人間の応答を待たない。',
        '止まるのはこの件だけであり、他の仕事は進めてよい。',
        '回答は後から受信箱に届く。',
      ].join(' '),
      {
        question: z.string().describe('人間への質問。何を判断してほしいかを具体的に'),
        context: z.string().optional().describe('判断に必要な背景'),
      },
      async ({ question, context: background }) => {
        const approval: PendingApproval = {
          id: randomUUID(),
          createdAt: new Date().toISOString(),
          question,
          ...(background === undefined ? {} : { context: background }),
        };
        await stores.jobs.putApproval(approval);
        await stores.journal.append({
          type: 'escalation',
          question,
          approvalId: approval.id,
        });
        context.emit({ type: 'ask_human', approvalId: approval.id, question });
        return text(`承認待ちキューに積んだ（${approval.id}）。回答は後から届く。`);
      },
    ),

    // --- 委譲（M2 で実装） ------------------------------------------------
    tool(
      'manager_start',
      'マネージャーを起こして仕事を任せる（M2 で実装）。',
      {
        request: z.string().describe('依頼内容'),
        cwd: z.string().optional().describe('作業ディレクトリ'),
      },
      async () => NOT_YET('manager_start'),
    ),

    tool(
      'manager_send',
      '走行中のマネージャーに追加指示や回答を送る（M2 で実装）。',
      { managerId: z.string(), message: z.string() },
      async () => NOT_YET('manager_send'),
    ),

    tool('manager_list', '走行中のマネージャーの一覧と状態を見る（M2 で実装）。', {}, async () =>
      NOT_YET('manager_list'),
    ),
  ];
}

export function createCloneMcpServer(context: ToolContext) {
  return createSdkMcpServer({
    name: MCP_SERVER_NAME,
    version: '0.1.0',
    instructions:
      'alteroid のクローン自身の道具。記憶（人間がいつでも読み書きする Markdown）、' +
      '日誌（追記専用）、人間への確認、マネージャーへの委譲。',
    tools: createCloneTools(context),
  });
}
