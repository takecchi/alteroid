import { captureStderr, listRunnerManagers } from '@alteroid/core';
import { describe, expect, it } from 'vitest';

import { createHttpRunner } from './runner-client.js';

/**
 * **`HttpRunner#list()` は、スキーマに合わない委譲を飛ばしても黙らない**（#1661）。
 *
 * 飛ばした委譲は Pool から見て「runner に居ない」側に落ち、待っていた確認まで
 * 捨てられうる（`runner-protocol.ts` の `runnerWaitingSchema` の doc）。典型は、
 * runner が先に新しい版になって、デーモンのまだ知らない `status` を送る版ずれで
 * ある。以前は `flatMap` で跡なく捨てていた。
 */

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
  { managerId: 'mgr-ok', status: 'running', cwd: '/workspace/a', request: '普通', waiting: [] },
  {
    managerId: 'mgr-future',
    // `jobStatusSchema` にまだ無い値（runner だけが先に名乗る版ずれを模す）。
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

    // 読める委譲は今までどおり返る。
    expect(managers.map((m) => m.managerId)).toEqual(['mgr-ok']);
    const text = lines.join('\n');
    expect(text).toContain('の委譲一覧で、こちらのスキーマに合わない 1 件を飛ばした');
    expect(text).toContain('managerId=mgr-future 欄=status');
    // 値（知らない status の字面・依頼の本文）は跡へ流さない。
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

describe('HttpRunner#listWithUnreadable() は、読めなかった委譲の managerId を返す（#1661）', () => {
  it('スキーマに落ちた委譲も、managerId だけは unreadableIds に載る（Pool が「居る」側に数える材料）', async () => {
    const client = await createHttpRunner({
      baseUrl: 'http://future.test',
      token: TOKEN,
      fetchFn: fetchWithManagers([
        ...MANAGERS,
        // managerId すら読めない要素は、id を作らずに外す。
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
});
