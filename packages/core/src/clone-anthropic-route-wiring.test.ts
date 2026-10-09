import { describe, it, expect } from 'vitest';
import { ALWAYS_REDELIVER, createClone } from './clone.js';
import type { ManagerPool } from './manager.js';
import { RUNNER_ROUTE_UNREPORTED_LABEL } from './manager-models.js';
import { createRunnerRegistry } from './runner-protocol.js';
import { createLocalRunner } from './runner-local.js';
import type { SelfFacts } from './self.js';
import { ANTHROPIC_ROUTE_HEADING, RUNNER_ANTHROPIC_ROUTES_HEADING } from './self.js';
import { createCloneMcpServer, createCloneTools } from './tools.js';
import type { ToolContext } from './tools.js';
import { createMemoryStores, humanMessage } from './testing.js';
import { fakeSdk, waitForDone, wireEvents } from './clone-test-harness.js';

const SELF: SelfFacts = {
  storage: 's',
  local: 'l',
  workspace: 'w',
  cwd: 'c',
  runner: 'r',
  entrypoint: 'e',
  auth: 'a',
  models: { clone: 'opus' },
};

const FAKE_OAUTH = 'sk-fake-oauth-clone-0001';
const FAKE_AUTH = 'sk-fake-auth-clone-0002';

function poolWith(): ManagerPool {
  const base: ManagerPool = {
    start: () => {
      throw new Error('not implemented');
    },
    send: () => {
      throw new Error('not implemented');
    },
    abort: () => {
      throw new Error('not implemented');
    },
    list: () => Promise.resolve([]),
    denials: () => [],
    pushHealthOf: () => undefined,
    runnerBacklog: () => [],
    runnerIdOf: () => Promise.resolve(undefined),
    runners: () => {
      throw new Error('not implemented');
    },
    transcript: () => {
      throw new Error('not implemented');
    },
    unpushedWork: () => {
      throw new Error('not implemented');
    },
    runningManagerOwning: () => undefined,
    restore: () => Promise.resolve([]),
    resumeStoppedByUsage: () => Promise.resolve([]),
    reattachRunner: () => Promise.resolve(),
    relocateFrom: () => {
      throw new Error('not implemented');
    },
    vacate: () => {
      throw new Error('not implemented');
    },
    probeTurnEnds: () => Promise.resolve(),
    flushWithheldReports: () => Promise.resolve(),
    settleStalledUsageWakes: () => Promise.resolve([]),
    renotifyStalledDenials: () => Promise.resolve(),
    stop: () => Promise.resolve(),
  };
  return {
    ...base,
    runners: () =>
      Promise.resolve({
        runners: [
          { label: 'edge-1', state: 'connected', since: 'x', runnerId: 'r1' },
          { label: 'edge-2', state: 'connected', since: 'x', runnerId: 'r2' },
          { label: 'edge-3', state: 'connected', since: 'x', runnerId: 'r3' },
        ],
        unassigned: [],
      }) as unknown as ReturnType<ManagerPool['runners']>,
    runnerReportedAnthropicRoute: (runnerId) =>
      runnerId === 'r1'
        ? [
            '⚠️ ANTHROPIC_BASE_URL が https://gw.example.com を指している',
            'ANTHROPIC_MODEL=m（出所: 器）',
          ]
        : runnerId === 'r2'
          ? []
          : undefined,
  };
}

function boot(childEnvBase: NodeJS.ProcessEnv, credentials?: () => Record<string, string>) {
  const { fn } = fakeSdk();
  let captured: ToolContext | undefined;
  const clone = createClone({
    redeliveryGate: ALWAYS_REDELIVER,
    stores: createMemoryStores(),
    queryFn: fn,
    env: {},
    childEnvBase,
    ...(credentials === undefined ? {} : { credentials }),
    managers: poolWith(),
    self: SELF,
    runners: createRunnerRegistry([
      createLocalRunner({ workspacePath: '/work', queryFn: fakeSdk().fn, env: {} }),
    ]),
    mcpServerFactory: (context) => {
      captured = context;
      return createCloneMcpServer(context);
    },
  });
  const { events } = wireEvents(clone, 'conv-1');
  async function selfStatus(): Promise<string> {
    if (captured === undefined) throw new Error('ToolContext がまだ捕まっていない');
    const found = createCloneTools(captured).find((entry) => entry.name === 'self_status');
    if (!found) throw new Error('self_status が無い');
    const result = await found.handler({} as never, {});
    return (result.content ?? []).map((part) => ('text' in part ? part.text : '')).join('');
  }
  return { clone, events, selfStatus };
}

