import { describe, expect, it } from 'vitest';

import { DAEMON_RUNNER_REGISTRY_SOURCE } from './daemon-self-notice.js';
import {
  describeQuotaRecovery,
  quotaStopTargetsOf,
  type QuotaRecoverySummary,
} from './quota-recovery-notice.js';
import { QUOTA_STOP_MANAGER_IDS_KEY } from './quota-stop-notice.js';
import type { InboxEvent } from './schema.js';

const QUEUED_AT = '2026-10-11T18:56:00.000Z';
const DELIVERED_MS = Date.parse('2026-10-11T19:13:30.000Z');

function quotaReport(managerId: string, at = QUEUED_AT): InboxEvent {
  return {
    type: 'manager_message',
    id: `ev-${managerId}`,
    at,
    managerId,
    kind: 'report',
    text: '利用上限に当たった',
    synthesized: true,
    quotaStop: true,
  };
}

function poolNotice(managerIds: string[], at = QUEUED_AT): InboxEvent {
  return {
    type: 'external',
    id: 'ev-pool',
    at,
    source: DAEMON_RUNNER_REGISTRY_SOURCE,
    payload: {
      text: '枠に当たって 2 本の担当が止まった',
      [QUOTA_STOP_MANAGER_IDS_KEY]: managerIds,
    },
  };
}

function recovered(managerId: string): QuotaRecoverySummary {
  return {
    managerId,
    status: 'running',
    live: true,
    tokenGeneration: 13,
    activeTokenGeneration: 13,
  };
}

describe('quotaStopTargetsOf（#4497）', () => {
  it('quotaStop の担当の報告と、プール全体の1通が名指す担当を、重複なく到着順に集める', () => {
    const targets = quotaStopTargetsOf([
      quotaReport('mgr-a', '2026-10-11T18:53:00.000Z'),
      poolNotice(['mgr-a', 'mgr-b'], '2026-10-11T18:52:30.000Z'),
    ]);
    expect(targets).toEqual({
      managerIds: ['mgr-a', 'mgr-b'],
      earliestAt: '2026-10-11T18:52:30.000Z',
    });
  });

  it('枠の印が無い報告・別の source の external・担当を名指さない runner-registry の1通は対象にしない', () => {
    const plain: InboxEvent = {
      type: 'manager_message',
      id: 'ev-plain',
      at: QUEUED_AT,
      managerId: 'mgr-a',
      kind: 'report',
      text: '利用上限に当たった',
      synthesized: true,
    };
    const otherSource: InboxEvent = {
      type: 'external',
      id: 'ev-other',
      at: QUEUED_AT,
      source: 'token-pool',
      payload: { text: '鍵が戻った', [QUOTA_STOP_MANAGER_IDS_KEY]: ['mgr-b'] },
    };
    const unnamed: InboxEvent = {
      type: 'external',
      id: 'ev-unnamed',
      at: QUEUED_AT,
      source: DAEMON_RUNNER_REGISTRY_SOURCE,
      payload: { text: '器が消えた' },
    };
    expect(quotaStopTargetsOf([plain, otherSource, unnamed])).toBeUndefined();
  });
});

describe('describeQuotaRecovery（#4497）', () => {
  it('名指す担当が全員回復していれば、いま止まっていると読まないよう名指しで添え、確かめ直しが要らないと言う', () => {
    const text = describeQuotaRecovery(
      { managerIds: ['mgr-a', 'mgr-b'], earliestAt: QUEUED_AT },
      [recovered('mgr-a'), { ...recovered('mgr-b'), status: 'done' }],
      DELIVERED_MS,
    );
    expect(text).toContain('名指す担当 2 本はすべて回復している');
    expect(text).toContain('mgr-a（`running`・鍵の世代 13）');
    expect(text).toContain('mgr-b（`done`・鍵の世代 13）');
    expect(text).toContain(`知らせが積まれたのは ${QUEUED_AT}（17 分前）`);
    expect(text).toContain('`manager_list` / `token_list` を引く必要は無い');
    expect(text.endsWith('\n---\n')).toBe(true);
  });

  it('一部だけ回復していれば、回復した担当と、回復したと言えない担当をその理由つきで分けて出す', () => {
    const text = describeQuotaRecovery(
      { managerIds: ['mgr-a', 'mgr-b', 'mgr-c', 'mgr-d', 'mgr-e'], earliestAt: QUEUED_AT },
      [
        recovered('mgr-a'),
        { ...recovered('mgr-b'), usageStoppedAt: '2026-10-11T18:55:00.000Z' },
        { ...recovered('mgr-c'), tokenGeneration: 12 },
        { ...recovered('mgr-d'), live: false, status: 'failed' },
      ],
      DELIVERED_MS,
    );
    expect(text).toContain('名指す担当 5 本のうち **1 本は回復している**: mgr-a');
    expect(text).toContain('mgr-b（枠で止まった印が残っている。2026-10-11T18:55:00.000Z から）');
    expect(text).toContain('mgr-c（鍵の世代 12 が現役の 13 と違う）');
    expect(text).toContain('mgr-d（live でない。状態 `failed`）');
    expect(text).toContain('mgr-e（一覧に居ない）');
    expect(text).not.toContain('引く必要は無い');
  });

  it('1本も回復していなければ何も添えない（本文の「止まった」がそのまま今の状態のため）', () => {
    const text = describeQuotaRecovery(
      { managerIds: ['mgr-a'], earliestAt: QUEUED_AT },
      [{ ...recovered('mgr-a'), usageStoppedAt: QUEUED_AT }],
      DELIVERED_MS,
    );
    expect(text).toBe('');
  });

  it('鍵の世代が取れない担当は、回復したとは言わない', () => {
    const text = describeQuotaRecovery(
      { managerIds: ['mgr-a'], earliestAt: QUEUED_AT },
      [{ ...recovered('mgr-a'), tokenGeneration: undefined }],
      DELIVERED_MS,
    );
    expect(text).toBe('');
  });

  it('担当一覧を引けなければ、空にせず「確かめられなかった」と理由つきで名乗る', () => {
    const text = describeQuotaRecovery(
      { managerIds: ['mgr-a'], earliestAt: QUEUED_AT },
      { detail: 'db down' },
      DELIVERED_MS,
    );
    expect(text).toContain('回復しているかを確かめられなかった（db down）');
  });
});
