import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Options, Query, SDKMessage, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeTempDirSync } from '../../../vitest.tmpdir.js';

import { createRunnerHost, type RunnerHost, type RunnerHostOptions } from './runner.js';

// 生ログから resume した担当は、SDK が材料を /tmp/claude-resume-* に書き出してそこで動き、CLI が終わると消えていた。
// 長すぎた出力の保存もそこへ書かれ、/tmp/claude-* を読まない担当から見えなかった（2026-10-13。#4613 と同じ根）

const PROJECT_KEY = '-workspace';
const ENTRIES = [
  { type: 'user', message: { role: 'user', content: '検査して' } },
  { type: 'assistant', message: { role: 'assistant', content: '半分まで済んだ' } },
];

// 本物の SDK と同じく、resume のときは CLI を起こす前に材料を1回だけ引く
function fakeSdk() {
  const loaded: unknown[] = [];
  const fn = ((params: { prompt: unknown; options?: Options }) => {
    const options = params.options ?? {};
    async function* generate(): AsyncGenerator<SDKMessage, void> {
      if (options.resume !== undefined && options.sessionStore !== undefined) {
        loaded.push(
          await options.sessionStore.load({ projectKey: PROJECT_KEY, sessionId: options.resume }),
        );
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
  return { fn, loaded };
}

let dir: string;
let hosts: RunnerHost[] = [];

beforeEach(() => {
  dir = makeTempDirSync('alteroid-runner-resume-seed-');
});

afterEach(async () => {
  await Promise.all(hosts.map((host) => host.shutdown().catch(() => undefined)));
  hosts = [];
});

async function resumeWith(extra: Partial<RunnerHostOptions>) {
  const { fn, loaded } = fakeSdk();
  const host = createRunnerHost({
    runnerId: 'runner-test',
    workspacePath: '/workspace',
    emit: () => undefined,
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
    entries: ENTRIES,
  });
  await vi.waitFor(() => {
    if (loaded.length === 0) throw new Error('材料がまだ引かれていない');
  });
  return loaded[0];
}

// 自分の uid を「子」に見立てる（chown が自分の uid へなら通るため）
function selfAsChild(home: string): Partial<RunnerHostOptions> {
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (uid === undefined || gid === undefined) throw new Error('uid の取れない環境');
  return { childUser: { uid, gid, home } };
}

describe('resume の材料を、SDK の一時ディレクトリではなく子のふだんの設定ディレクトリに置く', () => {
  it('<子の HOME>/.claude/projects/<projectKey>/<sessionId>.jsonl に SDK と同じ形で置き、SDK には材料を返さない', async () => {
    const home = join(dir, 'home');
    mkdirSync(home);

    const loaded = await resumeWith(selfAsChild(home));

    expect(loaded).toBeNull();
    const file = join(home, '.claude', 'projects', PROJECT_KEY, 'sess-old.jsonl');
    expect(readFileSync(file, 'utf8')).toBe(
      ENTRIES.map((entry) => `${JSON.stringify(entry)}\n`).join(''),
    );
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(file).uid).toBe(process.getuid?.());
  });

  it('同じ会話が既に置き場に在れば上書きしない（CLI が書き続けたほうが新しい）', async () => {
    const home = join(dir, 'home');
    const projectDir = join(home, '.claude', 'projects', PROJECT_KEY);
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, 'sess-old.jsonl'), '{"newer":true}\n');

    const loaded = await resumeWith(selfAsChild(home));

    expect(loaded).toBeNull();
    expect(readFileSync(join(projectDir, 'sess-old.jsonl'), 'utf8')).toBe('{"newer":true}\n');
  });

  it('対照: 同じ uid で動く構成（子を降ろさない）では、今どおり SDK に材料を返す', async () => {
    const loaded = await resumeWith({});

    expect(loaded).toEqual(ENTRIES);
  });
});
