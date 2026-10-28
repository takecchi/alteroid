import type {
  HookJSONOutput,
  Options,
  Query,
  SDKMessage,
  query as sdkQuery,
} from '@anthropic-ai/claude-agent-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeTempDirSync } from '../../../vitest.tmpdir.js';

import {
  ClassifierDenialStreaks,
  DENIAL_STREAK_NOTICE_INTERVAL_MS,
  describeDenialStreakForClone,
} from './classifier-denial-streak.js';
import { createRunnerHost, type RunnerHost } from './runner.js';
import type { RunnerEvent } from './runner-protocol.js';

// 2026-10-12、WORLDBUILD-2（mgr-c5ee926e）と LAND-7（mgr-39fc362e）で分類器の拒否が続き、その後は grep・prettier --check・
// ふつうの git push まで止められ、クローンへ確認が1件ずつ 20 件以上上がった。CLI は連続3回・累計20回で、分類器の拒否を確認へ倒す。

describe('ClassifierDenialStreaks', () => {
  it('連続3回にちょうど達した回だけ true を返し、相手ごとに数える', () => {
    const streaks = new ClassifierDenialStreaks();
    expect(streaks.noteDenial('manager', '[Instruction Poisoning] 設計書へ指示を書き込む')).toBe(
      false,
    );
    expect(streaks.noteDenial('manager', '[Git Destructive]')).toBe(false);
    expect(streaks.noteDenial('agent-1', '[External System Writes]')).toBe(false);
    expect(streaks.noteDenial('manager', '[External System Writes]')).toBe(true);
    expect(streaks.noteDenial('manager', '[Unrequested Commit]')).toBe(false);
    expect(streaks.view('manager')).toEqual({
      consecutive: 4,
      total: 4,
      firstReason: '[Instruction Poisoning] 設計書へ指示を書き込む',
    });
    expect(streaks.view('agent-1')?.consecutive).toBe(1);
  });

  it('道具が通ると連続は0に戻り、累計は残る。次の連続の最初の理由を新しく覚える', () => {
    const streaks = new ClassifierDenialStreaks();
    streaks.noteDenial('manager', 'A');
    streaks.noteDenial('manager', 'B');
    streaks.noteProgress('manager');
    streaks.noteDenial('manager', 'C');
    expect(streaks.view('manager')).toEqual({ consecutive: 1, total: 3, firstReason: 'C' });
  });

  it('担当への知らせは上限に達した時点の数で1回だけ出し、30分の間隔の内側では出さない', () => {
    const streaks = new ClassifierDenialStreaks();
    for (const reason of ['A', 'B', 'C']) streaks.noteDenial('manager', reason);
    streaks.noteProgress('manager');
    const notice = streaks.takeNotice('manager', 0);
    expect(notice).toContain('続けて 3 回止めた（累計 3 回）');
    expect(streaks.takeNotice('manager', 1)).toBeNull();

    for (const reason of ['D', 'E', 'F']) streaks.noteDenial('manager', reason);
    expect(streaks.takeNotice('manager', DENIAL_STREAK_NOTICE_INTERVAL_MS - 1)).toBeNull();
    for (const reason of ['G', 'H', 'I']) {
      streaks.noteProgress('manager');
      streaks.noteDenial('manager', reason);
    }
    streaks.noteProgress('manager');
    for (const reason of ['J', 'K', 'L']) streaks.noteDenial('manager', reason);
    expect(streaks.takeNotice('manager', DENIAL_STREAK_NOTICE_INTERVAL_MS)).toContain(
      '続けて 3 回止めた',
    );
  });

  it('クローンへの注記は上限（連続3・累計20）を越えたときだけ', () => {
    expect(
      describeDenialStreakForClone('manager', { consecutive: 2, total: 19, firstReason: 'A' }),
    ).toBeNull();
    expect(
      describeDenialStreakForClone('manager', {
        consecutive: 0,
        total: 20,
        firstReason: undefined,
      }),
    ).toContain('累計 20 回');
    expect(
      describeDenialStreakForClone('agent-1', { consecutive: 3, total: 3, firstReason: 'A' }),
    ).toContain('この作業者 agent-1 は');
  });
});

// --- runner を通す ---

