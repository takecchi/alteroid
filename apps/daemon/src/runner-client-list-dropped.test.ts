import { captureStderr, listRunnerManagers } from '@alteroid/core';
import { describe, expect, it } from 'vitest';

import { createHttpRunner } from './runner-client.js';

const TOKEN = 'test-runner-token';
const SECRET_REQUEST = 'sk-should-not-appear-in-trace';

function fetchWithManagers(managers: unknown[]): typeof fetch {
  return (async (input: string | URL | Request) => {
    const path = new URL(typeof input === 'string' ? input : input.toString()).pathname;
    if (path === '/health') {
      return Response.json({ runnerId: 'runner-future', workspacePath: '/workspace' });
    }
    if (path === '/managers') return Response.json({ managers });
    throw new Error(`このテストの偽 runner が想定していないパス: ${path}`);
  }) as typeof fetch;
}

const MANAGERS = [
  {
    managerId: 'mgr-ok',
    status: 'running',
    cwd: '/workspace/a',
    request: '普通',
    waiting: [],
    liveBackgroundTasks: 0,
  },
  {
    managerId: 'mgr-future',
    status: 'archiving',
    cwd: '/workspace/b',
    request: SECRET_REQUEST,
    waiting: [],
  },
];

describe('HttpRunner#list() は飛ばした委譲の跡を残す（#1661）', () => {
  it('知らない status の委譲を飛ばしたら、managerId と欄の名前を stderr に残す（値は残さない）', async () => {
    const client = await createHttpRunner({
      baseUrl: 'http://future.test',
      token: TOKEN,
      fetchFn: fetchWithManagers(MANAGERS),
    });

    let managers: Awaited<ReturnType<typeof client.list>> = [];
    const lines = await captureStderr(async () => {
      managers = await client.list();
    });

    expect(managers.map((m) => m.managerId)).toEqual(['mgr-ok']);
    const text = lines.join('\n');
    expect(text).toContain('の委譲一覧で、こちらのスキーマに合わない 1 件を飛ばした');
    expect(text).toContain('managerId=mgr-future 欄=status');
    expect(text).not.toContain('archiving');
    expect(text).not.toContain(SECRET_REQUEST);
  });

  it('同じ委譲・同じ欄の組は、周期ごとに出さず初出だけ残す', async () => {
    const client = await createHttpRunner({
      baseUrl: 'http://future.test',
      token: TOKEN,
      fetchFn: fetchWithManagers(MANAGERS),
    });

    const first = await captureStderr(async () => {
      await client.list();
    });
    const second = await captureStderr(async () => {
      await client.list();
    });

    expect(first.join('\n')).toContain('managerId=mgr-future');
    expect(second.join('\n')).not.toContain('managerId=mgr-future');
  });
});

describe('kind / askedAt を持たない waiting は読めないものとして数える（#5771）', () => {
  const LEGACY_WAITING = [
    {
      managerId: 'mgr-legacy-waiting',
      status: 'waiting_human',
      cwd: '/workspace/c',
      request: '古い runner',
      waiting: [{ requestId: 'req-legacy', summary: '許可してよいか' }],
    },
  ];

  it('欄の無い waiting を持つ委譲は list() から外れ、stderr に飛ばした跡が残る', async () => {
    const client = await createHttpRunner({
      baseUrl: 'http://legacy.test',
      token: TOKEN,
      fetchFn: fetchWithManagers([MANAGERS[0], ...LEGACY_WAITING]),
    });

    let managers: Awaited<ReturnType<typeof client.list>> = [];
    const lines = await captureStderr(async () => {
      managers = await client.list();
    });

    expect(managers.map((m) => m.managerId)).toEqual(['mgr-ok']);
    expect(lines.join('\n')).toContain('managerId=mgr-legacy-waiting');
  });

  it('listRunnerManagers は欄の無い waiting の委譲を unreadableIds に載せる', async () => {
    const client = await createHttpRunner({
      baseUrl: 'http://legacy.test',
      token: TOKEN,
      fetchFn: fetchWithManagers(LEGACY_WAITING),
    });

    await captureStderr(async () => {
      const result = await listRunnerManagers(client);
      expect(result.states).toEqual([]);
      expect(result.unreadableIds).toEqual(['mgr-legacy-waiting']);
    });
  });
});

describe('HttpRunner#listWithUnreadable() は、読めなかった委譲の managerId を返す（#1661）', () => {
  it('スキーマに落ちた委譲も、managerId だけは unreadableIds に載る（Pool が「居る」側に数える材料）', async () => {
    const client = await createHttpRunner({
      baseUrl: 'http://future.test',
      token: TOKEN,
      fetchFn: fetchWithManagers([
        ...MANAGERS,
        // managerId すら読めない要素は id を作らずに外す。
        { status: 'archiving' },
      ]),
    });

    const listing = await captureStderr(async () => {
      const result = await listRunnerManagers(client);
      expect(result.states.map((m) => m.managerId)).toEqual(['mgr-ok']);
      expect(result.unreadableIds).toEqual(['mgr-future']);
    });
    expect(listing.join('\n')).toContain('こちらのスキーマに合わない 2 件を飛ばした');
  });

  it('liveBackgroundTasks の無い要素（古い runner）は、読めない扱いになり、0 本とは読まない（#5763）', async () => {
    const client = await createHttpRunner({
      baseUrl: 'http://old.test',
      token: TOKEN,
      fetchFn: fetchWithManagers([
        {
          managerId: 'mgr-old',
          status: 'done',
          cwd: '/workspace/c',
          request: '古い',
          waiting: [],
        },
      ]),
    });

    const lines = await captureStderr(async () => {
      const result = await listRunnerManagers(client);
      expect(result.states).toEqual([]);
      expect(result.unreadableIds).toEqual(['mgr-old']);
    });
    expect(lines.join('\n')).toContain('managerId=mgr-old 欄=liveBackgroundTasks');
  });
});
