import type {
  ModelUsage,
  Options,
  Query,
  SDKMessage,
  query as sdkQuery,
} from '@anthropic-ai/claude-agent-sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { makeTempDirSync } from '../../../vitest.tmpdir.js';

import { createRunnerHost, type RunnerHost } from './runner.js';
import type { RunnerEvent } from './runner-protocol.js';

// `RunnerSession` が `RunnerFailureClassifier` を呼ぶ所（呼び元 `#applyTurnEnded` の 1 文）を縛る。
// `runner-failure-classify-pin.test.ts`（切り出し前の作りの出力）が縛っていなかった 2 枝を足す:
//   (1) 呼ぶ位置: `#emitAnsweredUsage`（`usage`）の後・`report` の前。成功扱いの結果（assistant.error で止まった回）で、`usage` → `usage_notice` → `report` の順。
//   (2) 呼び元が `await` を足さない・口を `async` で包まない: 3 つの出来事が見える周回数。
// 期待の値は切り出し後の作りの出力を目で読んで置いた（仕様を先に書いたものではない）。実時間では待たない。
// フェイクの SDK と rig は pin のものと同じ形（pin は変えないので写した）。

const ORG_SPEND_LIMIT =
  "You've hit your org's monthly spend limit · ask your admin to raise it at claude.ai/settings/usage?from=cc_cli_limit_message";

interface Started {
  options: Options;
  push: (message: SDKMessage) => void;
  finish: () => void;
}

function fakeRunnerSdk(): { fn: typeof sdkQuery; started: Started[] } {
  const started: Started[] = [];
  const fn = ((input: { options: Options }) => {
    let emit: ((message: SDKMessage | null) => void) | null = null;
    const buffered: SDKMessage[] = [];
    const record: Started = {
      options: input.options,
      finish: () => emit?.(null),
      push: (message) => {
        if (emit) {
          const resolve = emit;
          emit = null;
          resolve(message);
        } else {
          buffered.push(message);
        }
      },
    };
    started.push(record);
    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: `sess-${started.length}`,
        uuid: `uuid-${started.length}`,
      } as unknown as SDKMessage;
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
      close: () => record.finish(),
      interrupt: async () => undefined,
      applyFlagSettings: async () => undefined,
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;
  return { fn, started };
}

let dir: string;
let host: RunnerHost | undefined;

beforeEach(() => {
  dir = makeTempDirSync('alteroid-runner-failure-classify-wiring-');
});

afterEach(async () => {
  await host?.shutdown().catch(() => undefined);
  host = undefined;
});

interface Rig {
  started: Started;
  events: RunnerEvent[];
}

async function open(): Promise<Rig> {
  const events: RunnerEvent[] = [];
  const { fn, started } = fakeRunnerSdk();
  host = createRunnerHost({
    runnerId: 'runner-test',
    workspacePath: dir,
    emit: (event) => events.push(event),
    queryFn: fn,
    env: {},
  });
  await host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
  const first = started[0];
  if (first === undefined) throw new Error('セッションが開いていない');
  events.length = 0;
  return { started: first, events };
}

function modelUsage(): Record<string, ModelUsage> {
  return {
    'claude-opus-5': {
      inputTokens: 100,
      outputTokens: 100,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      webSearchRequests: 0,
      costUSD: 0.5,
      contextWindow: 200_000,
      maxOutputTokens: 64_000,
    },
  };
}

/** assistant.error で止まり、result は成功で返る回（使用量つき）。 */
function stoppedByLimit(rig: Rig): void {
  rig.started.push({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: ORG_SPEND_LIMIT }] },
    parent_tool_use_id: null,
    session_id: 'sess-mgr',
    uuid: 'uuid-say',
    error: 'billing_error',
  } as unknown as SDKMessage);
  rig.started.push({
    type: 'result',
    subtype: 'success',
    result: '',
    session_id: 'sess-mgr',
    uuid: 'uuid-result',
    modelUsage: modelUsage(),
  } as unknown as SDKMessage);
}

const KINDS = ['usage', 'usage_notice', 'report'] as const;

describe('呼び元 #applyTurnEnded の呼ぶ位置と周回', () => {
  it('usage → usage_notice → report の順で、それぞれが見える周回数', async () => {
    const rig = await open();
    stoppedByLimit(rig);
    const seenAt: Record<string, number> = {};
    for (let ticks = 0; ticks < 200 && Object.keys(seenAt).length < KINDS.length; ticks += 1) {
      await Promise.resolve();
      for (const event of rig.events) {
        if ((KINDS as readonly string[]).includes(event.type)) seenAt[event.type] ??= ticks;
      }
    }
    expect({
      order: rig.events.map((event) => event.type).filter((type) => type !== 'context_usage'),
      seenAt,
    }).toMatchInlineSnapshot(`
      {
        "order": [
          "session",
          "usage",
          "usage_notice",
          "report",
        ],
        "seenAt": {
          "report": 5,
          "usage": 5,
          "usage_notice": 5,
        },
      }
    `);
  });
});
