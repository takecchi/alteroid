import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { captureStderr } from '@alteroid/core';
import type { Stores } from '@alteroid/core';
import { beforeEach, describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

import { createFsStores } from './index.js';

// 「行ごとに検査し、読めない行は生のまま取っておき、stderr へ1行出す」を、表ごとに文面ごと固定する。
// 読めない行は2つ入れる: 識別子の欄が文字列の行（` id="…"` などが付く）と、オブジェクトですらない行（何も付かない）
interface Case {
  label: string;
  // `root` からの相対パスを返す
  file: (stores: ReturnType<typeof createFsStores>) => string;
  // ファイル内の配列の名前（stderr の表の名前と同じ）
  table: string;
  keyField: string;
  // 1 行目の「不正な欄: …」に出る欄名（zod の issue の順）
  fields: string;
  // 識別子の欄だけでは不正にならない表で、行を不正にするための欄
  extra?: Record<string, unknown>;
  read: (stores: Stores) => Promise<unknown>;
  // ファイルを書き直す操作。取っておいた生の行が残るかを見る
  write: (stores: Stores) => Promise<unknown>;
}

const GOOD_JOB = {
  id: 'mgr-good',
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  status: 'done' as const,
  summary: 'good',
};

const GOOD_SCHEDULE = {
  kind: 'good-kind',
  spec: { type: 'every' as const, minutes: 60 },
  request: 'good',
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
};

const GOOD_ACCOUNT = {
  id: 'acct-good',
  displayName: 'Good Owner',
  email: 'good@example.test',
  createdAt: '2026-01-01T00:00:00.000Z',
  lastLoginAt: null,
  grantedAt: '2026-01-01T00:00:00.000Z',
  grantedBy: 'operator',
};

const CASES: Case[] = [
  {
    label: 'jobs',
    file: (s) => join(s.paths.jobs, 'jobs.json'),
    table: 'jobs',
    keyField: 'id',
    fields: 'createdAt,updatedAt,status,summary',
    read: (s) => s.jobs.listJobs(),
    write: (s) => s.jobs.putJob(GOOD_JOB),
  },
  {
    label: 'approvals',
    file: (s) => join(s.paths.jobs, 'jobs.json'),
    table: 'approvals',
    keyField: 'id',
    fields: 'createdAt,question',
    read: (s) => s.jobs.listApprovals(),
    write: (s) => s.jobs.putJob(GOOD_JOB),
  },
  {
    label: 'accounts',
    file: (s) => join(s.paths.auth, 'auth.json'),
    table: 'accounts',
    keyField: 'id',
    fields: 'displayName,email,createdAt,lastLoginAt,grantedAt,grantedBy',
    read: (s) => s.auth.listAccounts(),
    write: (s) => s.auth.putAccount(GOOD_ACCOUNT),
  },
  {
    label: 'accessTokens',
    file: (s) => join(s.paths.auth, 'auth.json'),
    table: 'accessTokens',
    keyField: 'id',
    fields: 'accountId,sha256,label,createdAt,expiresAt,lastUsedAt,revokedAt',
    read: (s) => s.auth.listAccounts(),
    write: (s) => s.auth.putAccount(GOOD_ACCOUNT),
  },
  {
    label: 'loginRequests',
    file: (s) => join(s.paths.auth, 'auth.json'),
    table: 'loginRequests',
    keyField: 'id',
    fields:
      'provider,nonce,codeVerifier,claimSha256,redirectUri,label,createdAt,expiresAt,status,accountId,error',
    read: (s) => s.auth.listAccounts(),
    write: (s) => s.auth.putAccount(GOOD_ACCOUNT),
  },
  {
    label: 'practices',
    file: (s) => join(s.paths.jobs, 'practices.json'),
    table: 'practices',
    keyField: 'slug',
    fields: 'slug,kind,title,createdAt,updatedAt,content',
    read: (s) => s.practices.list(),
    write: (s) => s.practices.write({ slug: 'good', kind: 'k', title: 't', content: 'c' }),
  },
  {
    label: 'practiceVersions',
    file: (s) => join(s.paths.jobs, 'practices.json'),
    table: 'practiceVersions',
    keyField: 'slug',
    fields: 'slug,version,kind,title,at,content',
    read: (s) => s.practices.list(),
    write: (s) => s.practices.write({ slug: 'good', kind: 'k', title: 't', content: 'c' }),
  },
  {
    label: 'schedules',
    file: (s) => join(s.paths.jobs, 'schedules.json'),
    table: 'schedules',
    keyField: 'kind',
    fields: 'kind,spec,request,createdAt,updatedAt',
    read: (s) => s.schedules.list(),
    write: (s) => s.schedules.put(GOOD_SCHEDULE),
  },
  {
    label: 'phases',
    file: (s) => join(s.paths.jobs, 'schedules.json'),
    table: 'phases',
    keyField: 'kind',
    fields: 'lastRunAt',
    extra: { lastRunAt: 'not-a-date' },
    read: (s) => s.schedules.list(),
    write: (s) => s.schedules.put(GOOD_SCHEDULE),
  },
  {
    label: 'credentials',
    file: (s) => s.paths.credentials,
    table: 'credentials',
    keyField: 'name',
    fields: 'name,value,updatedAt,secret',
    read: (s) => s.credentials.list(),
    write: (s) => s.credentials.put([{ name: 'GH_TOKEN', value: 'v' }]),
  },
  {
    label: 'tokens',
    file: (s) => s.paths.tokens,
    table: 'tokens',
    keyField: 'id',
    fields: 'label,order',
    read: (s) => s.tokens.list(),
    write: (s) => s.tokens.replace([]),
  },
];

describe('fs ストア — 読めない行を取っておき、stderr へ1行出す（文面と順序を固定）', () => {
  let root: string;

  beforeEach(async () => {
    root = await makeTempDir('alteroid-test-');
  });

  for (const c of CASES) {
    it(`${c.label}: 文面・順序・生の行の持ち越し`, async () => {
      const stores = createFsStores(root);
      const path = c.file(stores);
      const keyed = { [c.keyField]: 'bad-"1', secret: 'must-not-appear', ...c.extra };
      const notObject = 42;
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, `${JSON.stringify({ [c.table]: [keyed, notObject] })}\n`);

      const lines = await captureStderr(async () => {
        await c.read(stores);
      });

      expect(lines).toEqual([
        `alteroid: ${c.table} の不正な行を読み飛ばしました（1 行目、不正な欄: ${c.fields}） ` +
          `${c.keyField}="bad-\\"1"\n`,
        `alteroid: ${c.table} の不正な行を読み飛ばしました（2 行目、不正な欄: (root)）\n`,
      ]);
      expect(lines.join('')).not.toContain('must-not-appear');

      await captureStderr(async () => {
        await c.write(createFsStores(root));
      });
      const raw = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown[]>;
      expect(raw[c.table]?.slice(-2)).toEqual([keyed, notObject]);
    });
  }
});
