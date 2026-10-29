import { join } from 'node:path';

import type { Options, Query, SDKMessage, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { makeTempDirSync } from '../../../vitest.tmpdir.js';

import { BASH_GUARD_ENV } from './bash-guard-mode.js';
import { DEFAULT_AUTO_COMPACT_WINDOW_TOKENS } from './claude-provider.js';
import { createProfileVessel } from './profile.js';
import { buildManagerSystemPrompt, buildWorkerPrompt } from './prompt.js';
import { REPORT_LANGUAGE_ENV, REPORT_LANGUAGE_PROMPT_PARAGRAPH } from './report-language.js';
import {
  createRunnerHost,
  WITHHELD_ENV_KEYS,
  WORKER_AGENT_NAME,
  type RunnerHost,
} from './runner.js';
import type { RunnerEvent } from './runner-protocol.js';
import { TOKEN_SAVING_COMPACTION_ENV } from './token-saving-switches.js';

// ALTEROID_REPORT_LANGUAGE=ja のとき、担当・作業者のプロンプトに言語の段落を足し、SDK の settings.language を渡す（#4977）

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
      void (async () => {
        const iterator = (params.prompt as AsyncIterable<unknown>)[Symbol.asyncIterator]();
        while (!(await iterator.next()).done) {
          // 入力は読み捨てる
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
  return { fn, started };
}

let hosts: RunnerHost[] = [];

afterEach(async () => {
  await Promise.all(hosts.map((host) => host.shutdown().catch(() => undefined)));
  hosts = [];
});

async function open(
  env: NodeJS.ProcessEnv,
  profileScript?: string,
  how: 'start' | 'resume' = 'start',
): Promise<{ options: Options; events: RunnerEvent[] }> {
  const events: RunnerEvent[] = [];
  const { fn, started } = fakeSdk();
  const dir = makeTempDirSync('alteroid-runner-report-language-prompt-');
  const host = createRunnerHost({
    runnerId: 'runner-test',
    workspacePath: dir,
    emit: (event) => events.push(event),
    queryFn: fn,
    // 待ちの歯は既定で ask（プロンプトに待ちの形の節が載る）。この節の試験は言語の段落だけを見るので、歯を閉じて載せない
    // 自動の要約の窓は畳みの系統（既定は切り）の下にある。この節は窓を載せた形の settings を見るので、系統を入れて開く
    env: {
      PATH: '/usr/bin',
      [BASH_GUARD_ENV]: 'off',
      [TOKEN_SAVING_COMPACTION_ENV]: '1',
      ...env,
    },
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
  if (how === 'start') {
    await host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
  } else {
    await host.resume({ managerId: 'mgr-1', sessionId: 'sess-old', request: '続き', cwd: dir });
  }
  await vi.waitFor(() => {
    if (started.length < 1) throw new Error('セッションがまだ開いていない');
  });
  return { options: started[0]!, events };
}

const appendOf = (options: Options): string =>
  String((options.systemPrompt as { append?: unknown }).append);
const workerPromptOf = (options: Options): string =>
  String(((options.agents ?? {})[WORKER_AGENT_NAME] as { prompt?: unknown }).prompt);

const BASE_APPEND = buildManagerSystemPrompt({ managerId: 'mgr-1', workerName: WORKER_AGENT_NAME });

describe('言語の指示を担当・作業者のプロンプトと SDK の settings に入れる（ALTEROID_REPORT_LANGUAGE。#4977）', () => {
  it('段落は指定の文言そのものである', () => {
    expect(REPORT_LANGUAGE_PROMPT_PARAGRAPH).toBe(
      '# 書く言語\n\n' +
        '途中の短い文（道具を使う前の一言）も、報告も、すべて日本語で書く。識別子・ファイル名・コマンド・引用するエラーの文は英語のままでよい。',
    );
  });

  it('ja のとき、担当の system prompt と作業者の指示の末尾に段落が入り、settings.language が japanese になる', async () => {
    const { options } = await open({ [REPORT_LANGUAGE_ENV]: 'ja' });
    expect(appendOf(options)).toBe(`${BASE_APPEND}\n\n${REPORT_LANGUAGE_PROMPT_PARAGRAPH}`);
    expect(workerPromptOf(options)).toBe(
      `${buildWorkerPrompt()}\n\n${REPORT_LANGUAGE_PROMPT_PARAGRAPH}`,
    );
    expect(options.settings).toEqual({
      attribution: { commit: '', pr: '' },
      autoCompactWindow: DEFAULT_AUTO_COMPACT_WINDOW_TOKENS,
      autoMemoryEnabled: false,
      language: 'japanese',
    });
  });

  it('未設定・off のときは、どちらにも段落が入らず、settings に language が無い（今と同じ）', async () => {
    for (const env of [{}, { [REPORT_LANGUAGE_ENV]: 'off' }]) {
      const { options } = await open(env);
      expect(appendOf(options)).toBe(BASE_APPEND);
      expect(workerPromptOf(options)).toBe(buildWorkerPrompt());
      expect(options.settings).toEqual({
        attribution: { commit: '', pr: '' },
        autoCompactWindow: DEFAULT_AUTO_COMPACT_WINDOW_TOKENS,
        autoMemoryEnabled: false,
      });
    }
  });

  it('プロファイルで ja にすると効く（runner の env は未設定）', async () => {
    const { options } = await open({}, `export ${REPORT_LANGUAGE_ENV}=ja`);
    expect(appendOf(options)).toContain(REPORT_LANGUAGE_PROMPT_PARAGRAPH);
    expect(workerPromptOf(options)).toContain(REPORT_LANGUAGE_PROMPT_PARAGRAPH);
    expect((options.settings as { language?: unknown }).language).toBe('japanese');
  });

  it('runner の env が ja でも、プロファイルが off なら足さない', async () => {
    const { options } = await open(
      { [REPORT_LANGUAGE_ENV]: 'ja' },
      `export ${REPORT_LANGUAGE_ENV}=off`,
    );
    expect(appendOf(options)).not.toContain(REPORT_LANGUAGE_PROMPT_PARAGRAPH);
    expect(workerPromptOf(options)).not.toContain(REPORT_LANGUAGE_PROMPT_PARAGRAPH);
    expect(options.settings).not.toHaveProperty('language');
  });

  it('綴り違いでは足さず、セッションは開き、note に1回だけ残す', async () => {
    const { options, events } = await open({ [REPORT_LANGUAGE_ENV]: 'yes' });
    expect(appendOf(options)).toBe(BASE_APPEND);
    expect(workerPromptOf(options)).toBe(buildWorkerPrompt());
    expect(options.settings).not.toHaveProperty('language');
    const misconfig = events.filter(
      (event) =>
        event.type === 'note' && event.text.includes('ALTEROID_REPORT_LANGUAGE の値が不正: yes'),
    );
    expect(misconfig.map((event) => (event as { text: string }).text)).toEqual([
      expect.stringContaining('担当・作業者のプロンプトへの言語の指示も掛けない'),
    ]);
  });

  it('resume で開き直しても同じに効く', async () => {
    const { options } = await open({ [REPORT_LANGUAGE_ENV]: 'ja' }, undefined, 'resume');
    expect(options.resume).toBe('sess-old');
    expect(appendOf(options)).toBe(`${BASE_APPEND}\n\n${REPORT_LANGUAGE_PROMPT_PARAGRAPH}`);
    expect(workerPromptOf(options)).toContain(REPORT_LANGUAGE_PROMPT_PARAGRAPH);
    expect((options.settings as { language?: unknown }).language).toBe('japanese');
  });
});
