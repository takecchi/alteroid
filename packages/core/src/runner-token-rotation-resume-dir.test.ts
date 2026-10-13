import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import type {
  HookCallback,
  Options,
  Query,
  SDKMessage,
  query as sdkQuery,
} from '@anthropic-ai/claude-agent-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeTempDirSync } from '../../../vitest.tmpdir.js';

import { createCredentialStore } from './credentials.js';
import { createRunnerHost, type RunnerHost } from './runner.js';
import type { RunnerEvent } from './runner-protocol.js';

// 器の入れ替えの後に生ログから戻した担当は、SDK が作る resume の一時ディレクトリ（`os.tmpdir()/claude-resume-*`）で会話を書き続ける。
// その一時ディレクトリは CLI が終わると SDK が消すので、鍵の回転で畳んで同じ id で開き直すと「No conversation found with session ID」で落ちていた（2026-10-13T03:57Z、2本）。

type Behavior = 'answer' | 'no-conversation';

interface Started {
  options: Options;
  loaded: Promise<unknown>;
  inputs: string[];
}

function fakeSdk(behaviors: readonly Behavior[], transcriptPath: () => string | undefined) {
  const started: Started[] = [];
  let seq = 0;

  const fn = ((params: { prompt: unknown; options?: Options }) => {
    const options = params.options ?? {};
    const index = started.length;
    const behavior = behaviors[index] ?? 'answer';
    const label = options.resume ?? `sess-${String(index + 1)}`;
    // 本物の SDK と同じく、resume のときは開く前に材料を1回だけ引く
    const loaded =
      options.resume !== undefined && options.sessionStore !== undefined
        ? Promise.resolve(options.sessionStore.load({ projectKey: 'p', sessionId: options.resume }))
        : Promise.resolve(undefined);
    const inputs: string[] = [];
    started.push({ options, loaded, inputs });

    async function* generate(): AsyncGenerator<SDKMessage, void> {
      await loaded;
      if (behavior === 'no-conversation') {
        yield {
          type: 'result',
          subtype: 'error_during_execution',
          is_error: true,
          errors: [`No conversation found with session ID: ${label}`],
          session_id: label,
          uuid: `uuid-result-${String(++seq)}`,
        } as unknown as SDKMessage;
        return;
      }
      yield {
        type: 'system',
        subtype: 'init',
        session_id: label,
        uuid: `uuid-init-${String(++seq)}`,
      } as unknown as SDKMessage;
      const iterator = (params.prompt as AsyncIterable<{ message: { content: unknown } }>)[
        Symbol.asyncIterator
      ]();
      for (;;) {
        const next = await iterator.next();
        if (next.done === true) return;
        inputs.push(JSON.stringify(next.value.message.content));
        const path = transcriptPath();
        if (path !== undefined) {
          const hook = options.hooks?.PostToolUse?.[0]?.hooks?.[0] as HookCallback | undefined;
          await hook?.(
            { tool_name: 'Bash', tool_input: {}, transcript_path: path } as never,
            undefined,
            { signal: new AbortController().signal } as never,
          );
        }
        yield {
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text: '済んだ' }] },
          parent_tool_use_id: null,
          session_id: label,
          uuid: `uuid-say-${String(++seq)}`,
        } as unknown as SDKMessage;
        yield {
          type: 'result',
          subtype: 'success',
          result: '済んだ',
          session_id: label,
          uuid: `uuid-result-${String(++seq)}`,
        } as unknown as SDKMessage;
      }
    }

    return Object.assign(generate(), {
      close: () => undefined,
      interrupt: async () => undefined,
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;

  return { fn, started };
}

const TRANSCRIPT_ENTRIES = [
  { type: 'user', message: { role: 'user', content: 'PR を作って' } },
  { type: 'assistant', message: { role: 'assistant', content: 'PR #77 を作った' } },
];

let dir: string;
let hosts: RunnerHost[] = [];

beforeEach(() => {
  dir = makeTempDirSync('alteroid-runner-rotation-resume-dir-');
});

afterEach(async () => {
  await Promise.all(hosts.map((host) => host.shutdown().catch(() => undefined)));
  hosts = [];
});

function writeTranscript(configDir: string, sessionId: string): string {
  const projectDir = join(configDir, 'projects', 'p');
  mkdirSync(projectDir, { recursive: true });
  const path = join(projectDir, `${sessionId}.jsonl`);
  writeFileSync(
    path,
    TRANSCRIPT_ENTRIES.map((entry) => JSON.stringify(entry)).join('\n') + '\n',
    'utf8',
  );
  return path;
}

async function startAndRotate(behaviors: readonly Behavior[], configDir: string) {
  const events: RunnerEvent[] = [];
  const path = writeTranscript(configDir, 'sess-1');
  const { fn, started } = fakeSdk(behaviors, () => path);
  const host = createRunnerHost({
    runnerId: 'runner-test',
    workspacePath: '/work/project',
    emit: (event) => events.push(event),
    queryFn: fn,
    env: { PATH: '/usr/bin' },
    credentials: createCredentialStore({
      dir: join(dir, 'creds'),
      seed: { CLAUDE_CODE_OAUTH_TOKEN: 'token-fake-old-000' },
      names: ['CLAUDE_CODE_OAUTH_TOKEN'],
    }),
    outboxRoot: join(dir, 'outbox'),
    outboxStagedRoot: join(dir, 'outbox-staged'),
  });
  hosts.push(host);

  await host.start({ managerId: 'mgr-1', request: 'PR を作って', cwd: '/work/project' });
  await vi.waitFor(() => {
    if (!events.some((event) => event.type === 'report')) throw new Error('1ターン目の報告待ち');
  });

  await host.setCredentials([{ name: 'CLAUDE_CODE_OAUTH_TOKEN', value: 'token-fake-new-111' }]);
  await vi.waitFor(() => {
    if (started.length < 2) throw new Error('開き直し待ち');
  });
  return { host, events, started };
}

describe('鍵の回転で開き直すとき、resume の一時ディレクトリで動いていた会話を失わない', () => {
  it('入力を閉じる前に一時ディレクトリの生ログを読み、開き直しの resume の材料として渡す', async () => {
    const configDir = makeTempDirSync('claude-resume-test-');
    const { started } = await startAndRotate(['answer', 'answer'], configDir);

    expect(started[1]?.options.resume).toBe('sess-1');
    expect(await started[1]?.loaded).toEqual(TRANSCRIPT_ENTRIES);
  });

  it('それでも会話が見つからなければ failed にせず、生ログを引き継いだ新しいセッションで続ける', async () => {
    const configDir = makeTempDirSync('claude-resume-test-');
    const { events, started } = await startAndRotate(
      ['answer', 'no-conversation', 'answer'],
      configDir,
    );

    await vi.waitFor(() => {
      if (started.length < 3) throw new Error('後継のセッション待ち');
    });
    expect(started[2]?.options.resume).toBeUndefined();
    await vi.waitFor(() => {
      if ((started[2]?.inputs.length ?? 0) === 0) throw new Error('引き継ぎの一言待ち');
    });
    expect(started[2]?.inputs[0]).toContain('PR #77 を作った');

    const resumeFailed = events.filter((event) => event.type === 'resume_failed');
    expect(resumeFailed).toHaveLength(1);
    expect(resumeFailed[0]).toMatchObject({ sessionId: 'sess-1', recovered: true });
    expect(events.some((event) => event.type === 'closed')).toBe(false);
  });

  it('子の設定ディレクトリ（一時ディレクトリの外）の生ログは材料に渡さない（会話はそこに残っていて見つかる）', async () => {
    const { started } = await startAndRotate(['answer', 'answer'], join(dir, 'home', '.claude'));

    expect(started[1]?.options.resume).toBe('sess-1');
    expect(await started[1]?.loaded).toBeNull();
  });
});