function fakeSdk(): { fn: typeof sdkQuery; options: Options[] } {
  const options: Options[] = [];
  const fn = ((input: { options: Options }) => {
    options.push(input.options);
    let stop: () => void = () => undefined;
    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: 'sess-1',
        uuid: 'uuid-1',
      } as unknown as SDKMessage;
      await new Promise<void>((resolve) => {
        stop = resolve;
      });
    }
    return Object.assign(generate(), {
      close: () => stop(),
      interrupt: async () => undefined,
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;
  return { fn, options };
}

let dir: string;
let host: RunnerHost | undefined;

beforeEach(() => {
  dir = makeTempDirSync('alteroid-runner-classifier-denial-streak-');
});

afterEach(async () => {
  await host?.shutdown().catch(() => undefined);
  host = undefined;
});

async function start(): Promise<{ options: Options; events: RunnerEvent[] }> {
  const { fn, options } = fakeSdk();
  const events: RunnerEvent[] = [];
  host = createRunnerHost({
    runnerId: 'runner-test',
    workspacePath: dir,
    emit: (event) => events.push(event),
    queryFn: fn,
    env: {},
  });
  await host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
  const found = await vi.waitFor(() => {
    const first = options[0];
    if (first === undefined) throw new Error('セッションがまだ開いていない');
    return first;
  });
  return { options: found, events };
}

/** 入力が無いので確認へは上がらず、すぐ no-retry で返る（数えだけが進む）。 */
async function deny(options: Options, reason: string, agentId?: string): Promise<void> {
  const hook = options.hooks?.PermissionDenied?.[0]?.hooks?.[0];
  if (hook === undefined) throw new Error('PermissionDenied フックが登録されていない');
  await hook(
    {
      hook_event_name: 'PermissionDenied',
      tool_name: 'Edit',
      tool_use_id: `tu-${reason}`,
      reason,
      ...(agentId === undefined ? {} : { agent_id: agentId, agent_type: 'worker' }),
    } as never,
    undefined,
    { signal: new AbortController().signal },
  );
}

async function postToolUse(options: Options, agentId?: string): Promise<string | undefined> {
  const hook = options.hooks?.PostToolUse?.[0]?.hooks?.[0];
  if (hook === undefined) throw new Error('PostToolUse フックが登録されていない');
  const result = (await hook(
    {
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'grep -n foo README.md' },
      tool_response: { stdout: '', stderr: '' },
      ...(agentId === undefined ? {} : { agent_id: agentId, agent_type: 'worker' }),
    } as never,
    undefined,
    { signal: new AbortController().signal },
  )) as HookJSONOutput;
  return (result as { hookSpecificOutput?: { additionalContext?: string } }).hookSpecificOutput
    ?.additionalContext;
}

function askClone(options: Options, agentId?: string): void {
  if (options.canUseTool === undefined) throw new Error('canUseTool が無い');
  void options.canUseTool('Bash', { command: 'prettier --check src/index.ts' }, {
    signal: new AbortController().signal,
    toolUseID: `tu-ask-${agentId ?? 'manager'}`,
    requestId: `req-${agentId ?? 'manager'}`,
    decisionReason: 'auto mode の分類器が止めた',
    ...(agentId === undefined ? {} : { agentID: agentId }),
  } as never);
}

async function waitingSummaries(): Promise<string[]> {
  const states = await host!.list();
  return states.flatMap((state) => state.waiting.map((waiting) => waiting.summary));
}

describe('分類器の拒否が続いた担当の事情を、クローンへの確認と担当への知らせに添える', () => {
  it('連続3回で日誌へ1行。その後の確認には事情の注記が付き、次に通った道具に取れる道を添える', async () => {
    const { options, events } = await start();
    await deny(options, '[Instruction Poisoning] 設計書に「オーナーの答え」を書き込む');
    await deny(options, '[Git Destructive]');
    await deny(options, '[External System Writes]');

    const crossed = events.filter(
      (event) =>
        event.type === 'note' && event.text.includes('分類器の拒否が manager:mgr-1 で続けて 3 回'),
    );
    expect(crossed).toHaveLength(1);

    askClone(options);
    await vi.waitFor(async () => expect(await waitingSummaries()).toHaveLength(1));
    const [summary] = await waitingSummaries();
    expect(summary).toContain('⚠ この担当本人は、分類器（auto mode）の拒否が連続 3 回・累計 3 回');
    expect(summary).toContain('[Instruction Poisoning] 設計書に「オーナーの答え」を書き込む');
    expect(summary).toContain('prettier --check');

    const notice = await postToolUse(options);
    expect(notice).toContain('auto mode の分類器があなたの操作を続けて 3 回止めた');
    expect(notice).toContain('新しい作業者に、何をなぜするかを書いて渡す');
    expect(notice).toContain(
      '区切りが付いたら報告して止まり、ユーザーに後継の担当を起こしてもらう',
    );
    expect(notice).toContain('回り込んで通そうとしないこと');
    // 2回目は添えない
    expect(await postToolUse(options)).toBeUndefined();
  });

  it('作業者の拒否は担当本人とは別に数え、担当本人の確認には注記を付けない', async () => {
    const { options } = await start();
    for (const reason of ['A', 'B', 'C']) await deny(options, reason, 'agent-1');

    askClone(options);
    await vi.waitFor(async () => expect(await waitingSummaries()).toHaveLength(1));
    expect((await waitingSummaries())[0]).not.toContain('分類器（auto mode）の拒否が連続');

    expect(await postToolUse(options)).toBeUndefined();
    expect(await postToolUse(options, 'agent-1')).toContain('続けて 3 回止めた');
  });

  it('runner の /managers（host.list()）は、上限を越えた相手だけを classifierDenials で名乗る（越えていなければ空配列）', async () => {
    const { options } = await start();
    expect((await host!.list())[0]?.classifierDenials).toEqual([]);
    for (const reason of ['A', 'B', 'C']) await deny(options, reason);
    await deny(options, 'X', 'agent-1');
    expect((await host!.list())[0]?.classifierDenials).toEqual([
      { actor: 'manager', consecutive: 3, total: 3, firstReason: 'A' },
    ]);
  });

  it('拒否が2回までなら、何も添えない', async () => {
    const { options, events } = await start();
    await deny(options, 'A');
    await deny(options, 'B');
    expect(await postToolUse(options)).toBeUndefined();
    expect(events.some((event) => event.type === 'note' && event.text.includes('続けて'))).toBe(
      false,
    );
  });
});
