import type { Options, Query, SDKMessage, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createClone } from './clone.js';
import { fakeSdk, waitForTerminal, wireEvents } from './clone-test-harness.js';
import { EXCHANGE_KIND_GAUGE_PREFIX } from './exchange-kind.js';
import { createRunnerHost, type RunnerHost } from './runner.js';
import { createLocalRunner } from './runner-local.js';
import { createRunnerRegistry, type RunnerEvent } from './runner-protocol.js';
import { createMemoryStores, humanMessage } from './testing.js';

// 失敗したターンの上限の判定 `for (const candidate of [failure.text, ...event.errorLines])` は clone.ts と runner.ts に写しがある。
// 2つを1つの関数へまとめる前後で、振る舞い（最初に当たった候補だけが1回出る・どれも当たらなければ出ない）が変わらないことを縛る。

// 種別が違う2つの文言を使う: 場面3で「どちらが採られたか」を kind と text で区別するため
const LIMIT_REACHED = "You've hit your weekly limit · resets Oct 20, 3am (UTC)";
const ORG_POLICY =
  "You've hit your org's monthly spend limit · ask your admin to raise it at claude.ai/settings/usage?from=cc_cli_limit_message";
const NOT_A_LIMIT_1 = '内部で何かが壊れた';
const NOT_A_LIMIT_2 = '別の理由で壊れた';

interface Scene {
  name: string;
  failureText: string;
  errorLines: string[];
}

const SCENES: Scene[] = [
  {
    name: '1 failure.text が当たる（errorLines は無い）',
    failureText: LIMIT_REACHED,
    errorLines: [],
  },
  {
    name: '2 failure.text は当たらず errorLines の2つ目で当たる',
    failureText: NOT_A_LIMIT_1,
    errorLines: [NOT_A_LIMIT_2, LIMIT_REACHED],
  },
  {
    name: '3 failure.text と errorLines の両方が当たる',
    failureText: LIMIT_REACHED,
    errorLines: [ORG_POLICY, ORG_POLICY],
  },
  {
    name: '4 どれも当たらない',
    failureText: NOT_A_LIMIT_1,
    errorLines: [NOT_A_LIMIT_2, 'もう1つ'],
  },
];

// --- clone 層 ---

async function runClone(scene: Scene) {
  const inner = fakeSdk(() => '本文', {
    resultFor: () => ({ subtype: 'error_during_execution', text: scene.failureText }),
  });
  // harness の result には `errors` を載せる口が無いので、queryFn を包んで足す
  const queryFn = ((params: { prompt: unknown; options?: Options }) => {
    const query = (inner.fn as unknown as (p: unknown) => Query)(params);
    async function* generate(): AsyncGenerator<SDKMessage, void> {
      for await (const message of query) {
        yield message.type === 'result'
          ? ({ ...message, errors: scene.errorLines } as unknown as SDKMessage)
          : message;
      }
    }
    return Object.assign(generate(), {
      close: () => query.close(),
      interrupt: async () => undefined,
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;

  const stores = createMemoryStores();
  const clone = createClone({
    inboxSettleMs: 0,
    reportSettleMs: 0,
    stores,
    queryFn,
    env: {},
    runners: createRunnerRegistry([
      createLocalRunner({ workspacePath: '/work', queryFn: fakeSdk().fn, env: {} }),
    ]),
  });
  const { events } = wireEvents(clone, 'conv-1');
  clone.post(humanMessage('やあ'));
  await waitForTerminal(events);

  const gauges = (
    (await stores.journal.list({ types: ['exchange'] })) as { text: string }[]
  ).filter((entry) => entry.text.startsWith(`${EXCHANGE_KIND_GAUGE_PREFIX}利用上限に当たった`));
  await clone.stop();
  return {
    usageLimited: events.flatMap((event) =>
      event.type === 'usage_limited' ? [event.message] : [],
    ),
    // 終端の error より先に届く（#settleFailedTurn の順序）。出ていない回は null
    usageLimitedBeforeError:
      events.findIndex((event) => event.type === 'usage_limited') < 0
        ? null
        : events.findIndex((event) => event.type === 'usage_limited') <
          events.findIndex((event) => event.type === 'error'),
    gaugeLines: gauges.map((entry) => entry.text),
  };
}

describe('クローンの #settleFailedTurn: 失敗したターンの上限の判定', () => {
  it.each(SCENES)('$name', async (scene) => {
    const result = await runClone(scene);
    expect(result).toMatchSnapshot();
  });
});

// --- runner 層 ---

function runnerFakeSdk(): { fn: typeof sdkQuery; finishFailed(r: Scene): Promise<void> } {
  const queue: (SDKMessage | null)[] = [];
  let wake: (() => void) | null = null;
  const push = (message: SDKMessage | null) => {
    queue.push(message);
    wake?.();
  };
  const fn = ((params: { prompt: unknown }) => {
    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: 'sess-mgr',
        uuid: 'uuid-init',
      } as unknown as SDKMessage;
      void (async () => {
        for await (const message of params.prompt as AsyncIterable<unknown>) void message;
        push(null);
      })();
      for (;;) {
        const next = queue.shift();
        if (next === null) return;
        if (next !== undefined) {
          yield next;
          continue;
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        wake = null;
      }
    }
    return Object.assign(generate(), {
      close: () => push(null),
      interrupt: async () => undefined,
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;
  return {
    fn,
    async finishFailed(scene) {
      push({
        type: 'result',
        subtype: 'error_during_execution',
        result: scene.failureText,
        errors: scene.errorLines,
        session_id: 'sess-mgr',
        uuid: 'uuid-result-1',
      } as unknown as SDKMessage);
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
  };
}

let hosts: RunnerHost[] = [];

afterEach(async () => {
  await Promise.all(hosts.map((host) => host.shutdown().catch(() => undefined)));
  hosts = [];
});

async function runRunner(scene: Scene) {
  const events: RunnerEvent[] = [];
  const sdk = runnerFakeSdk();
  const host = createRunnerHost({
    runnerId: 'runner-test',
    workspacePath: '/work/project',
    emit: (event) => events.push(event),
    queryFn: sdk.fn,
    env: { PATH: '/usr/bin' },
  });
  hosts.push(host);
  await host.start({ managerId: 'mgr-1', request: '走る', cwd: '/work/project' });
  await sdk.finishFailed(scene);
  // 失敗したターンの後始末が終わった印: 失敗の report が出る
  await vi.waitFor(() => {
    if (!events.some((event) => event.type === 'report')) throw new Error('報告がまだ無い');
  });
  // usage_notice は report より前に emit される（同じ #applyTurnEnded 内）ので、ここで数えてよい
  return {
    usageNotices: events.flatMap((event) =>
      event.type === 'usage_notice' ? [{ kind: event.notice.kind, text: event.notice.text }] : [],
    ),
  };
}

describe('runner の #applyTurnEnded: 失敗したターンの上限の判定', () => {
  it.each(SCENES)('$name', async (scene) => {
    const result = await runRunner(scene);
    expect(result).toMatchSnapshot();
  });
});
