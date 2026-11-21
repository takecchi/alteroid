import { join } from 'node:path';

import type { Options, Query, SDKMessage, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { makeTempDirSync } from '../../../vitest.tmpdir.js';

import { BASH_GUARD_ENV, BASH_SHAPE_GUARD_ENV } from './bash-guard-mode.js';
import { createProfileVessel } from './profile.js';
import { buildManagerSystemPrompt, buildWorkerPrompt } from './prompt.js';
import {
  createRunnerHost,
  WITHHELD_ENV_KEYS,
  WORKER_AGENT_NAME,
  type RunnerHost,
} from './runner.js';

// 歯の状態を、セッションを起こす時点の実効の値で担当・作業者のプロンプトへ渡す（#5017）

function fakeSdk(): { fn: typeof sdkQuery; started: Options[] } {
  const started: Options[] = [];
  const fn = ((params: { prompt: unknown; options?: Options }) => {
    started.push(params.options ?? {});
    let finish: (() => void) | null = null;
    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: `sess-${String(started.length)}`,
        uuid: `uuid-init-${String(started.length)}`,
      } as unknown as SDKMessage;
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    }
    return Object.assign(generate(), {
      close: () => finish?.(),
      interrupt: async () => undefined,
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;
  return { fn, started };
}

let hosts: RunnerHost[] = [];

afterEach(async () => {
  await Promise.all(hosts.map((host) => host.shutdown().catch(() => undefined)));
  hosts = [];
});

async function open(env: NodeJS.ProcessEnv, profileScript?: string): Promise<Options> {
  const { fn, started } = fakeSdk();
  const dir = makeTempDirSync('alteroid-runner-bash-guards-prompt-');
  const host = createRunnerHost({
    runnerId: 'runner-test',
    workspacePath: dir,
    emit: () => undefined,
    queryFn: fn,
    env: { PATH: '/usr/bin', ...env },
    ...(profileScript === undefined
      ? {}
      : {
          profile: createProfileVessel({
            path: join(dir, 'profile', 'profile.sh'),
            withheldEnvKeys: WITHHELD_ENV_KEYS,
          }),
        }),
  });
  hosts.push(host);
  // 開く前に置く: プロンプトは開く時点で決まるため
  if (profileScript !== undefined) {
    const result = await host.setProfile(profileScript);
    if (!result.ok) throw new Error('プロファイルが置けない');
  }
  await host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
  await vi.waitFor(() => {
    if (started.length < 1) throw new Error('セッションがまだ開いていない');
  });
  return started[0]!;
}

const appendOf = (options: Options): string =>
  String((options.systemPrompt as { append?: unknown }).append);
const workerPromptOf = (options: Options): string =>
  String(((options.agents ?? {})[WORKER_AGENT_NAME] as { prompt?: unknown }).prompt);

const managerPrompt = (bashGuards?: {
  shape: boolean;
  wait: boolean;
  shapeOff?: boolean;
}): string =>
  buildManagerSystemPrompt({
    managerId: 'mgr-1',
    workerName: WORKER_AGENT_NAME,
    ...(bashGuards === undefined ? {} : { bashGuards }),
  });

describe('歯が断る形を担当・作業者のプロンプトへ渡す（#5017）', () => {
  it('形の歯が on（待ちの歯は既定の ask）なら、両方の節が担当にも作業者にも載る', async () => {
    const options = await open({ [BASH_SHAPE_GUARD_ENV]: 'on' });
    const guards = { shape: true, wait: true };
    expect(appendOf(options)).toBe(managerPrompt(guards));
    expect(workerPromptOf(options)).toBe(buildWorkerPrompt(guards));
  });

  it('形の歯が既定（on）で待ちの歯が ask なら、形の一覧と待ちの節が載り、分類器の節は載らない', async () => {
    const options = await open({});
    const guards = { shape: true, wait: true };
    expect(appendOf(options)).toBe(managerPrompt(guards));
    expect(workerPromptOf(options)).toBe(buildWorkerPrompt(guards));
    expect(appendOf(options)).toContain('# この器で断られる Bash の形');
    expect(appendOf(options)).not.toContain('# 分類器に止められやすい Bash の形');
  });

  it('形の歯を明示的に off にして待ちの歯が ask なら、待ちの節と分類器の節が載り、形の一覧は載らない', async () => {
    const options = await open({ [BASH_SHAPE_GUARD_ENV]: 'off' });
    const guards = { shape: false, wait: true, shapeOff: true };
    expect(appendOf(options)).toBe(managerPrompt(guards));
    expect(workerPromptOf(options)).toBe(buildWorkerPrompt(guards));
    expect(appendOf(options)).toContain('# 分類器に止められやすい Bash の形');
    expect(appendOf(options)).not.toContain('# この器で断られる Bash の形');
  });

  it('待ちの歯が deny でも載る', async () => {
    const options = await open({ [BASH_GUARD_ENV]: 'deny', [BASH_SHAPE_GUARD_ENV]: 'off' });
    expect(appendOf(options)).toBe(managerPrompt({ shape: false, wait: true, shapeOff: true }));
  });

  it('どちらも閉じていれば、歯の節は載らず、分類器の節だけが載る（作業者にも）', async () => {
    const options = await open({ [BASH_GUARD_ENV]: 'off', [BASH_SHAPE_GUARD_ENV]: 'off' });
    const guards = { shape: false, wait: false, shapeOff: true };
    expect(appendOf(options)).toBe(managerPrompt(guards));
    expect(workerPromptOf(options)).toBe(buildWorkerPrompt(guards));
    expect(appendOf(options)).not.toContain('この器で断られる');
    expect(appendOf(options)).toContain('# 分類器に止められやすい Bash の形');
  });

  it('プロファイルで形の歯を on にすると載る（runner の env は off）', async () => {
    const options = await open(
      { [BASH_GUARD_ENV]: 'off', [BASH_SHAPE_GUARD_ENV]: 'off' },
      `export ${BASH_SHAPE_GUARD_ENV}=on`,
    );
    expect(appendOf(options)).toBe(managerPrompt({ shape: true, wait: false }));
    expect(workerPromptOf(options)).toBe(buildWorkerPrompt({ shape: true, wait: false }));
  });

  it('形の歯の値が不正で判定が投げても、セッションは開き、歯の形の一覧は載せない（off として扱う）', async () => {
    const options = await open({ [BASH_GUARD_ENV]: 'off', [BASH_SHAPE_GUARD_ENV]: 'yes' });
    const guards = { shape: false, wait: false, shapeOff: true };
    expect(appendOf(options)).toBe(managerPrompt(guards));
    expect(workerPromptOf(options)).toBe(buildWorkerPrompt(guards));
  });
});
