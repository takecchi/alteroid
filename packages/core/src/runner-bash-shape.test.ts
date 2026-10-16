import { join } from 'node:path';

import type {
  HookJSONOutput,
  Options,
  Query,
  SDKMessage,
  query as sdkQuery,
} from '@anthropic-ai/claude-agent-sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { makeTempDirSync } from '../../../vitest.tmpdir.js';

import { BASH_GUARD_ENV, BASH_SHAPE_GUARD_ENV } from './bash-guard-mode.js';
import { createProfileVessel } from './profile.js';
import { createRunnerHost, WITHHELD_ENV_KEYS, type RunnerHost } from './runner.js';
import type { RunnerEvent } from './runner-protocol.js';

function fakeRunnerSdk(): { fn: typeof sdkQuery; started: { options: Options }[] } {
  const started: { options: Options }[] = [];
  const fn = ((input: { options: Options }) => {
    started.push({ options: input.options });
    let finish: (() => void) | undefined;
    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: `sess-${started.length}`,
        uuid: `uuid-${started.length}`,
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

async function firePreToolUse(
  options: Options,
  input: Record<string, unknown>,
): Promise<HookJSONOutput> {
  const hook = options.hooks?.PreToolUse?.[0]?.hooks?.[0];
  if (hook === undefined) throw new Error('PreToolUse フックが登録されていない');
  return hook(input as never, undefined, { signal: new AbortController().signal });
}

function bash(command: string, worker: boolean): Record<string, unknown> {
  return {
    hook_event_name: 'PreToolUse',
    tool_use_id: 'tu-1',
    tool_name: 'Bash',
    tool_input: { command },
    ...(worker ? { agent_id: 'agent-xyz', agent_type: 'worker' } : {}),
  };
}

let dir: string;
let host: RunnerHost | undefined;

beforeEach(() => {
  dir = makeTempDirSync('alteroid-runner-bash-shape-');
});

afterEach(async () => {
  await host?.shutdown().catch(() => undefined);
});

// 形の歯は既定 off（`ALTEROID_BASH_SHAPE_GUARD`）。この節の試験は、on を置いて走らせる
async function startSession(
  env: NodeJS.ProcessEnv,
): Promise<{ options: Options; events: RunnerEvent[] }> {
  return startSessionRaw({ [BASH_SHAPE_GUARD_ENV]: 'on', ...env });
}

async function startSessionRaw(
  env: NodeJS.ProcessEnv,
  profileScript?: string,
  logs?: string[],
): Promise<{ options: Options; events: RunnerEvent[] }> {
  const events: RunnerEvent[] = [];
  const { fn, started } = fakeRunnerSdk();
  host = createRunnerHost({
    runnerId: 'runner-test',
    workspacePath: dir,
    emit: (event) => events.push(event),
    queryFn: fn,
    env,
    ...(logs === undefined ? {} : { log: (line: string) => logs.push(line) }),
    ...(profileScript === undefined
      ? {}
      : {
          profile: createProfileVessel({
            path: join(dir, 'profile', 'profile.sh'),
            withheldEnvKeys: WITHHELD_ENV_KEYS,
          }),
        }),
  });
  await host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
  const options = started[0]?.options;
  if (options === undefined) throw new Error('セッションが開いていない');
  if (profileScript !== undefined) {
    const result = await host.setProfile(profileScript);
    if (!result.ok) throw new Error('プロファイルが置けない');
  }
  return { options, events };
}

function noteTexts(events: readonly RunnerEvent[]): string[] {
  return events
    .filter((event) => event.type === 'note')
    .map((event) => (event as { text: string }).text);
}

type Out = { continue?: boolean; hookSpecificOutput?: Record<string, unknown> };

const ACTORS = [
  { label: '作業者', worker: true, actor: 'worker:mgr-1:worker' },
  { label: 'マネージャー', worker: false, actor: 'manager:mgr-1' },
] as const;

describe('Bash の形の歯（#4947・マネージャーにも #4949）', () => {
  for (const { label, worker, actor } of ACTORS) {
    for (const mode of [undefined, 'ask', 'deny'] as const) {
      it(`ALTEROID_BASH_GUARD=${mode ?? '未設定'}: ${label}の 2>&1 は deny で、代わりの道を返し、note に呼び手と形を残す`, async () => {
        const { options, events } = await startSession(
          mode === undefined ? {} : { [BASH_GUARD_ENV]: mode },
        );
        const result = (await firePreToolUse(options, bash('pnpm test 2>&1', worker))) as Out;
        expect(result.hookSpecificOutput?.permissionDecision).toBe('deny');
        expect(String(result.hookSpecificOutput?.permissionDecisionReason)).toContain('| tail');
        const note = noteTexts(events).find((t) => t.includes('Bash の呼び出しを弾いた'));
        expect(note).toContain(actor);
        expect(note).toContain('形=fd-dup');
        expect(noteTexts(events).some((t) => t.includes('確認に上げた'))).toBe(false);
      });
    }

    it.each([
      ['cat <<EOF\nx\nEOF', 'heredoc', 'Write'],
      ['echo hi > f', 'redirect', 'Write'],
      ["sed -i 's/a/b/' f", 'sed-in-place', 'Edit'],
      ["node -e '1'", 'node-eval', 'Write'],
      ["python3 -c 'x'", 'python-c', 'Write'],
      ["perl -e '1'", 'perl-eval', 'Write'],
      ['pnpm test |& tail', 'pipe-stderr', '`|` だけ'],
      ["timeout 300 bash -c 'pnpm test 2>&1'", 'fd-dup', '| tail'],
      ['git commit -m "$(cat <<\'EOF\'\nx\nEOF\n)"', 'subst-heredoc', 'git commit -F'],
      ['git reset --hard', 'git-reset', 'git restore --staged'],
      ['git -C /tmp/x push --force-with-lease', 'git-force-push', '新しい枝'],
      ['git pull --rebase', 'git-rebase', 'git merge origin/main'],
      ['git commit --no-verify -m x', 'no-verify', 'フックが落ちた'],
      ['gh pr merge 1 --auto', 'gh-merge-auto', 'gh run watch'],
    ])(`${label}の %j は deny（形=%s）`, async (command, form, hint) => {
      const { options, events } = await startSession({});
      const result = (await firePreToolUse(options, bash(command, worker))) as Out;
      expect(result.hookSpecificOutput?.permissionDecision).toBe('deny');
      expect(String(result.hookSpecificOutput?.permissionDecisionReason)).toContain(hint);
      const note = noteTexts(events).find((t) => t.includes(`形=${form}`));
      expect(note).toContain(actor);
    });

    it(`ALTEROID_BASH_SHAPE_GUARD=off なら${label}の形も通す`, async () => {
      const { options } = await startSession({ [BASH_SHAPE_GUARD_ENV]: 'off' });
      for (const command of ['pnpm test 2>&1', 'git reset --hard', 'gh pr merge 1 --auto']) {
        expect(await firePreToolUse(options, bash(command, worker))).toEqual({
          continue: true,
        });
      }
    });

    it(`誤検知の例は${label}でも通す`, async () => {
      const { options } = await startSession({});
      for (const command of [
        'gh pr create --body "a > b"',
        "timeout 300 bash -c 'sleep 1; echo done'",
        "timeout 300 bash -c 'until test -f x; do sleep 5; done'",
        'sort < in.txt',
        'echo git reset',
        'gh pr create --body "git reset と --no-verify を避ける"',
        'git log --oneline',
        'git push -u origin feat/x',
        'git restore --staged a.ts',
        'git merge origin/main',
        'gh pr merge 1 --squash --match-head-commit abc',
        'grep -n "rebase" a.ts',
        'git commit -F /tmp/x/msg.txt',
        'git commit -m "plain"',
        'git push origin main:main',
      ]) {
        const result = (await firePreToolUse(options, bash(command, worker))) as Out;
        expect(result.continue).toBe(true);
        // timeout の引き上げ（書き換え）は付きうるので、deny・ask が無いことだけを見る
        expect(result.hookSpecificOutput?.permissionDecision).toBeUndefined();
      }
    });
  }

  // 2026-10-16 #4949: 以前は「マネージャーの 2>&1 は通す」だった（#4947 は作業者だけに掛けていた）。heosterra のマネージャーも `2>&1`・`git reset --hard` を打っていたので、マネージャーでも断る
  it('マネージャーの 2>&1 | tail は断る', async () => {
    const { options, events } = await startSession({});
    const result = (await firePreToolUse(
      options,
      bash('pnpm test 2>&1 | tail -n 20', false),
    )) as Out;
    expect(result.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(
      noteTexts(events).some((t) => t.includes('manager:mgr-1') && t.includes('形=fd-dup')),
    ).toBe(true);
  });

  it('release-prod は形の歯より先に判定され、`off` でも残る', async () => {
    for (const mode of [undefined, 'off'] as const) {
      const { options, events } = await startSession(
        mode === undefined ? {} : { [BASH_GUARD_ENV]: mode },
      );
      const result = (await firePreToolUse(
        options,
        bash('gh workflow run release-prod.yml 2>&1', false),
      )) as Out;
      expect(result.hookSpecificOutput?.permissionDecision).toBe('ask');
      expect(noteTexts(events).some((t) => t.includes('形=fd-dup'))).toBe(false);
      await host?.shutdown().catch(() => undefined);
    }
  });

  it.each([true, false])(
    '形の歯に掛からない待ち形は、今までどおり wait-guard が確認に上げる（作業者=%s）',
    async (worker) => {
      const { options } = await startSession({});
      const result = (await firePreToolUse(options, bash('tail -f /tmp/run.log', worker))) as Out;
      expect(result.hookSpecificOutput?.permissionDecision).toBe('ask');
    },
  );
});

describe('Bash の形の歯の入り切り（ALTEROID_BASH_SHAPE_GUARD。#4949）', () => {
  async function decisionOf(
    env: NodeJS.ProcessEnv,
    profileScript?: string,
    worker = false,
  ): Promise<{ decision: unknown; reason: string }> {
    const { options } = await startSessionRaw(env, profileScript);
    const result = (await firePreToolUse(options, bash('pnpm test 2>&1', worker))) as Out;
    return {
      decision: result.hookSpecificOutput?.permissionDecision,
      reason: String(result.hookSpecificOutput?.permissionDecisionReason),
    };
  }

  it('既定（未設定）では断らない', async () => {
    expect((await decisionOf({})).decision).toBeUndefined();
    await host?.shutdown();
    expect((await decisionOf({ [BASH_SHAPE_GUARD_ENV]: '' }, undefined, true)).decision).toBe(
      undefined,
    );
  });

  it.each([false, true])('runner の env が on なら断る（作業者=%s）', async (worker) => {
    const { decision, reason } = await decisionOf(
      { [BASH_SHAPE_GUARD_ENV]: 'on' },
      undefined,
      worker,
    );
    expect(decision).toBe('deny');
    expect(reason).toContain('| tail');
  });

  it('プロファイルで on なら断る（runner の env は未設定）', async () => {
    const { decision } = await decisionOf({}, `export ${BASH_SHAPE_GUARD_ENV}=on`);
    expect(decision).toBe('deny');
  });

  it('プロファイルは呼び出しのたびに読む: 置く前は通り、置いた次の呼び出しから断る', async () => {
    const { options } = await startSessionRaw({}, 'export OTHER_VAR=1');
    const call = async (): Promise<unknown> =>
      ((await firePreToolUse(options, bash('pnpm test 2>&1', false))) as Out).hookSpecificOutput
        ?.permissionDecision;
    expect(await call()).toBeUndefined();
    const result = await host?.setProfile(`export ${BASH_SHAPE_GUARD_ENV}=on`);
    expect(result?.ok).toBe(true);
    expect(await call()).toBe('deny');
  });

  it('runner の env が on でも、プロファイルが off なら断らない（プロファイルが上書きする）', async () => {
    const { decision } = await decisionOf(
      { [BASH_SHAPE_GUARD_ENV]: 'on' },
      `export ${BASH_SHAPE_GUARD_ENV}=off`,
    );
    expect(decision).toBeUndefined();
  });

  it('ALTEROID_BASH_GUARD=off でも、形の歯が on なら断る', async () => {
    const { decision } = await decisionOf({
      [BASH_GUARD_ENV]: 'off',
      [BASH_SHAPE_GUARD_ENV]: 'on',
    });
    expect(decision).toBe('deny');
  });

  it('ALTEROID_BASH_GUARD=ask・deny でも、形の歯が off なら断らない（独立）', async () => {
    for (const mode of ['ask', 'deny']) {
      expect((await decisionOf({ [BASH_GUARD_ENV]: mode })).decision).toBeUndefined();
      await host?.shutdown();
    }
  });

  it('不正な値は判定の中で投げ、確認に倒れる（deny 設定なら deny）。理由に値が出る', async () => {
    const ask = await decisionOf({ [BASH_SHAPE_GUARD_ENV]: 'yes' });
    expect(ask.decision).toBe('ask');
    expect(ask.reason).toContain('ALTEROID_BASH_SHAPE_GUARD の値が不正: yes');
    await host?.shutdown();
    const deny = await decisionOf({ [BASH_SHAPE_GUARD_ENV]: 'yes', [BASH_GUARD_ENV]: 'deny' });
    expect(deny.decision).toBe('deny');
    expect(deny.reason).toContain('yes');
  });

  it('実効の値が変わったときだけ1行出し直す（setProfile の後）', async () => {
    const logs: string[] = [];
    await startSessionRaw({}, 'export OTHER_VAR=1', logs);
    expect(logs).toEqual([]);
    await host?.setProfile('export OTHER_VAR=2');
    expect(logs).toEqual([]);
    await host?.setProfile(`export ${BASH_SHAPE_GUARD_ENV}=on`);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('Bash の形の歯: on');
    await host?.setProfile(`export ${BASH_SHAPE_GUARD_ENV}=on\nexport OTHER_VAR=3`);
    expect(logs).toHaveLength(1);
    await host?.setProfile(`export ${BASH_SHAPE_GUARD_ENV}=oops`);
    expect(logs).toHaveLength(2);
    expect(logs[1]).toContain('不正な値');
  });

  it('起動行は実効の値を言い、不正な値でも投げない', async () => {
    await startSessionRaw({ [BASH_SHAPE_GUARD_ENV]: 'on' });
    expect(host?.bashShapeGuardLine()).toContain('Bash の形の歯: on（ALTEROID_BASH_SHAPE_GUARD。');
    await host?.shutdown();
    await startSessionRaw({});
    expect(host?.bashShapeGuardLine()).toContain('Bash の形の歯: off');
    await host?.shutdown();
    await startSessionRaw({ [BASH_SHAPE_GUARD_ENV]: 'x' });
    expect(host?.bashShapeGuardLine()).toContain('不正な値');
  });
});
