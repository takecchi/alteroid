import type { query as sdkQuery, Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, describe, expect, it } from 'vitest';

import { MIRROR_EVENT_MAX_CHARS } from './mirror-chunks.js';
import { createRunnerHost, type RunnerHost } from './runner.js';
import type { RunnerEvent } from './runner-protocol.js';

function fakeSdk(): { fn: typeof sdkQuery; options: Options[] } {
  const options: Options[] = [];
  const fn = ((params: { prompt: unknown; options?: Options }) => {
    options.push(params.options ?? {});
    let finish: (() => void) | null = null;
    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: 'sess-mirror-chunks',
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
  return { events, opts };
}

function entry(text: string, n: number) {
  return {
    type: 'user',
    uuid: `u-${n}`,
    message: { role: 'user', content: [{ type: 'text', text }] },
  };
}

describe('runner は生ログの書き出しを、1件あたりの大きさに上限を付けた mirror に分けて送る（#4485）', () => {
  it('合計が上限を超える書き出しは、順を保った複数の mirror になり、どれも上限を超えない', async () => {
    const { events, opts } = await boot('mgr-mirror-chunks');
    // 合計 約 8MB（本番では 84MB の1件が、デーモンのループを 1.6 秒塞いだ）
    const entries = Array.from({ length: 80 }, (_, n) => entry('x'.repeat(100_000), n));

    await opts.sessionStore!.append({ projectKey: 'p', sessionId: 's' }, entries as never);

    const mirrors = events.filter(
      (event): event is Extract<RunnerEvent, { type: 'mirror' }> => event.type === 'mirror',
    );
    expect(mirrors.length).toBeGreaterThan(1);
    for (const mirror of mirrors) {
      expect(JSON.stringify(mirror.entries).length).toBeLessThanOrEqual(MIRROR_EVENT_MAX_CHARS);
      expect(mirror.key).toEqual({ projectKey: 'p', sessionId: 's' });
    }
    expect(mirrors.flatMap((mirror) => mirror.entries)).toEqual(entries);
  });

  it('対照: 上限に収まる書き出しは、今までどおり1件の mirror で送る', async () => {
    const { events, opts } = await boot('mgr-mirror-small');
    const entries = [entry('a', 0), entry('b', 1)];

    await opts.sessionStore!.append({ projectKey: 'p', sessionId: 's' }, entries as never);

    const mirrors = events.filter((event) => event.type === 'mirror');
    expect(mirrors).toHaveLength(1);
  });
});
