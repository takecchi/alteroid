import type { Options, Query, SDKMessage, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it, vi } from 'vitest';

import type { AgentCloneDriver } from './agent-clone-session.js';
import type { AgentContextUsage } from './agent-session.js';
import { ClaudeCloneDriver } from './claude-clone-driver.js';
import { fakeSdk as fakeCloneSdk, waitForDone, wireEvents } from './clone-test-harness.js';
import { createClone } from './clone.js';
import { CONTEXT_USAGE_CATEGORY_LIMIT } from './context-usage.js';
import { createManagerPool } from './manager.js';
import { createLocalRunner } from './runner-local.js';
import { createRunnerRegistry } from './runner-protocol.js';
import type { Stores } from './store.js';
import { createMemoryStores, humanMessage } from './testing.js';

// clone.ts と runner.ts の `#observeContextUsage`（SDK の答えを ContextUsageObservation へ写す処理）の振る舞いを固定する。
// 観測は、clone は日誌の `context_usage` の行、runner は `turn_usage` / `context_usage` の `contextUsage` の値そのもの。
// `durationMs` は揺れるので、数値であることだけ確かめて固定から落とす。

const FULL: AgentContextUsage = {
  totalTokens: 12_000,
  rawMaxTokens: 200_000,
  percentage: 6,
  autoCompactThreshold: 180_000,
  isAutoCompactEnabled: true,
  categories: Array.from({ length: CONTEXT_USAGE_CATEGORY_LIMIT + 3 }, (_, i) => ({
    name: `cat-${i}`,
    tokens: 100 + i,
    kind: (['used', 'free', 'buffer', 'deferred'] as const)[i % 4]!,
  })),
  mcpTools: [
    { name: 'a1', serverName: 'alpha', tokens: 10 },
    { name: 'a2', serverName: 'alpha', tokens: 20 },
    { name: 'b1', serverName: 'beta', tokens: 50 },
    { name: 'x1', tokens: 5 },
  ],
  memoryFiles: [{ tokens: 7 }, { tokens: 8 }],
  systemPromptSections: [{ tokens: 100 }, { tokens: 200 }, { tokens: 300 }],
  messageBreakdown: {
    toolCallTokens: 30,
    toolResultTokens: 500,
    attachmentTokens: 4,
    assistantMessageTokens: 70,
    userMessageTokens: 20,
    toolCallsByType: [
      { name: 'Read', callTokens: 10, resultTokens: 100 },
      { name: 'Bash', callTokens: 20, resultTokens: 400 },
    ],
  },
};

const EMPTY = {
  totalTokens: 1_000,
  rawMaxTokens: 200_000,
  percentage: 0.5,
  isAutoCompactEnabled: false,
  categories: [],
  mcpTools: [],
  memoryFiles: [],
  systemPromptSections: [],
} as unknown as AgentContextUsage;

type Scene = 'full' | 'empty' | 'throws';

const SCENES: { scene: Scene; answer: () => Promise<AgentContextUsage> }[] = [
  { scene: 'full', answer: () => Promise.resolve(FULL) },
  { scene: 'empty', answer: () => Promise.resolve(EMPTY) },
  { scene: 'throws', answer: () => Promise.reject(new Error('観測に失敗（固定用）')) },
];

function expectDuration(value: unknown): Record<string, unknown> {
  const row = value as { durationMs?: unknown } & Record<string, unknown>;
  expect(typeof row.durationMs).toBe('number');
  const rest = { ...row };
  delete rest.durationMs;
  return rest;
}

