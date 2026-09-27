import type { Query, SDKMessage, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, describe, expect, it } from 'vitest';

import type { RunnerEvent } from './runner-protocol.js';
import { createRunnerHost, type RunnerHost, type RunnerHostOptions } from './runner.js';

/**
 * Issue #1783 — `cwd` が明示されていても、この runner の器の上に実在しなければ
 * `workspacePath` へ倒して開くこと。
 *
 * **`start` と `resume` の両方が同じ関門（`Host#create` → `Host#resolveCwd`）を
 * 通ることを固定する。** 直す前は `cwd.length > 0 ? cwd : this.workspacePath`
 * だけで、明示された `cwd` は実在を確かめずにそのまま `query()` へ渡っていた
 * ——移送先の器にそのディレクトリが無ければ、SDK の spawn が chdir で ENOENT
 * になり、セッションそのものが開けなくなる（`.scratch/sdk-cwd-probe-output.txt`
 * の実測。PR 本文にも逐語を残す）。
 *
 * **確かめの実体（`fs.statSync`）はテストから固定した偽物へ差し替える**
 * （`cwdExistsFn`。`runner-fence.test.ts` の `readCgroupEventCountersFn` /
 * `finishUnpushedWorkFn` と同じ作法——実ファイルシステムに依存させない）。
 */

/** `runner-fence.test.ts` の `fakeSdk` と同型（走行中のセッションを模す）。 */
function fakeSdk(): {
  fn: typeof sdkQuery;
  cwds: string[];
} {
  const cwds: string[] = [];

  const fn = ((params: {
    options?: { cwd?: string };
    prompt: AsyncIterable<{ message: { content: unknown } }>;
  }) => {
    cwds.push(params.options?.cwd ?? '');
    let finish: (() => void) | null = null;

    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: `sess-${cwds.length}`,
        uuid: `uuid-init-${cwds.length}`,
      } as unknown as SDKMessage;

      // 読み手は要る（`runner-fence.test.ts` の同じ注記）。
      void (async () => {
        for await (const message of params.prompt) {
          // 読み捨てるだけでよい——このテストが確かめたいのは cwd だけ。
          void message;
        }
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

  return { fn, cwds };
}

let hosts: RunnerHost[] = [];

afterEach(async () => {
  await Promise.all(hosts.map((host) => host.shutdown().catch(() => undefined)));
  hosts = [];
});

function setup(
  options: {
    existingDirs: readonly string[];
  } & Partial<Pick<RunnerHostOptions, 'workspacePath'>>,
): {
  host: RunnerHost;
  events: RunnerEvent[];
  fake: ReturnType<typeof fakeSdk>;
  cwdChecks: string[];
} {
  const events: RunnerEvent[] = [];
  const fake = fakeSdk();
  const cwdChecks: string[] = [];
  const existing = new Set(options.existingDirs);
  const host = createRunnerHost({
    runnerId: 'runner-cwd-fallback',
    workspacePath: options.workspacePath ?? '/workspace',
    emit: (event) => events.push(event),
    queryFn: fake.fn,
    env: { PATH: '/usr/bin' },
    readCgroupEventCountersFn: async () => ({}),
    finishUnpushedWorkFn: async () => ({ cwd: '/workspace', worktrees: [] }),
    cwdExistsFn: (cwd) => {
      cwdChecks.push(cwd);
      return existing.has(cwd);
    },
  });
  hosts.push(host);
  return { host, events, fake, cwdChecks };
}

describe('Host#resolveCwd（Issue #1783） — start', () => {
  it('明示された cwd が実在すれば、そのまま開く', async () => {
    const { host, fake, cwdChecks } = setup({ existingDirs: ['/work/project'] });
    await host.start({ managerId: 'mgr-1', request: '依頼', cwd: '/work/project' });
    expect(fake.cwds).toEqual(['/work/project']);
    expect(host.list()[0]?.cwd).toBe('/work/project');
    // **確かめは1回だけ呼ばれる**（`start` の1回の `#create` から）。
    expect(cwdChecks).toEqual(['/work/project']);
  });

  it('明示された cwd がこの器に実在しなければ、workspacePath へ倒して開く', async () => {
    const { host, fake } = setup({
      existingDirs: [],
      workspacePath: '/workspace',
    });
    await host.start({
      managerId: 'mgr-1',
      request: '依頼',
      cwd: '/workspace/mgr-old/repo-that-no-longer-exists',
    });
    // **`query()` へ渡る cwd も、`list()` が名乗る cwd も、両方 `workspacePath`
    // へ倒れている**——どちらか片方だけ直しても意味が無い（`state()` が
    // `list()` の元でもある）。
    expect(fake.cwds).toEqual(['/workspace']);
    expect(host.list()[0]?.cwd).toBe('/workspace');
  });

  it('cwd を省く（空文字）と、今までどおり workspacePath へ倒す（既存の既定を壊さない）', async () => {
    const { host, fake, cwdChecks } = setup({ existingDirs: [], workspacePath: '/workspace' });
    await host.start({ managerId: 'mgr-1', request: '依頼', cwd: '' });
    expect(fake.cwds).toEqual(['/workspace']);
    // **空文字は「無い」とは別の枝である。** 実在確認そのものを呼ばない
    // ——既存の「省略」の意味（`workspacePath` の既定）に、新しい確かめを
    // 割り込ませない。
    expect(cwdChecks).toEqual([]);
  });
});

describe('Host#resolveCwd（Issue #1783） — resume', () => {
  it('明示された cwd がこの器（移送先）に実在しなければ、workspacePath へ倒して開く', async () => {
    const { host, fake } = setup({ existingDirs: [], workspacePath: '/workspace' });
    // **移送された委譲の resume**——`sessionId` はデーモンが台帳から渡す値。
    // このテストは中身（entries の再生）ではなく `cwd` の解決だけを見る。
    await host.resume({
      managerId: 'mgr-2',
      sessionId: 'sess-old',
      cwd: '/workspace/mgr-old/repo-that-no-longer-exists',
      request: '続きの依頼',
    });
    expect(fake.cwds).toEqual(['/workspace']);
    expect(host.list()[0]?.cwd).toBe('/workspace');
  });

  it('明示された cwd がこの器に実在すれば、そのまま resume する', async () => {
    const { host, fake } = setup({ existingDirs: ['/work/project'] });
    await host.resume({
      managerId: 'mgr-2',
      sessionId: 'sess-old',
      cwd: '/work/project',
      request: '続きの依頼',
    });
    expect(fake.cwds).toEqual(['/work/project']);
    expect(host.list()[0]?.cwd).toBe('/work/project');
  });
});
