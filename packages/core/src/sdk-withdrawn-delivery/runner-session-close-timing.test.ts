import { fileURLToPath } from 'node:url';

import type { Options, Query, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, describe, expect, it } from 'vitest';

import { makeTempDirSync } from '../../../../vitest.tmpdir.js';

import { createRunnerHost, type RunnerHost } from '../runner.js';
import type { RunnerEvent } from '../runner-protocol.js';

import {
  assertHealthyFakeCliExit,
  controlResponseDelivered,
  waitForFakeCliExit,
} from './log-wait.js';

const FAKE_CLI_PATH = fileURLToPath(new URL('./fake-cli.mjs', import.meta.url));

function wrapQueryFnForFakeCli(logPath: string): typeof sdkQuery {
  return ((params: { prompt: unknown; options?: Options }): Query => {
    const options = params.options ?? {};
    return query({
      prompt: params.prompt as never,
      options: {
        ...options,
        pathToClaudeCodeExecutable: FAKE_CLI_PATH,
        env: {
          ...(options.env ?? process.env),
          FAKE_CLI_LOG: logPath,
          FAKE_CLI_ASK_REQUEST_ID: 'ask-1',
        },
      },
    });
  }) as unknown as typeof sdkQuery;
}

let hosts: RunnerHost[] = [];

afterEach(async () => {
  await Promise.all(hosts.map((host) => host.shutdown().catch(() => undefined)));
  hosts = [];
});

describe('RunnerSession を通した stop(): settled.withdrawn と「CLI へ届かない」が一致する（#1586 / #1596）', () => {
  it('stop() で畳むと、settled に withdrawn(reason) が載り、かつその回の control_response は偽 CLI に届かない', async () => {
    const dir = makeTempDirSync('sdk-withdrawn-delivery-runner-');
    const logPath = `${dir}/fake-cli.log`;
    const events: RunnerEvent[] = [];

    let resolveAsk: (() => void) | null = null;
    const askSeen = new Promise<void>((resolve) => {
      resolveAsk = resolve;
    });

    const host = createRunnerHost({
      runnerId: 'runner-sdk-withdrawn-delivery-test',
      workspacePath: dir,
      emit: (event) => {
        events.push(event);
        if (event.type === 'ask') resolveAsk?.();
      },
      queryFn: wrapQueryFnForFakeCli(logPath),
      permissionMode: 'default',
    });
    hosts.push(host);

    await host.start({ managerId: 'mgr-withdrawn-delivery', request: '調べて', cwd: dir });

    await askSeen;

    await host.stop('mgr-withdrawn-delivery');

    const settledEvent = events.find(
      (event): event is Extract<RunnerEvent, { type: 'settled' }> => event.type === 'settled',
    );
    expect(settledEvent).toBeDefined();
    expect(settledEvent?.withdrawn?.reason).toBeTruthy();

    const log = await waitForFakeCliExit(logPath);
    assertHealthyFakeCliExit(log);

    expect(
      controlResponseDelivered(log),
      'SDK の内部が変わった。#1596 の withdrawn の前提（settle → close() を await なしで並べると ' +
        'control_response が CLI へ届かない）を見直せ。',
    ).toBe(false);
  }, 10_000);
});