describe('クローン — SDK の接続先とモデルの別名の self_status（#4263・#4261）', () => {
  it('クローン自身の層の警告・事実・別名を、見出し＋字下げ2の行で出す。鍵の値は出さない', async () => {
    const s = boot(
      {
        ANTHROPIC_BASE_URL: 'https://user:sk-fake-pw@gw.example.com/v1?key=sk-fake-q',
        ANTHROPIC_DEFAULT_OPUS_MODEL: 'gpt-x',
      },
      () => ({ CLAUDE_CODE_OAUTH_TOKEN: FAKE_OAUTH }),
    );
    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);

    const body = await s.selfStatus();
    expect(body).toContain(ANTHROPIC_ROUTE_HEADING);
    expect(body).toContain('  ⚠️ ANTHROPIC_BASE_URL が https://gw.example.com を指している');
    expect(body).toContain('いま置かれている');
    expect(body).toContain('  ANTHROPIC_BASE_URL=https://gw.example.com（出所: 器）');
    expect(body).toContain(
      '  ANTHROPIC_DEFAULT_OPUS_MODEL=gpt-x（出所: 器）— 別名 opus の行き先が変わっている',
    );
    for (const secret of [FAKE_OAUTH, 'sk-fake-pw', 'sk-fake-q', '/v1']) {
      expect(body).not.toContain(secret);
    }
    await s.clone.stop();
  });

  it('接続先用の鍵が鍵のプールから降りていれば警告は出ない（出所は鍵のプール）', async () => {
    const s = boot({ ANTHROPIC_BASE_URL: 'https://gw.example.com' }, () => ({
      ANTHROPIC_AUTH_TOKEN: FAKE_AUTH,
    }));
    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);

    const body = await s.selfStatus();
    // runner の節には別途 ⚠️ の偽の名乗りが載るので、クローン自身の節だけを見る
    const own = body.split(ANTHROPIC_ROUTE_HEADING)[1]?.split('\n## ')[0] ?? '';
    expect(own).toContain('  ANTHROPIC_BASE_URL=https://gw.example.com（出所: 器）');
    expect(own).not.toContain('⚠️');
    expect(body).not.toContain(FAKE_AUTH);
    await s.clone.stop();
  });

  it('何も置かれていなければ、その旨の1行を出す（「無い」と「見ていない」を分ける）', async () => {
    const s = boot({});
    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);

    const body = await s.selfStatus();
    const section = body.split(ANTHROPIC_ROUTE_HEADING)[1]?.split('\n## ')[0] ?? '';
    expect(section).toContain(
      '  ANTHROPIC_BASE_URL / ANTHROPIC_DEFAULT_*_MODEL / ANTHROPIC_MODEL はどれも置かれていない',
    );
    await s.clone.stop();
  });

  it('runner の節は runner ごとに、名乗り・何も無し・名乗っていない（古い runner）を分けて出す', async () => {
    const s = boot({});
    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);

    const body = await s.selfStatus();
    expect(body).toContain(RUNNER_ANTHROPIC_ROUTES_HEADING);
    const section = body.split(RUNNER_ANTHROPIC_ROUTES_HEADING)[1] ?? '';
    expect(section).toContain('  runner edge-1:\n');
    expect(section).toContain('    ⚠️ ANTHROPIC_BASE_URL が https://gw.example.com を指している');
    expect(section).toContain('    ANTHROPIC_MODEL=m（出所: 器）');
    expect(section).toContain('  runner edge-2: ANTHROPIC_BASE_URL / ANTHROPIC_DEFAULT_*_MODEL');
    expect(section).toContain(`  runner edge-3: ${RUNNER_ROUTE_UNREPORTED_LABEL}`);
    await s.clone.stop();
  });

  it('新しい節の行は項目（行頭 `- `）にならない', async () => {
    const s = boot({ ANTHROPIC_BASE_URL: 'https://gw.example.com' });
    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);

    const body = await s.selfStatus();
    const tail = body.slice(body.indexOf(ANTHROPIC_ROUTE_HEADING));
    const routeLines = tail.split('\n').filter((line) => line.includes('ANTHROPIC_'));
    expect(routeLines.length).toBeGreaterThan(0);
    for (const line of routeLines) expect(line.startsWith('- ')).toBe(false);
    await s.clone.stop();
  });

  it('anthropicRoute() は env を作る重ねと同じ層を読み、後ろの層の出所を言う', () => {
    const s = boot({ ANTHROPIC_BASE_URL: 'https://a.example.com' }, () => ({
      ANTHROPIC_BASE_URL: 'https://b.example.com',
    }));
    const lines = s.clone.anthropicRoute?.() ?? [];
    expect(lines.join('\n')).toContain(
      'ANTHROPIC_BASE_URL=https://b.example.com（出所: 鍵のプール）',
    );
    void s.clone.stop();
  });
});
