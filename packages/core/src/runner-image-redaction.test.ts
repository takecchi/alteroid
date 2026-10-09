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

const B64 = Buffer.from('PNG-BYTES-FOR-4127-RUNNER-WIRING-'.repeat(4)).toString('base64');
const imageEntry = {
  type: 'user',
  message: {
    role: 'user',
    content: [
      { type: 'text', text: '見て' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: B64 } },
    ],
  },
  uuid: 'u-image',
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
        session_id: 'sess-image-redaction',
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
  dir = makeTempDirSync('alteroid-image-redaction-');
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
  });
  hosts.push(host);
  await host.start({ managerId, request: '調べて', cwd: '/work/project' });
  const opts = options[0];
  if (opts === undefined) throw new Error('セッションが開いていない');
  return { events, host, opts };
}

describe('runner は画像の中身を生ログの入口へ流さない（#4127）', () => {
  it('mirror: sessionStore.append に画像入りの entry を流しても、emit される entries に base64 が無い', async () => {
    const { events, opts } = await boot('mgr-image-mirror');
    await opts.sessionStore!.append({ projectKey: 'p', sessionId: 's' }, [imageEntry as never]);

    const mirror = events.find(
      (event): event is Extract<RunnerEvent, { type: 'mirror' }> => event.type === 'mirror',
    );
    if (mirror === undefined) throw new Error('mirror が emit されていない');
    const json = JSON.stringify(mirror.entries);
    expect(json).not.toContain(B64);
    expect(json).toContain('[画像の控え] type=image/png');
    expect(json).toContain('見て');
  });

  it('archive と transcript(): transcript ファイルの画像行は、返す本文・archive の本文で控えになる', async () => {
    const { events, host, opts } = await boot('mgr-image-archive');
    const plain = JSON.stringify({ type: 'assistant', message: { content: [] } });
    const transcriptPath = join(dir, 'transcript.jsonl');
    writeFileSync(transcriptPath, `${plain}\n${JSON.stringify(imageEntry)}\n`, 'utf8');
    const hook = opts.hooks?.PostToolUse?.[0]?.hooks?.[0] as HookCallback | undefined;
    if (hook === undefined) throw new Error('PostToolUse フックが登録されていない');
    await hook(
      { tool_name: 'Bash', tool_input: {}, transcript_path: transcriptPath } as never,
      undefined,
      { signal: new AbortController().signal } as never,
    );

    const live = await host.transcript('mgr-image-archive');
    expect(live).not.toBeNull();
    expect(live).not.toContain(B64);
    expect(live?.split('\n')[0]).toBe(plain);

    await host.stop('mgr-image-archive');
    const archive = events.find(
      (event): event is Extract<RunnerEvent, { type: 'archive' }> => event.type === 'archive',
    );
    if (archive === undefined) throw new Error('archive が emit されていない');
    expect(archive.body).not.toContain(B64);
    expect(archive.body).toContain('[画像の控え] type=image/png');
    expect(archive.body.split('\n')[0]).toBe(plain);
  });
});
