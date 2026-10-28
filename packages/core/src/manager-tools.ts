import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { createCloneToolRelayHost, type CloneToolRelayHost } from './clone-tool-relay-host.js';
import { externalOutputLimits, type ExternalOutput } from './schema.js';
import { strictTool as tool } from './strict-tool-input.js';

// peer と分ける: peer は Codex の資格が届いた器でしか出ないが、こちらはどの器のマネージャーにも出すため
export const MANAGER_TOOLS_MCP_SERVER_NAME = 'alteroid-manager';

export const OUTPUT_RECORD_TOOL_NAME = 'output_record';
export const RESCUE_RESTORE_TOOL_NAME = 'rescue_restore';
export const REPORT_ATTACH_TOOL_NAME = 'report_attach';

/** 1回の呼び出しで名指せる個数。取り込みの個数の上限（`ATTACHMENT_MAX_PER_MESSAGE_DEFAULT`）に合わせず、上限を変えた器でも道具の入力は変えない。 */
export const REPORT_ATTACH_MAX_PATHS = 50;

export type ReportAttachResult =
  | { path: string; ok: true; name: string; size: number }
  | { path: string; ok: false; reason: string };

export function renderReportAttachResults(results: readonly ReportAttachResult[]): string {
  const lines = results.map((r) =>
    r.ok
      ? `写した: ${r.path} → ${r.name}（${String(r.size)} バイト）`
      : `断った: ${r.path}: ${r.reason}`,
  );
  const copied = results.filter((r) => r.ok).length;
  return [
    ...lines,
    copied > 0
      ? `写した ${String(copied)} 件は、ターンの終わりの報告で届く。`
      : '1件も写せなかった。断った理由を直して、もう一度名指しする。',
  ].join('\n');
}

export interface RescueRestoreInput {
  paths?: string[];
  from?: string;
}

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
  /** `rescue_restore` の依頼を出来事として積むだけ（デーモンへの同期の問い合わせ口は無い）。 */
  restore: (input: RescueRestoreInput) => void;
  /** 届く先の案内（`/tmp/alteroid-attachments/<managerId>/…`）に使う。 */
  managerId: string;
  /**
   * `report_attach` の写す処理。省けば道具を出さない（出し箱を用意できなかった構成）。
   * 写すのは runner で、担い手は `cp` を打たない（分類器に止められるため）。
   */
  attach?: (paths: string[]) => Promise<ReportAttachResult[]>;
}): ReturnType<typeof createSdkMcpServer> {
  const attach = deps.attach;
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
          'ユーザーは manager_report でこれを読み、器が消えたあとも成果の在りかを辿れる。' +
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
      tool(
        RESCUE_RESTORE_TOOL_NAME,
        '器が入れ替わる前にデーモンが預かった、未追跡のファイル（git に入っていなかった作業ファイル）を取り戻す。' +
          '依頼を出すだけで、結果はこの呼び出しでは返らない: デーモンが預かりを添付として、次の入力（あなた宛ての知らせ）で届ける。' +
          '省略すると全部。前任の委譲の分を取るときは from に前任の id を渡す（前任が自分を後継にしているときだけ通る）。',
        {
          paths: z
            .array(z.string().trim().min(1).max(1000))
            .max(200)
            .optional()
            .describe(
              '取り戻すファイル。`<作業ツリー>/<パス>` の形、またはパスだけ。省けば全部。知らせで残りを案内されたときは、そのパスを渡して呼び直す',
            ),
          from: z
            .string()
            .trim()
            .min(1)
            .max(200)
            .optional()
            .describe('前任の委譲 id。省けば自分の預かり'),
        },
        (args) => {
          deps.restore({
            ...(args.paths === undefined ? {} : { paths: args.paths }),
            ...(args.from === undefined ? {} : { from: args.from }),
          });
          return Promise.resolve({
            content: [
              {
                type: 'text' as const,
                text:
                  '依頼した。デーモンが預かりを添付として、次の入力（あなた宛ての知らせ）で届ける。' +
                  `届いたファイルは /tmp/alteroid-attachments/${deps.managerId}/… に置かれるので、元の場所へ写すこと` +
                  '（元の場所に別の中身のファイルが在るなら、上書きする前に確かめる）。' +
                  '届かなければ、預かりが無いか、デーモンが古い。',
              },
            ],
          });
        },
      ),
      ...(attach === undefined
        ? []
        : [
            tool(
              REPORT_ATTACH_TOOL_NAME,
              '成果物のファイルを、ターンの終わりの報告に添える。名指ししたファイルを runner が開いて出し箱へ写す（`cp` で写さない）。' +
                '写せるのは自分の作業場（/tmp/mgr-<識別子の先頭8桁> と /tmp/mgr-<識別子の先頭8桁>-*）の下の、通常のファイルだけ（cwd の下は写せない）。' +
                '1件ずつ、写した名前と大きさ、または断った理由を返す。',
              {
                paths: z
                  .array(z.string().min(1).max(4096))
                  .min(1)
                  .max(REPORT_ATTACH_MAX_PATHS)
                  .describe(
                    '添えるファイルの絶対パス。`..`・symlink を含まない正規のパス。個数と合計の上限は添付と同じ',
                  ),
              },
              async (args) => {
                const results = await attach(args.paths);
                return {
                  content: [{ type: 'text' as const, text: renderReportAttachResults(results) }],
                  ...(results.some((r) => r.ok) ? {} : { isError: true }),
                };
              },
            ),
          ]),
    ],
  });
}
