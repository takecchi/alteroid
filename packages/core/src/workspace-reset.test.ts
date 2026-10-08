import { describe, expect, it } from 'vitest';

import { createMemoryStores } from './testing.js';
import { RESET_CONFIRM_GROUPS, resetWorkspaceState } from './workspace-reset.js';

describe('resetWorkspaceState', () => {
  it('トークン情報（tokens / credentials / auth）以外を全部消す', async () => {
    const stores = createMemoryStores();

    await stores.persona.write('about-me', '# 記憶');
    await stores.journal.append({ type: 'decision', decision: 'x', grounds: 'y' });
    await stores.jobs.putJob({
      id: 'job-1',
      status: 'running',
      summary: 'テスト用のジョブ',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    await stores.jobs.putApproval({
      id: 'approval-1',
      createdAt: '2026-01-01T00:00:00.000Z',
      question: 'q',
    });
    await stores.schedules.put({
      kind: 'custom-1',
      spec: { type: 'every', minutes: 60 },
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      request: 'r',
    });
    await stores.schedules.putPhase({
      kind: 'daily_report',
      lastScheduledRunAt: '2026-01-01T00:00:00.000Z',
    });
    await stores.inbox.put(
      {
        type: 'human_message',
        id: 'evt-1',
        at: '2026-01-01T00:00:00.000Z',
        text: 'hi',
        conversationId: 'conv-1',
      },
      '2026-01-01T00:00:00.000Z',
    );
    await stores.commitments.open({
      id: 'commit-1',
      at: '2026-01-01T00:00:00.000Z',
      body: 'b',
      origin: 'self',
    });
    await stores.practices.write({
      slug: 'implementation',
      kind: '実装',
      title: '実装のやり方',
      content: 'まず現物を読む',
    });
    await stores.archive.archive('session-1', '{"line":1}\n');
    await stores.sessions.setCloneSessionId('session-xyz');
    await stores.profile.set('default', 'export FOO=bar', 'all');
    await stores.usage.record({
      layer: 'manager',
      site: 'session',
      managerId: 'mgr-1',
      date: '2026-01-01',
      at: '2026-01-01T00:00:00.000Z',
      snapshot: { models: {} },
      accumulation: 'oneshot',
    });

    // 添付は、保存したものも消える（#4006。保存した添付は期限が無いので、リセットが唯一の掃除になる）
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
    const keptAttachment = await stores.attachments.put({
      name: 'kept.png',
      mediaType: 'image/png',
      bytes: png,
      kept: true,
    });
    const plainAttachment = await stores.attachments.put({
      name: 'plain.png',
      mediaType: 'image/png',
      bytes: png,
    });

    await stores.tokens.replace([{ id: 'tok-1', label: 'primary', order: 0, value: 'secret' }]);
    await stores.credentials.put([{ name: 'GH_TOKEN', value: 'ghp_x' }]);
    await stores.auth.putAccount({
      id: 'acct-1',
      displayName: 'たけあき',
      email: 'a@example.com',
      createdAt: '2026-01-01T00:00:00.000Z',
      lastLoginAt: null,
      grantedAt: '2026-01-01T00:00:00.000Z',
      grantedBy: 'operator',
      ownerDeclaredAt: null,
    });

    const summary = await resetWorkspaceState(stores);

    expect(summary).toMatchObject({
      memory: 1,
      journal: 1,
      jobs: 1,
      approvals: 1,
      schedules: 1,
      schedulePhases: 1,
      inbox: 1,
      commitments: 1,
      practices: 1,
      archive: 1,
      sessions: 1,
      profile: 1,
      usageDaily: 0,
      usageBaseline: 0,
      usageLedger: 1,
      usageTurns: 0,
      attachments: 2,
    });
    expect(summary.sessionLog).toBeUndefined();
    expect(await stores.attachments.getMeta(keptAttachment.id)).toBeUndefined();
    expect(await stores.attachments.get(plainAttachment.id)).toBeUndefined();
    expect((await stores.attachments.list({ limit: 10 })).items).toEqual([]);
    expect((await stores.attachments.usage()).count).toBe(0);

    expect(await stores.persona.list()).toEqual([]);
    expect(await stores.journal.list()).toEqual([]);
    expect(await stores.jobs.listJobs()).toEqual([]);
    expect((await stores.jobs.listApprovals()).entries).toEqual([]);
    expect((await stores.schedules.list()).entries).toEqual([]);
    expect(await stores.schedules.getPhase('daily_report')).toBeNull();
    expect((await stores.inbox.peekPending()).entries.length).toBe(0);
    expect((await stores.commitments.list({ includeClosed: true })).entries).toEqual([]);
    expect((await stores.practices.list()).entries).toEqual([]);
    expect(await stores.archive.list()).toEqual([]);
    expect(await stores.sessions.getCloneSessionId()).toBeNull();
    expect(await stores.profile.list()).toEqual([]);
    expect((await stores.usage.aggregate({})).rows).toEqual([]);

    expect(await stores.tokens.list()).toMatchObject([{ id: 'tok-1', value: 'secret' }]);
    expect(await stores.credentials.list()).toMatchObject([{ name: 'GH_TOKEN', value: 'ghp_x' }]);
    expect(await stores.auth.listAccounts()).toMatchObject([{ id: 'acct-1' }]);
  });

  it('clearSessionLog を渡したときだけ sessionLog を申告する', async () => {
    const stores = createMemoryStores();

    const withoutOption = await resetWorkspaceState(stores);
    expect(withoutOption.sessionLog).toBeUndefined();

    const withOption = await resetWorkspaceState(stores, {
      clearSessionLog: async () => 42,
    });
    expect(withOption.sessionLog).toBe(42);
  });

  it('⭐ RESET_CONFIRM_GROUPS の keys が WorkspaceResetSummary の全キーを重複や漏れ無く覆っている', async () => {
    const summary = await resetWorkspaceState(createMemoryStores());
    const expectedKeys = [...Object.keys(summary), 'sessionLog'].sort();
    const coveredKeys = RESET_CONFIRM_GROUPS.flatMap((group) => group.keys).sort();
    expect(
      coveredKeys,
      '【赤の意味】RESET_CONFIRM_GROUPS の keys が WorkspaceResetSummary の全キーと' +
        '一致しない（漏れ・重複のどちらか）。新しいストアを足したなら group を足すこと。',
    ).toEqual(expectedKeys);
  });

  it('何も無い状態で呼んでも全部0を返す（空の状態から作るテストで踏める形にしておく）', async () => {
    const stores = createMemoryStores();
    const summary = await resetWorkspaceState(stores);
    expect(summary).toMatchObject({
      memory: 0,
      journal: 0,
      jobs: 0,
      approvals: 0,
      schedules: 0,
      schedulePhases: 0,
      inbox: 0,
      commitments: 0,
      practices: 0,
      archive: 0,
      sessions: 0,
      profile: 0,
      usageDaily: 0,
      usageBaseline: 0,
      usageLedger: 0,
      usageTurns: 0,
      attachments: 0,
    });
  });
});
