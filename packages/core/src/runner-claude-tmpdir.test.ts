import { statSync } from 'node:fs';
import { join } from 'node:path';

import type { Options, Query, SDKMessage, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeTempDirSync } from '../../../vitest.tmpdir.js';

import { createRunnerHost, type RunnerHost, type RunnerHostOptions } from './runner.js';

// 2026-10-13: 540 秒を超えて背景に回った Bash の出力が /tmp/claude-<uid> に書かれ、そこを読まない決まりの担当（BASE-2・ELIN-AUDIT-2 ほか）が結果を読めず、同じ検査を回し直していた

function fakeSdk() {
  const started: Options[] = [];
  const fn = ((params: { prompt: unknown; options?: Options }) => {
    started.push(params.options ?? {});
    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: 'sess-tmpdir',
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
  return { fn, started };
}

const MANAGER_ID = 'mgr-abcd1234-0000-0000-0000-000000000000';

let dir: string;
let hosts: RunnerHost[] = [];

beforeEach(() => {
  dir = makeTempDirSync('alteroid-runner-claude-tmpdir-');
});

afterEach(async () => {
  await Promise.all(hosts.map((host) => host.shutdown().catch(() => undefined)));
  hosts = [];
});

async function startWith(extra: Partial<RunnerHostOptions>, env: Record<string, string> = {}) {
  const { fn, started } = fakeSdk();
  const host = createRunnerHost({
    runnerId: 'runner-test',
    workspacePath: '/work/project',
    emit: () => undefined,
    queryFn: fn,
    env: { PATH: '/usr/bin', ...env },
    outboxRoot: join(dir, 'outbox'),
    outboxStagedRoot: join(dir, 'outbox-staged'),
    managerScratchRoot: join(dir, 'scratch-root'),
    ...extra,
  });
  hosts.push(host);
  await host.start({ managerId: MANAGER_ID, request: '検査して', cwd: '/work/project' });
  await vi.waitFor(() => {
    if (started.length === 0) throw new Error('委譲の CLI がまだ起きていない');
  });
  return started[0] as Options;
}

// 自分の uid を「子」に見立てる: chown が自分の uid へなら通るので、root でなくても別 uid の構成の経路を通せる
function selfAsChild(): Partial<RunnerHostOptions> {
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (uid === undefined || gid === undefined) throw new Error('uid の取れない環境');
  return { childUser: { uid, gid } };
}

describe('委譲の CLI の一時フォルダ（CLAUDE_CODE_TMPDIR）を、担当の作業場の下に置く', () => {
  it('子を別の uid で起こす構成では /tmp/mgr-<先頭8桁>/claude-tmp を 0700 で用意して渡す', async () => {
    const options = await startWith(selfAsChild());

    const expected = join(dir, 'scratch-root', 'mgr-abcd1234', 'claude-tmp');
    expect(options.env?.CLAUDE_CODE_TMPDIR).toBe(expected);
    const stat = statSync(expected);
    expect(stat.isDirectory()).toBe(true);
    expect(stat.mode & 0o777).toBe(0o700);
    expect(stat.uid).toBe(process.getuid?.());
  });

  it('人間が置いた CLAUDE_CODE_TMPDIR は上書きしない', async () => {
    const options = await startWith(selfAsChild(), { CLAUDE_CODE_TMPDIR: '/custom/tmp' });

    expect(options.env?.CLAUDE_CODE_TMPDIR).toBe('/custom/tmp');
  });

  it('対照: 同じ uid で動く構成（子を降ろさない）では足さない', async () => {
    const options = await startWith({});

    expect(options.env?.CLAUDE_CODE_TMPDIR).toBeUndefined();
  });
});
