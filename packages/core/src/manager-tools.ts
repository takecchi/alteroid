import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { createCloneToolRelayHost, type CloneToolRelayHost } from './clone-tool-relay-host.js';
import { externalOutputLimits, type ExternalOutput } from './schema.js';
import { strictTool as tool } from './strict-tool-input.js';

// peer と分ける: peer は Codex の資格が届いた器でしか出ないが、こちらはどの器のマネージャーにも出すため
export const MANAGER_TOOLS_MCP_SERVER_NAME = 'alteroid-manager';

export const OUTPUT_RECORD_TOOL_NAME = 'output_record';

export const DEFAULT_MANAGER_TOOLS_SOCKET_DIR = '/run/alteroid/manager';
export const MANAGER_TOOLS_SOCKET_FILENAME = 'manager.sock';

export const MANAGER_TOOLS_TOKEN_TIMEOUT_MS = 30_000;

export type ManagerToolsSocketHost = CloneToolRelayHost;

/**
 * 守りの本体は使い捨ての token であって、ファイルの権限ではない（同じ子の UID の作業者からもソケット自体には届く）。
 * 向こうに居るのは `register()` の `McpServer` だけで、runner の制御面には繋げない。
 */
export async function createManagerToolsSocketHost(options: {
  socketPath: string;
  childUser?: { uid: number; gid: number };
  dirMode?: number;
}): Promise<ManagerToolsSocketHost> {
  const host = await createCloneToolRelayHost({
    socketPath: options.socketPath,
    dirMode: options.dirMode ?? 0o711,
    ...(options.childUser === undefined ? {} : { socketOwner: options.childUser }),
  });
  return {
    socketPath: host.socketPath,
    register(mcpServer: () => McpServer, registerOptions) {
      return host.register(mcpServer, {
        timeoutMs: MANAGER_TOOLS_TOKEN_TIMEOUT_MS,
        ...registerOptions,
      });
    },
    close: () => host.close(),
  };
}

export type OutputRecordInput = Omit<ExternalOutput, 'at'>;

/**
 * `record` は記録を runner のイベントとして送るだけで、外へは何も出さない（許可の確認を足さない理由）。
 * 送れたかの返事は無い（デーモンが古ければ落ちる）ので、道具の結果は「送った」までしか言わない。
 */
export function createManagerToolsMcpServer(deps: {
  record: (input: OutputRecordInput) => void;
}): ReturnType<typeof createSdkMcpServer> {
  return createSdkMcpServer({
    name: MANAGER_TOOLS_MCP_SERVER_NAME,
    version: '0.1.0',
    instructions:
      'alteroid のマネージャーが自分の作業を委譲の記録に残す道具。' +
      'コード以外で外へ出した成果（メール送信・予定登録・投稿・外部への保存）は output_record で記録する。',
    tools: [
      tool(
        OUTPUT_RECORD_TOOL_NAME,
        'コード以外で外へ出した成果（メールの送信・予定の登録・投稿・外部サービスへの保存など）を、' +
          '委譲の記録に1件残す。出すたびに1回呼ぶ。外へは何も送らない（記録するだけ）。' +
          'クローンは manager_report でこれを読み、器が消えたあとも成果の在りかを辿れる。' +
          'git に push したものは記録しなくてよい（作業ツリーは別に観測される）。鍵や秘密の値は書かないこと。',
        {
          kind: z
            .string()
            .trim()
            .min(1)
            .max(externalOutputLimits.kindMaxLength)
            .describe('種別（例: mail / calendar / post / external_save）'),
          where: z
            .string()
            .trim()
            .min(1)
            .max(externalOutputLimits.whereMaxLength)
            .describe('外の場所（URL・宛先・外部の ID など、あとで辿れるもの）'),
          summary: z
            .string()
            .trim()
            .min(1)
            .max(externalOutputLimits.summaryMaxLength)
            .optional()
            .describe('何を出したかの一言（任意）'),
        },
        (args) => {
          deps.record({
            kind: args.kind,
            where: args.where,
            ...(args.summary === undefined ? {} : { summary: args.summary }),
          });
          return Promise.resolve({
            content: [{ type: 'text' as const, text: '委譲の記録へ送った。' }],
          });
        },
      ),
    ],
  });
}
