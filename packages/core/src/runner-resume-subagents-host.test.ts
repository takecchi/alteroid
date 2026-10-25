import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Options, Query, SDKMessage, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeTempDirSync } from '../../../vitest.tmpdir.js';

import { toSessionStore } from './claude-manager-driver.js';
import { createRunnerHost, type RunnerHost, type RunnerHostOptions } from './runner.js';

// 担当の resume で、作業者（subagents/…）の記録も戻す（#5257）。戻し方は主の記録と同じ2経路:
// 子 UID の器は runner が子の設定ディレクトリへ自分で置き、そうでない器は SDK の `listSubkeys` + `load` で戻させる

const PROJECT_KEY = '-workspace';
const MAIN = [{ type: 'user', message: { role: 'user', content: '検査して' } }];
const META = { type: 'agent_metadata', agentType: 'worker' };
const WORKER = [{ type: 'user', message: { role: 'user', content: '調べて' } }];
const SUBAGENTS = [
  { subpath: 'subagents/agent-a1', entries: [META, ...WORKER] },
  { subpath: 'subagents/agent-b2', entries: WORKER },
];

// 本物の SDK と同じ順: 主を引き、材料が返れば `listSubkeys` の各 subpath を `load` する（返らなければ何もしない）
function fakeSdk() {
  const materialized: {
    main: unknown;
    sub: Record<string, unknown>;
    listed: string[] | undefined;
  }[] = [];
  const fn = ((params: { prompt: unknown; options?: Options }) => {
    const options = params.options ?? {};
    async function* generate(): AsyncGenerator<SDKMessage, void> {
      const store = options.sessionStore;
      if (options.resume !== undefined && store !== undefined) {
        const key = { projectKey: PROJECT_KEY, sessionId: options.resume };
        const main = await store.load(key);
        const sub: Record<string, unknown> = {};
        let listed: string[] | undefined;
        if (main !== null && main.length > 0 && store.listSubkeys !== undefined) {
          listed = await store.listSubkeys(key);
          for (const subpath of listed) sub[subpath] = await store.load({ ...key, subpath });
        }
        materialized.push({ main, sub, listed });
      }
      yield {
        type: 'system',
        subtype: 'init',
        session_id: options.resume ?? 'sess-new',
        uuid: 'uuid-init',
      } as unknown as SDKMessage;
      const iterator = (params.prompt as AsyncIterable<unknown>)[Symbol.asyncIterator]();
      await iterator.next();
      await iterator.next();
    }
    return Object.assign(generate(), {
      close: () => undefined,
      interrupt: async () => undefined,
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;
  return { fn, materialized };
}

let dir: string;
let hosts: RunnerHost[] = [];

beforeEach(() => {
  dir = makeTempDirSync('alteroid-runner-resume-subagents-');
});

afterEach(async () => {
  await Promise.all(hosts.map((host) => host.shutdown().catch(() => undefined)));
  hosts = [];
});

async function resumeWith(extra: Partial<RunnerHostOptions>, subagents = SUBAGENTS) {
  const { fn, materialized } = fakeSdk();
  const notes: string[] = [];
  const host = createRunnerHost({
    runnerId: 'runner-test',
    workspacePath: '/workspace',
    emit: (event) => {
      if (event.type === 'note') notes.push(event.text);
    },
    queryFn: fn,
    env: { PATH: '/usr/bin' },
    outboxRoot: join(dir, 'outbox'),
    outboxStagedRoot: join(dir, 'outbox-staged'),
    managerScratchRoot: join(dir, 'scratch-root'),
    ...extra,
  });
  hosts.push(host);
  await host.resume({
    managerId: 'mgr-abcd1234-0000',
    sessionId: 'sess-old',
    cwd: '/workspace',
    request: '検査して',
    message: '続けて',
    entries: MAIN,
    subagents,
  });
  await vi.waitFor(() => {
    if (materialized.length === 0) throw new Error('材料がまだ引かれていない');
  });
  return { result: materialized[0], notes };
}

function selfAsChild(home: string): Partial<RunnerHostOptions> {
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (uid === undefined || gid === undefined) throw new Error('uid の取れない環境');
  return { childUser: { uid, gid, home } };
}

describe('作業者の記録を戻す: runner が自分で置く経路（子 UID の器）', () => {
  it('主の記録の隣に subagents/<id>.jsonl と .meta.json を置き、SDK には何も返さない', async () => {
    const home = join(dir, 'home');
    mkdirSync(home);

    const { result } = await resumeWith(selfAsChild(home));

    expect(result?.main).toBeNull();
    expect(result?.listed).toBeUndefined();
    const sessionDir = join(home, '.claude', 'projects', PROJECT_KEY, 'sess-old');
    expect(readFileSync(join(sessionDir, 'subagents', 'agent-a1.jsonl'), 'utf8')).toBe(
      `${JSON.stringify(WORKER[0])}\n`,
    );
    expect(
      JSON.parse(readFileSync(join(sessionDir, 'subagents', 'agent-a1.meta.json'), 'utf8')),
    ).toEqual({
      agentType: 'worker',
    });
    expect(readFileSync(join(sessionDir, 'subagents', 'agent-b2.jsonl'), 'utf8')).toContain(
      '調べて',
    );
  });

  it('危ない subpath は置かずに note へ残し、主の resume は止めない', async () => {
    const home = join(dir, 'home');
    mkdirSync(home);

    const { result, notes } = await resumeWith(selfAsChild(home), [
      { subpath: 'subagents/../../escape', entries: WORKER },
      { subpath: 'subagents/agent-ok', entries: WORKER },
    ]);

    expect(result?.main).toBeNull();
    expect(notes.some((text) => text.includes('安全でない') && text.includes('escape'))).toBe(true);
    expect(
      readFileSync(
        join(home, '.claude', 'projects', PROJECT_KEY, 'sess-old', 'subagents', 'agent-ok.jsonl'),
        'utf8',
      ),
    ).toContain('調べて');
  });
});

describe('作業者の記録を戻す: SDK に渡す経路（子を降ろさない器）', () => {
  it('SDK が listSubkeys で作業者の一覧を引き、subpath つきの load で本文（agent_metadata の行を含む）を受け取る', async () => {
    const { result } = await resumeWith({});

    expect(result?.main).toEqual(MAIN);
    expect(result?.listed).toEqual(['subagents/agent-a1', 'subagents/agent-b2']);
    expect(result?.sub).toEqual({
      'subagents/agent-a1': [META, ...WORKER],
      'subagents/agent-b2': WORKER,
    });
  });

  it('預かっていない subpath は null を返す（作業者の記録を作り出さない）', async () => {
    const { result } = await resumeWith({}, []);

    expect(result?.listed).toEqual([]);
  });
});

describe('toSessionStore: listSubkeys を、在るときだけ SDK へ渡す', () => {
  const base = { append: async () => undefined, load: async () => null };

  it('在れば同じ口を渡す', async () => {
    const store = toSessionStore({
      ...base,
      listSubkeys: async () => ['subagents/agent-a1'],
    });

    expect(await store.listSubkeys?.({ projectKey: 'p', sessionId: 's' })).toEqual([
      'subagents/agent-a1',
    ]);
  });

  it('無ければ口ごと付けない（SDK は「実装しているか」で作業者の分を戻すか決めるため）', () => {
    expect('listSubkeys' in toSessionStore(base)).toBe(false);
  });
});
