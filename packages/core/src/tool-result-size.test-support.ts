/**
 * 道具の返り値が会話の履歴（tool_result）へ積む字数を測る試験の補助（#5469 P8 前段）。
 *
 * 本物の道具サーバ（`createCloneMcpServer`）へ MCP Client から呼んで、返った本文を測る。
 * 偽データ（`FixtureConfig`）の本文は同じ日本語文の繰り返しなので、トークン近似は実文より大きめに出うる。
 * 上限は各道具の予算（`tools.ts` の `*_BUDGET`・`*_PAGE` = 8,000 字）で決まる。
 *
 * **試験専用（本番へ出さない）。** `clone-test-harness.ts` 経由で vitest を引くので、本番の入口から辿れてはならない。
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { fakeSdk, waitFor } from './clone-test-harness.js';
import { createClone } from './clone.js';
import { seedTasks, seedJobs, seedJournal, seedMemory } from './context-size-fixtures.js';
import type { MemoryFixtureSize } from './context-size-fixtures.js';
import type { CloneHost } from './host.js';
import { createLocalRunner } from './runner-local.js';
import { createRunnerRegistry } from './runner-protocol.js';
import type { SelfFacts } from './self.js';
import type { Stores } from './store.js';
import { createMemoryStores, humanMessage } from './testing.js';
import { createCloneMcpServer } from './tools.js';
import type { ToolContext } from './tools.js';

/**
 * トークンの近似に使う UTF-8 のバイト数 / トークン。
 * 依存に実トークナイザが無いので近似である（日本語は 1 字 3 バイトで約 1〜1.5 トークン、英語は 1 バイト 1 字で約 4 字 1 トークン。混在なので ±30% は見込む）。
 */
const APPROX_BYTES_PER_TOKEN = 3;

export interface Size {
  chars: number;
  bytes: number;
  /** `bytes / APPROX_BYTES_PER_TOKEN` の切り上げ。実トークンではない。 */
  tokens: number;
}

function sizeOf(text: string): Size {
  const bytes = Buffer.byteLength(text, 'utf8');
  return { chars: text.length, bytes, tokens: Math.ceil(bytes / APPROX_BYTES_PER_TOKEN) };
}

export interface FixtureConfig {
  memory: MemoryFixtureSize;
  /** 待ち行列の未了の件数（最古は 30 日前）。 */
  tasks: number;
  /** 委譲（Job）の件数。 */
  jobs: number;
  /** 直近 24 時間の日誌の行数（digest の材料）。 */
  journalRows: number;
  /** 人間の発言の字数。 */
  humanChars: number;
  /** マネージャーの報告 1 件の字数（上限は 8,000）。 */
  reportChars: number;
}

const SELF_FACTS: SelfFacts = {
  storage: 'PostgreSQL（Railway）',
  local: '/data/alteroid（state のみ）',
  workspace: '/work',
  cwd: '/data/alteroid/clone',
  runner: 'ローカル runner 1 台',
  entrypoint: 'https://alteroid.example.invalid',
  auth: 'トークン認証',
  models: { clone: 'opus' },
};

async function buildStores(config: FixtureConfig, now: number): Promise<Stores> {
  const stores = createMemoryStores();
  await seedMemory(stores, config.memory);
  await seedTasks(stores, config.tasks, now);
  await stores.tasks.add({
    id: 'task-measure-00001',
    createdAt: new Date(now - 24 * 60 * 60 * 1000).toISOString(),
    updatedAt: new Date(now - 24 * 60 * 60 * 1000).toISOString(),
    status: 'queued',
    origin: 'self',
    title: '測りの入力に置く動ける task',
    body: '発意の門を通すための1件',
  });
  await seedJobs(stores, config.jobs, now);
  await seedJournal(stores, config.journalRows);
  await stores.schedules.put({
    kind: 'issue-round',
    spec: { type: 'daily', at: '09:00' },
    request: 'open issue を見て、着手できるものから進める',
    createdAt: new Date(now - 3 * 24 * 60 * 60 * 1000).toISOString(),
    updatedAt: new Date(now - 3 * 24 * 60 * 60 * 1000).toISOString(),
  });
  return stores;
}

interface BootedClone {
  clone: CloneHost;
  toolContext(): ToolContext | undefined;
}

function bootClone(stores: Stores): BootedClone {
  const { fn } = fakeSdk(() => 'ok', {
    getContextUsage: () => ({
      categories: [],
      totalTokens: 60_000,
      maxTokens: 1_000_000,
      rawMaxTokens: 1_000_000,
      percentage: 6,
      autoCompactThreshold: 900_000,
      isAutoCompactEnabled: true,
    }),
  });
  let captured: ToolContext | undefined;
  const clone = createClone({
    inboxSettleMs: 0,
    reportSettleMs: 0,
    stores,
    queryFn: fn,
    env: {},
    self: SELF_FACTS,
    runners: createRunnerRegistry([
      createLocalRunner({ workspacePath: '/work', queryFn: fakeSdk().fn, env: {} }),
    ]),
    mcpServerFactory: (context) => {
      captured = context;
      return createCloneMcpServer(context);
    },
  });
  return { clone, toolContext: () => captured };
}

export interface ToolCallSpec {
  name: string;
  args: Record<string, unknown>;
}

export interface ToolResultSample {
  call: ToolCallSpec;
  isError: boolean;
  /** 会話の履歴（tool_result）へ載る本文。 */
  result: Size;
  /** 呼び出し側（tool_use の入力）の JSON。 */
  callInput: Size;
}

/** 呼び出しは 1 回ずつ順に行い、状態を変える道具（task_set_status など）は呼び出しの並びの中で効く。 */
export async function measureToolResults(
  config: FixtureConfig,
  calls: readonly ToolCallSpec[],
): Promise<ToolResultSample[]> {
  const now = Date.now();
  const stores = await buildStores(config, now);
  const booted = bootClone(stores);
  try {
    booted.clone.post({
      ...humanMessage(
        `1 件目の依頼です。${'確認してもらえますか。'.repeat(Math.ceil(config.humanChars / 11))}`.slice(
          0,
          config.humanChars,
        ),
      ),
      id: 'evt-human-1',
      at: new Date().toISOString(),
    });
    await waitFor(() => booted.toolContext() !== undefined, 'ToolContext が捕まる');
    const server = createCloneMcpServer(booted.toolContext()!);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.instance.connect(serverSide);
    const client = new Client({ name: 'tool-result-size', version: '0' });
    await client.connect(clientSide);
    try {
      const samples: ToolResultSample[] = [];
      for (const call of calls) {
        const response = await client.callTool({ name: call.name, arguments: call.args });
        const body = (response.content as { type: string; text?: string }[])
          .map((block) => block.text ?? '')
          .join('');
        samples.push({
          call,
          isError: response.isError === true,
          result: sizeOf(body),
          callInput: sizeOf(JSON.stringify(call.args)),
        });
      }
      return samples;
    } finally {
      await client.close();
    }
  } finally {
    await booted.clone.stop();
  }
}
