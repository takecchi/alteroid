import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';

import { createRunnerHost, type RunnerHost } from '@alteroid/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';
import { createRunnerApp, Outbox } from './app.js';

const TOKEN = 'daemon-only-token';
const TOKEN_SHA256 = createHash('sha256').update(TOKEN, 'utf8').digest('hex');
const GIT_ENV = {
  PATH: process.env.PATH ?? '',
  HOME: '/nonexistent',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.com',
};
const g = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' });

describe('POST /rescue-refs/delete', () => {
  let host: RunnerHost;
  let root: string;
  let bare: string;
  let commit: string;
  const ref = 'refs/alteroid-rescue/mgr-x/root-1234abcd';

  const post = (body: unknown, token: string | null = TOKEN) =>
    createRunnerApp({ host, outbox: new Outbox(), tokenSha256: TOKEN_SHA256 }).request(
      '/rescue-refs/delete',
      {
        method: 'POST',
        headers: {
          ...(token === null ? {} : { authorization: `Bearer ${token}` }),
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      },
    );

  beforeEach(async () => {
    host = createRunnerHost({
      runnerId: 'runner-rescue-delete-test',
      workspacePath: '/workspace',
      emit: () => undefined,
      env: GIT_ENV,
    });
    root = await makeTempDir('rescue-delete-route-');
    bare = path.join(root, 'origin.git');
    const work = path.join(root, 'work');
    g(root, 'init', '-q', '--bare', bare);
    g(root, 'init', '-q', '-b', 'main', work);
    g(work, 'commit', '-q', '--allow-empty', '-m', 'x');
    commit = g(work, 'rev-parse', 'HEAD').trim();
    g(work, 'push', '-q', bare, `HEAD:${ref}`, 'HEAD:refs/heads/main');
  });

  afterEach(async () => {
    await host.shutdown();
  });

  it('ローカルのパス・file:// は口からも撃たない（https / ssh / scp 形だけ）。ref は残る', async () => {
    for (const remote of [bare, `file://${bare}`]) {
      const res = await post({ remote, ref, commit });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ outcome: 'failed', kind: 'no-remote' });
    }
    expect(g(bare, 'for-each-ref', 'refs/alteroid-rescue/')).toContain(ref);
  });

  it('名前空間の外の ref は、口からも消せない', async () => {
    const res = await post({
      remote: 'https://example.invalid/o/r.git',
      ref: 'refs/heads/main',
      commit,
    });
    expect(await res.json()).toEqual({ outcome: 'failed', kind: 'other' });
    expect(g(bare, 'for-each-ref', 'refs/heads/')).toContain('refs/heads/main');
  });

  it('形が不正なら 400。トークンが無ければ 401', async () => {
    expect((await post({ remote: bare })).status).toBe(400);
    expect((await post({ remote: bare, ref, commit }, null)).status).toBe(401);
    expect(g(bare, 'for-each-ref', 'refs/alteroid-rescue/')).toContain(ref);
  });
});
