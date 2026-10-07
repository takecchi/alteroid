import { describe, expect, it } from 'vitest';

import { createManagerPool, type ManagerPool } from './manager.js';
import { describeManagerPeers } from './manager-peers-format.js';
import { createLocalRunner } from './runner-local.js';
import {
  createRunnerRegistry,
  RUNNER_CAPABILITY_MANAGER_PEERS,
  type RunnerClient,
  type RunnerEvent,
  type RunnerManagerPeer,
} from './runner-protocol.js';
import { createMemoryStores } from './testing.js';
import { createCloneTools, renderPeerReach, type ToolContext } from './tools.js';

/**
 * runner が `hello` で名乗った peer（#3940）が、デーモンの `runners()`・クローンの `runner_list` /
 * `self_status` に「Codex に作業を頼める」として出ること。名乗らない旧い runner は「不明」、
 * 開いている peer が無い器は何も出ないこと。
 */

function fakeRunner(hello: {
  capable: boolean;
  managerPeers?: RunnerManagerPeer[];
}): RunnerClient & { helloed: () => boolean } {
  let helloed = false;
  const runnerId = 'runner-x';
  const base = createLocalRunner({ runnerId, workspacePath: '/work/project', env: {} });
  const runner = Object.create(base) as RunnerClient & { helloed: () => boolean };
  Object.assign(runner, {
    helloed: () => helloed,
    runnerId,
    runnerIdKnown: true,
    workspacePathKnown: true,
    workspacePath: '/work/project',
    async connect(onEvent: (event: RunnerEvent) => void) {
      onEvent({
        type: 'hello',
        runnerId,
        capabilities: hello.capable ? [RUNNER_CAPABILITY_MANAGER_PEERS] : [],
        ...(hello.managerPeers === undefined ? {} : { managerPeers: hello.managerPeers }),
      });
      helloed = true;
    },
    async list() {
      return [];
    },
  });
  return runner;
}

async function harness(runner: RunnerClient & { helloed: () => boolean }) {
  const stores = createMemoryStores();
  const registry = createRunnerRegistry([runner]);
  const pool: ManagerPool = createManagerPool({ stores, post: () => undefined, runners: registry });
  const context: ToolContext = {
    stores,
    emit: () => undefined,
    memoryCause: () => 'clone',
    conversationId: () => undefined,
    managers: pool,
  };
  const tools = createCloneTools(context);
  const call = async (name: string, args: Record<string, unknown>): Promise<string> => {
    const tool = tools.find((t) => t.name === name);
    const out = await tool!.handler(args as never, {} as never);
    return out.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
  };
  // hello を渡し終えるまで待つ（`connect` は名簿を開いたときに走る）。旧い runner の「不明」を、
  // 「まだ名乗りを受けていない」の不明と取り違えないため。
  // 実時間では待たない（#2146）: 名簿を開かせてから、マイクロタスクと setImmediate の段だけ回す。
  for (let i = 0; i < 2000 && !runner.helloed(); i += 1) {
    await pool.runners();
    await new Promise((resolve) => setImmediate(resolve));
  }
  if (!runner.helloed()) throw new Error('hello を渡せなかった');
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
  return {
    pool,
    call,
    stop: async () => {
      await pool.stop();
      await registry.stop();
    },
  };
}

describe('runner が名乗った peer の見え方（#3940）', () => {
  it('名乗った peer は runners() に named で出て、runner_list に「Codex に作業を頼める」と出る', async () => {
    const { pool, call, stop } = await harness(
      fakeRunner({ capable: true, managerPeers: [{ provider: 'codex', models: ['gpt-5.5'] }] }),
    );
    const overview = await pool.runners();
    expect(overview.runners[0]?.managerPeers).toEqual({
      status: 'named',
      peers: [{ provider: 'codex', models: ['gpt-5.5'] }],
    });
    const listed = await call('runner_list', {});
    expect(listed).toContain(
      'peer: Codex に作業を頼める（peer: codex。名指しできるモデル: gpt-5.5）',
    );
    await stop();
  });

  it('名乗る版で peer が開いていなければ、runner_list に peer の行は出ない', async () => {
    const { pool, call, stop } = await harness(fakeRunner({ capable: true }));
    expect((await pool.runners()).runners[0]?.managerPeers).toEqual({ status: 'named', peers: [] });
    expect(await call('runner_list', {})).not.toContain('peer:');
    await stop();
  });

  it('名乗らない旧い runner は「不明」と出る（頼めないと既定値で埋めない）', async () => {
    const { pool, call, stop } = await harness(fakeRunner({ capable: false }));
    expect((await pool.runners()).runners[0]?.managerPeers).toEqual({ status: 'unknown' });
    expect(await call('runner_list', {})).toContain('peer: 不明');
    await stop();
  });

  it('self_status の末尾に、頼める器を1行ずつ足す（開いている peer が無ければ1文字も足さない）', async () => {
    const opened = await harness(
      fakeRunner({ capable: true, managerPeers: [{ provider: 'codex' }] }),
    );
    const lines = await renderPeerReach(opened.pool);
    expect(lines.join('\n')).toContain('- runner-x: Codex に作業を頼める');
    await opened.stop();
    const closed = await harness(fakeRunner({ capable: true }));
    expect(await renderPeerReach(closed.pool)).toEqual([]);
    await closed.stop();
    expect(await renderPeerReach(undefined)).toEqual([]);
  });

  it('manager_start の説明は「Codex にやらせて」と runnerId での名指しに触れる', async () => {
    const tools = createCloneTools({
      stores: createMemoryStores(),
      emit: () => undefined,
      memoryCause: () => 'clone',
      conversationId: () => undefined,
    });
    const description = tools.find((t) => t.name === 'manager_start')?.description ?? '';
    expect(description).toContain('Codex にやらせて');
    expect(description).toContain('runnerId');
  });
});

describe('describeManagerPeers', () => {
  it('欄が無い（旧いデーモン）・開いていない peer は行を出さず、unknown は「不明」と言う', () => {
    expect(describeManagerPeers(undefined)).toBeUndefined();
    expect(describeManagerPeers({ status: 'named', peers: [] })).toBeUndefined();
    expect(describeManagerPeers({ status: 'unknown' })).toContain('不明');
    expect(describeManagerPeers({ status: 'named', peers: [{ provider: 'codex' }] })).toBe(
      'Codex に作業を頼める（peer: codex。モデルは Codex の既定）',
    );
  });
});
