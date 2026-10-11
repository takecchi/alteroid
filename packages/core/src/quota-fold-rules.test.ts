import { describe, expect, it } from 'vitest';

import { DAEMON_RUNNER_REGISTRY_SOURCE } from './daemon-self-notice.js';
import {
  foldableQuotaStopTargetsOf,
  quotaFoldNoticeOf,
  type QuotaRecoverySummary,
} from './quota-recovery-notice.js';
import {
  QUOTA_SESSION_WINDOW_KEY,
  QUOTA_STOP_MANAGER_IDS_KEY,
  allSessionWindow,
  isSessionWindowLimit,
  quotaMarkOf,
} from './quota-stop-notice.js';
import type { InboxEvent } from './schema.js';

const QUEUED_AT = '2026-10-11T20:12:00.000Z';
const NOW_MS = Date.parse('2026-10-11T20:15:00.000Z');
const AFTER = '2026-10-11T20:14:00.000Z';
const BEFORE = '2026-10-11T20:10:00.000Z';

const SESSION = "You've hit your session limit · resets 1:00am (Asia/Tokyo)";
const WEEKLY = "You've hit your weekly limit · resets Oct 14, 9am (Asia/Tokyo)";

function back(managerId: string, extra: Partial<QuotaRecoverySummary> = {}): QuotaRecoverySummary {
  return {
    managerId,
    status: 'running',
    live: true,
    tokenGeneration: 12,
    activeTokenGeneration: 12,
    ...extra,
  };
}

const TARGETS = { managerIds: ['mgr-a', 'mgr-b'], earliestAt: QUEUED_AT };

describe('isSessionWindowLimit — 畳んでよい5時間枠の見分け（#4499）', () => {
  it('rate_limit の種類が在れば、five_hour だけを5時間枠と読み、文言は見ない', () => {
    expect(isSessionWindowLimit({ kind: 'five_hour' })).toBe(true);
    expect(isSessionWindowLimit({ kind: 'seven_day', text: SESSION })).toBe(false);
    expect(isSessionWindowLimit({ kind: 'seven_day_opus' })).toBe(false);
  });

  it('文言は session / 5-hour の枠だけを5時間枠と読む', () => {
    expect(isSessionWindowLimit({ text: SESSION })).toBe(true);
    expect(isSessionWindowLimit({ text: "You've reached your 5-hour limit · resets at 3pm" })).toBe(
      true,
    );
  });

  it('週・月・支出の上限や、枠の種類を名乗らない文言は5時間枠と読まない（届ける側へ倒す）', () => {
    expect(isSessionWindowLimit({ text: WEEKLY })).toBe(false);
    expect(
      isSessionWindowLimit({ text: "You've hit your org's monthly spend limit · resets Nov 1" }),
    ).toBe(false);
    expect(isSessionWindowLimit({ text: "You've hit your limit · resets 3pm" })).toBe(false);
    expect(isSessionWindowLimit({})).toBe(false);
  });

  it('枠の印は5時間枠のときだけ sessionWindow を持ち、束は全断片が持つときだけ5時間枠になる', () => {
    const session = quotaMarkOf({ text: SESSION }, NOW_MS);
    const weekly = quotaMarkOf({ text: WEEKLY }, NOW_MS);
    expect(session.sessionWindow).toBe(true);
    expect(weekly.sessionWindow).toBeUndefined();
    expect(allSessionWindow([{ quota: session }, { quota: session }])).toBe(true);
    expect(allSessionWindow([{ quota: session }, { quota: weekly }])).toBe(false);
    expect(allSessionWindow([])).toBe(false);
  });
});

