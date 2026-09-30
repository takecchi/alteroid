import { describe, expect, it } from 'vitest';

import { createMemoryStores } from './testing.js';
import { RESET_CONFIRM_GROUPS, resetWorkspaceState } from './workspace-reset.js';

/**
 * `resetWorkspaceState` の中身は「何を残すか」がすべてなので、歯もそこへ
 * 焦点を当てる——消える10ストアが本当に空になること、残す3ストア
 * （`tokens` / `credentials` / `auth`）が1バイトも変わらないことの両方を
 * 1つの歯の中で確かめる（片方だけ測ると、もう片方が黙って壊れても気づけない）。
 */
describe('resetWorkspaceState', () => {
  it('トークン情報（tokens / credentials / auth）以外を全部消す', async () => {
    const stores = createMemoryStores();

    // --- 消える側を埋める ---
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
    await stores.profile.write('export FOO=bar');
    await stores.usage.record({
      layer: 'manager',
      site: 'session',
      managerId: 'mgr-1',
      date: '2026-01-01',
      at: '2026-01-01T00:00:00.000Z',
      snapshot: { models: {} },
      accumulation: 'oneshot',
    });

    // --- 残す側（トークン情報）を埋める ---
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

    // --- 申告どおりの件数 ---
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
      usageDaily: 0, // `snapshot.models` が空なので increment は無い（`foldOneshotUsage` の仕様）
      usageBaseline: 0,
      usageLedger: 1,
      usageTurns: 0,
    });
    expect(summary.sessionLog).toBeUndefined();

    // --- 消える側は本当に空になっている ---
    expect(await stores.persona.list()).toEqual([]);
    expect(await stores.journal.list()).toEqual([]);
    expect(await stores.jobs.listJobs()).toEqual([]);
    expect((await stores.jobs.listApprovals()).entries).toEqual([]);
    expect((await stores.schedules.list()).entries).toEqual([]);
    expect(await stores.schedules.getPhase('daily_report')).toBeNull();
    expect((await stores.inbox.peekPending()).entries.length).toBe(0);
    expect((await stores.commitments.list({ includeClosed: true })).entries).toEqual([]);
    // ⭐ **消したのに申告へ出ない形を作らない**（`WorkspaceResetSummary.practices`）。
    expect((await stores.practices.list()).entries).toEqual([]);
    expect(await stores.archive.list()).toEqual([]);
    expect(await stores.sessions.getCloneSessionId()).toBeNull();
    expect(await stores.profile.read()).toBeNull();
    expect((await stores.usage.aggregate({})).rows).toEqual([]);

    // --- 残す側は1件も変わっていない ---
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

  /**
   * ⭐ **issue #2224。`RESET_CONFIRM_GROUPS`（CLI の確認の文・`POST /reset` の
   * OpenAPI description、両方の出所）が `WorkspaceResetSummary` の全キーを
   * 重複や漏れ無く覆っていることを測る。**
   *
   * `apps/cli/src/reset.test.ts` の同種の歯（`SUMMARY_LABELS` 相手）と対で、
   * こちらは**実物の `resetWorkspaceState` が返す鍵の集合**（=手で書き写した
   * 型ではなく実装そのもの）と比べる——`reset-summary-shape.test.ts`
   * （`apps/daemon/src/reset-summary-shape.test.ts`）と同じ測り方。
   *
   * **この歯が捕まえる穴**: `RESET_CONFIRM_GROUPS` から group を1つ（例:
   * 「仕事のやり方」`practices`）消すと、その分のキーが確認の文からも
   * `POST /reset` の description からも黙って消える——issue #2196 で一度
   * 実際に起きた抜けと同じ形（そのときは CLI にだけ在った一覧が古いままで、
   * `POST /reset` の description は #2224 で3か所目として見つかった）。
   */
  it('⭐ RESET_CONFIRM_GROUPS の keys が WorkspaceResetSummary の全キーを重複や漏れ無く覆っている', async () => {
    const summary = await resetWorkspaceState(createMemoryStores());
    // `sessionLog` は pg 構成でだけ付く（`WorkspaceResetSummary.sessionLog` の
    // doc）。インメモリの器では出ないので、`reset-summary-shape.test.ts` と
    // 同じく突き合わせる側に足す。
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
    // `createMemoryStores()` は種の記憶を1枚も自動で置かない（`seedPgWorkspace`
    // 相当の処理は `openStorage` 側の責務で、ここには無い）。
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
    });
  });
});
