import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type {
  query as sdkQuery,
  HookCallback,
  Options,
  Query,
  SDKMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { makeTempDirSync } from '../../../vitest.tmpdir.js';

import { createRunnerHost, type RunnerHost } from './runner.js';
import type { RunnerEvent } from './runner-protocol.js';

// ダミーの値（本物の鍵ではない）。名前が秘密に見える変数として子へ渡る
const SECRET_NAME = 'ALTEROID_TEST_DUMMY_API_KEY';
const SECRET_VALUE = 'dummy-secret-value-for-6864-0123456789';

const envOutputEntry = {
  type: 'user',
  message: {
    role: 'user',
    content: [
      {
        type: 'tool_result',
        tool_use_id: 'tu-env',
        content: `HOME=/home/x\n${SECRET_NAME}=${SECRET_VALUE}\n`,
      },
    ],
  },
  uuid: 'u-env',
};

function fakeSdk(): { fn: typeof sdkQuery; options: Options[] } {
  const options: Options[] = [];
  const fn = ((params: { prompt: unknown; options?: Options }) => {
    options.push(params.options ?? {});
    let finish: (() => void) | null = null;
    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: 'sess-secret-redaction',
        uuid: 'uuid-init',
      } as unknown as SDKMessage;
      void (async () => {
        for await (const message of params.prompt as AsyncIterable<unknown>) void message;
      })();
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    }
    return Object.assign(generate(), {
      close: () => finish?.(),
      interrupt: async () => undefined,
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;
  return { fn, options };
}

let hosts: RunnerHost[] = [];
let dir: string;

beforeEach(() => {
  dir = makeTempDirSync('alteroid-secret-value-redaction-');
});

afterEach(async () => {
  await Promise.all(hosts.map((host) => host.shutdown().catch(() => undefined)));
  hosts = [];
});

async function boot(managerId: string) {
  const events: RunnerEvent[] = [];
  const { fn, options } = fakeSdk();
  const host = createRunnerHost({
    runnerId: `runner-${managerId}`,
    workspacePath: '/work/project',
    emit: (event) => events.push(event),
    queryFn: fn,
    env: { [SECRET_NAME]: SECRET_VALUE },
  });
  hosts.push(host);
  await host.start({ managerId, request: '調べて', cwd: '/work/project' });
  const opts = options[0];
  if (opts === undefined) throw new Error('セッションが開いていない');
  return { events, host, opts };
}

async function pointAt(opts: Options, path: string): Promise<void> {
  const hook = opts.hooks?.PostToolUse?.[0]?.hooks?.[0] as HookCallback | undefined;
  if (hook === undefined) throw new Error('PostToolUse フックが登録されていない');
  await hook({ tool_name: 'Bash', tool_input: {}, transcript_path: path } as never, undefined, {
    signal: new AbortController().signal,
  } as never);
}

describe('runner は子が持つ秘密の値を生ログの写しへ流さない（#6864）', () => {
  it('前提: その値は子の環境に渡っている（渡っていなければこの試験は何も測らない）', async () => {
    const { opts } = await boot('mgr-secret-premise');
    expect(opts.env?.[SECRET_NAME]).toBe(SECRET_VALUE);
  });

  it('mirror: Bash の出力に載った値は、emit される entries で印になる', async () => {
    const { events, opts } = await boot('mgr-secret-mirror');
    await opts.sessionStore!.append({ projectKey: 'p', sessionId: 's' }, [envOutputEntry as never]);
    await opts.sessionStore!.append(
      { projectKey: 'p', sessionId: 's', subpath: 'subagents/agent-1' },
      [envOutputEntry as never],
    );

    const mirrors = events.filter(
      (event): event is Extract<RunnerEvent, { type: 'mirror' }> => event.type === 'mirror',
    );
    expect(mirrors).toHaveLength(2);
    for (const mirror of mirrors) {
      const json = JSON.stringify(mirror.entries);
      expect(json).not.toContain(SECRET_VALUE);
      expect(json).toContain(`${SECRET_NAME}=[redacted:env:${SECRET_NAME}]`);
      expect(json).toContain('HOME=/home/x');
    }
  });

  it('transcript()・transcriptTail()・archive: 生ログのファイルの値は、返す本文で印になる', async () => {
    const { events, host, opts } = await boot('mgr-secret-archive');
    const plain = JSON.stringify({ type: 'assistant', message: { content: [] } });
    const path = join(dir, 'transcript.jsonl');
    writeFileSync(path, `${plain}\n${JSON.stringify(envOutputEntry)}\n`, 'utf8');
    await pointAt(opts, path);

    const live = await host.transcript('mgr-secret-archive');
    if (live === null) throw new Error('全文が読めない');
    expect(live).not.toContain(SECRET_VALUE);
    expect(live).toContain(`[redacted:env:${SECRET_NAME}]`);
    expect(live.split('\n')[0]).toBe(plain);

    const tail = await host.transcriptTail('mgr-secret-archive', 40);
    expect(tail).toBe(live.slice(-41));
    expect(await host.transcriptTail('mgr-secret-archive', 100_000)).toBe(live);

    await host.stop('mgr-secret-archive');
    const archive = events.find(
      (event): event is Extract<RunnerEvent, { type: 'archive' }> => event.type === 'archive',
    );
    const body =
      archive?.ref === undefined
        ? undefined
        : host.readArchive('mgr-secret-archive', archive.ref.id);
    if (body === undefined) throw new Error('archive の本文が預けられていない');
    expect(body).not.toContain(SECRET_VALUE);
    expect(body).toContain(`[redacted:env:${SECRET_NAME}]`);
  });
});