describe('foldableQuotaStopTargetsOf（#4499）', () => {
  it('5時間枠の印がある担当の知らせとプール全体の1通だけを、畳む候補にする', () => {
    const report: InboxEvent = {
      type: 'manager_message',
      id: 'ev-1',
      at: QUEUED_AT,
      managerId: 'mgr-a',
      kind: 'report',
      text: '応答を返さずに終わった',
      synthesized: true,
      quotaStop: true,
      quotaSessionWindow: true,
    };
    const pool: InboxEvent = {
      type: 'external',
      id: 'ev-2',
      at: QUEUED_AT,
      source: DAEMON_RUNNER_REGISTRY_SOURCE,
      payload: {
        text: '枠に当たって 2 本の担当が止まった',
        [QUOTA_STOP_MANAGER_IDS_KEY]: ['mgr-a', 'mgr-b'],
        [QUOTA_SESSION_WINDOW_KEY]: true,
      },
    };
    expect(foldableQuotaStopTargetsOf(report)?.managerIds).toEqual(['mgr-a']);
    expect(foldableQuotaStopTargetsOf(pool)?.managerIds).toEqual(['mgr-a', 'mgr-b']);
  });

  it('5時間枠の印が無い（週の上限など）枠の知らせは、畳む候補にしない', () => {
    const weekly: InboxEvent = {
      type: 'manager_message',
      id: 'ev-3',
      at: QUEUED_AT,
      managerId: 'mgr-a',
      kind: 'report',
      text: '利用上限の通知が来た',
      synthesized: true,
      quotaStop: true,
    };
    const weeklyPool: InboxEvent = {
      type: 'external',
      id: 'ev-4',
      at: QUEUED_AT,
      source: DAEMON_RUNNER_REGISTRY_SOURCE,
      payload: { text: '枠に当たって 2 本', [QUOTA_STOP_MANAGER_IDS_KEY]: ['mgr-a'] },
    };
    expect(foldableQuotaStopTargetsOf(weekly)).toBeUndefined();
    expect(foldableQuotaStopTargetsOf(weeklyPool)).toBeUndefined();
  });
});

describe('quotaFoldNoticeOf — 担当が全員戻っているときだけ畳む（#4499）', () => {
  it('全員がいまの世代の鍵で running なら、日誌へ書く判定の1節を返す', () => {
    const notice = quotaFoldNoticeOf(TARGETS, [back('mgr-a'), back('mgr-b')], NOW_MS);
    expect(notice).toContain('全員いまの世代の鍵で戻っていた');
    expect(notice).toContain('すべて回復している');
  });

  it('done は、知らせより後に成功したターンの報告があるときだけ戻ったと読む', () => {
    const done = { status: 'done' as const, lastReportAt: AFTER };
    expect(quotaFoldNoticeOf(TARGETS, [back('mgr-a'), back('mgr-b', done)], NOW_MS)).not.toBeNull();
    for (const notYet of [
      { ...done, lastReportAt: BEFORE },
      { status: 'done' as const },
      { ...done, lastFailure: { code: 'rate_limit', via: 'assistant', at: AFTER } },
      { ...done, lastUnreported: { reason: 'aborted', at: AFTER } },
    ]) {
      expect(quotaFoldNoticeOf(TARGETS, [back('mgr-a'), back('mgr-b', notYet)], NOW_MS)).toBeNull();
    }
  });

  it('1本でも止まったまま・failed・lost・live でない・世代違い・一覧に居ない担当がいれば畳まない', () => {
    for (const other of [
      back('mgr-b', { usageStoppedAt: QUEUED_AT }),
      back('mgr-b', { status: 'failed' }),
      back('mgr-b', { status: 'lost', live: false }),
      back('mgr-b', { live: false }),
      back('mgr-b', { tokenGeneration: 11 }),
      back('mgr-b', { tokenGeneration: undefined }),
      back('mgr-z'),
    ]) {
      expect(quotaFoldNoticeOf(TARGETS, [back('mgr-a'), other], NOW_MS)).toBeNull();
    }
  });

  it('担当一覧を引けなかったときは畳まない（確かめられないまま消さない）', () => {
    expect(quotaFoldNoticeOf(TARGETS, { detail: 'db down' }, NOW_MS)).toBeNull();
  });
});