async function cloneObservation(answer: () => Promise<AgentContextUsage>) {
  const { fn } = fakeCloneSdk();
  const inner = new ClaudeCloneDriver({ queryFn: fn });
  const driver: AgentCloneDriver = {
    providerId: 'claude',
    open: (spec) => {
      const session = inner.open(spec);
      return {
        readEvents: (onEvent) => session.readEvents(onEvent),
        interrupt: () => session.interrupt(),
        close: () => session.close(),
        contextUsage: answer,
        sessionModelUsage: () => session.sessionModelUsage(),
      };
    },
  };
  const stores = createMemoryStores();
  const clone = createClone({ stores, driver, env: {} });
  const { events } = wireEvents(clone, 'conv-1');
  clone.post(humanMessage('やあ'));
  await waitForDone(events);
  const rows = await stores.journal.list({ types: ['context_usage'] });
  await clone.stop();
  const row = rows[0];
  if (row?.type !== 'context_usage') throw new Error('context_usage の行が無い');
  return expectDuration(row.contextUsage);
}

function runnerSdk(answer: () => Promise<AgentContextUsage>) {
  let finish: (() => void) | undefined;
  const fn = ((params: { prompt: unknown; options?: Options }) => {
    let emit: ((message: SDKMessage | null) => void) | null = null;
    const buffered: SDKMessage[] = [];
    const push = (message: SDKMessage) => {
      if (emit) emit(message);
      else buffered.push(message);
    };
    finish = () =>
      push({
        type: 'result',
        subtype: 'success',
        result: 'できました',
        session_id: 'sess-mgr',
        uuid: 'uuid-result-1',
        modelUsage: {
          'claude-opus-5': {
            inputTokens: 10,
            outputTokens: 20,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            webSearchRequests: 0,
            costUSD: 1,
          },
        },
      } as unknown as SDKMessage);
    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: 'sess-mgr',
        uuid: 'uuid-init',
      } as unknown as SDKMessage;
      void (async () => {
        for await (const message of params.prompt as AsyncIterable<unknown>) void message;
      })();
      for (;;) {
        const next = buffered.shift();
        if (next !== undefined) {
          yield next;
          continue;
        }
        const message = await new Promise<SDKMessage | null>((resolve) => {
          emit = resolve;
        });
        emit = null;
        if (message === null) return;
        yield message;
      }
    }
    return Object.assign(generate(), {
      close: () => {
        if (emit) emit(null);
      },
      interrupt: async () => undefined,
      getContextUsage: answer,
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;
  return {
    fn,
    finish: () => {
      if (finish === undefined) throw new Error('セッションがまだ開いていない');
      finish();
    },
  };
}

async function runnerObservations(answer: () => Promise<AgentContextUsage>) {
  const sdk = runnerSdk(answer);
  const stores: Stores = createMemoryStores();
  const registry = createRunnerRegistry([
    createLocalRunner({
      runnerId: 'runner-test',
      workspacePath: '/work/project',
      queryFn: sdk.fn,
      env: { PATH: '/usr/bin' },
    }),
  ]);
  const pool = createManagerPool({
    stores,
    post: () => undefined,
    runners: registry,
    synthesizedNoticeWindowMs: 100,
  });
  await pool.start({ request: '調べて' });
  await vi.waitFor(() => {
    sdk.finish();
  });
  const usage = await vi.waitFor(async () => {
    const found = await stores.journal.list({ types: ['turn_usage'] });
    const row = found[0];
    if (row?.type !== 'turn_usage') throw new Error('turn_usage がまだ日誌に無い');
    return row;
  });
  const context = await vi.waitFor(async () => {
    const found = await stores.journal.list({ types: ['context_usage'] });
    const row = found[0];
    if (row?.type !== 'context_usage') throw new Error('context_usage がまだ日誌に無い');
    return row;
  });
  await pool.stop();
  return {
    turnUsage: expectDuration(usage.contextUsage),
    contextUsage: expectDuration(context.contextUsage),
  };
}

describe('文脈占有の観測の写し（clone と runner の #observeContextUsage）', () => {
  for (const { scene, answer } of SCENES) {
    it(`clone: ${scene}`, async () => {
      expect(await cloneObservation(answer)).toMatchSnapshot();
    });

    it(`runner: ${scene}`, async () => {
      const seen = await runnerObservations(answer);
      expect(seen.turnUsage).toEqual(seen.contextUsage);
      expect(seen.contextUsage).toMatchSnapshot();
    });
  }
});
