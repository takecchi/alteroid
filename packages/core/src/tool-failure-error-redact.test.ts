import type {
  HookJSONOutput,
  Options,
  Query,
  SDKMessage,
  query as sdkQuery,
} from '@anthropic-ai/claude-agent-sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { makeTempDirSync } from '../../../vitest.tmpdir.js';

import { setup as setupClone, waitForDone } from './clone-test-harness.js';
import type { FakeCall } from './clone-test-harness.js';
import { createRunnerHost, type RunnerHost } from './runner.js';
import type { RunnerEvent } from './runner-protocol.js';
import { humanMessage } from './testing.js';
import { MCP_INPUT_VALIDATION_ERROR_MARKER, qualifiedToolName } from './tools.js';

const FAKE_TOKEN = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8';
const FAKE_URL_PASSWORD = 'hunter2secretpw';
const LEAKY_ERROR =
  `exit code 1: git push https://x:${FAKE_URL_PASSWORD}@example.test/o/r.git failed; ` +
  `token=${FAKE_TOKEN}`;

function expectNoSecret(text: string | undefined): void {
  expect(text ?? '').not.toContain(FAKE_TOKEN);
  expect(text ?? '').not.toContain(FAKE_URL_PASSWORD);
}

describe('#2493 runner の #onPostToolUseFailure', () => {
  let dir: string;
  let host: RunnerHost | undefined;

  beforeEach(() => {
    dir = makeTempDirSync('alteroid-tool-failure-redact-');
  });
  afterEach(async () => {
    await host?.shutdown().catch(() => undefined);
  });

  it('note の error に、トークンも URL のパスワードも残らない', async () => {
    const events: RunnerEvent[] = [];
    let options: Options | undefined;
    const fn = ((input: { options: Options }) => {
      options = input.options;
      let finish: () => void = () => undefined;
      async function* generate(): AsyncGenerator<SDKMessage, void> {
        yield {
          type: 'system',
          subtype: 'init',
          session_id: 'sess-1',
          uuid: 'uuid-1',
        } as unknown as SDKMessage;
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
      }
      return Object.assign(generate(), {
        close: () => finish(),
        interrupt: async () => undefined,
      }) as unknown as Query;
    }) as unknown as typeof sdkQuery;
    host = createRunnerHost({
      runnerId: 'runner-test',
      workspacePath: dir,
      emit: (event) => events.push(event),
      queryFn: fn,
      env: {},
    });
    await host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });

    const hook = options?.hooks?.PostToolUseFailure?.[0]?.hooks?.[0];
    if (hook === undefined) throw new Error('PostToolUseFailure フックが登録されていない');
    const result: HookJSONOutput = await hook(
      {
        hook_event_name: 'PostToolUseFailure',
        tool_name: 'Bash',
        tool_input: { command: 'git push' },
        tool_use_id: 'tu-1',
        error: LEAKY_ERROR,
      } as never,
      undefined,
      { signal: new AbortController().signal },
    );
    expect(result).toEqual({ continue: true });

    const notes = events.filter(
      (event): event is Extract<RunnerEvent, { type: 'note' }> =>
        event.type === 'note' && event.text.startsWith('tool_use_failure:'),
    );
    expect(notes).toHaveLength(1);
    expect(notes[0]?.text).toContain('exit code 1');
    expectNoSecret(notes[0]?.text);
  });
});

describe('#2493 clone の日誌', () => {
  it('#journalToolUseFailure: 失敗した道具の error にトークンも URL のパスワードも残らない', async () => {
    const s = setupClone();
    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);

    const hook = (s.calls[0] as FakeCall).options.hooks?.PostToolUseFailure?.[0]?.hooks?.[0];
    if (hook === undefined) throw new Error('PostToolUseFailure フックが登録されていない');
    await hook(
      { tool_name: 'Bash', tool_input: { command: 'git push' }, error: LEAKY_ERROR } as never,
      undefined,
      {} as never,
    );

    const entries = await s.stores.journal.list({ types: ['tool_use'] });
    expect(entries.length).toBe(1);
    const entry = entries[0] as { outcome?: string; error?: string };
    expect(entry.outcome).toBe('failed');
    expect(entry.error).toContain('exit code 1');
    expectNoSecret(entry.error);

    await s.clone.stop();
  });

  it('入力検証で落ちた回の validation.message にトークンも URL のパスワードも残らない', async () => {
    const s = setupClone();
    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);

    const hook = (s.calls[0] as FakeCall).options.hooks?.PostToolUse?.[0]?.hooks?.[0];
    if (hook === undefined) throw new Error('PostToolUse フックが登録されていない');
    await hook(
      {
        tool_name: qualifiedToolName('memory_write'),
        tool_input: { slug: 'values', content: '本文' },
        tool_response: {
          content: [
            {
              type: 'text',
              text:
                `MCP error -32602: ${MCP_INPUT_VALIDATION_ERROR_MARKER}memory_write: ` +
                `[{"code":"invalid_type","path":["summary"],"message":${JSON.stringify(LEAKY_ERROR)}}]`,
            },
          ],
          isError: true,
        },
      } as never,
      undefined,
      {} as never,
    );

    const entries = await s.stores.journal.list({ types: ['tool_use'] });
    expect(entries.length).toBe(1);
    const entry = entries[0] as { outcome?: string; error?: string };
    expect(entry.outcome).toBe('failed');
    expect(entry.error).toContain(MCP_INPUT_VALIDATION_ERROR_MARKER);
    expectNoSecret(entry.error);

    await s.clone.stop();
  });
});
