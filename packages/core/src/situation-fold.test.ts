import { describe, expect, it } from 'vitest';

import type { ManagerSummary } from './manager.js';
import type { JobStatus } from './schema.js';
import { describeSituation, type SituationExplained } from './situation.js';

const AT = Date.parse('2026-10-11T04:00:00.000Z');

function summary(id: string, status: JobStatus): ManagerSummary {
  return {
    managerId: id,
    status,
    live: status !== 'lost',
    cwd: '/work',
    request: '依頼',
    startedAt: '2026-10-11T00:00:00.000Z',
    updatedAt: '2026-10-11T00:00:00.000Z',
    waiting: [],
  };
}

function situation(
  managers: ManagerSummary[],
  explained?: SituationExplained,
  tokens: boolean = true,
): string {
  return describeSituation({
    managers,
    runners: [{ state: 'connected' }],
    ...(tokens
      ? {
          tokens: [{ id: 'tok-a', label: '鍵A' }],
          active: { tokenId: 'tok-a' },
        }
      : {}),
    at: AT,
    ...(explained === undefined ? {} : { explained }),
  });
}

const READINGS_HEAD = '**「手が空いている」は「空き枠」ではない**';
const INVARIANT_HEAD = '**⚠️ 枠を理由に仕事を見送らないこと。**';
const LOST_HEAD = '**戻れなかった(lost) は「終わった」ではない。**';

describe('同じ会話で一度出した「いまの全体」の説明文は、変わらなければ要点に畳む（#4476）', () => {
  it('控えを渡さなければ、毎回全文（これまでどおり）', () => {
    const managers = [summary('mgr-1', 'done')];
    expect(situation(managers)).toContain(READINGS_HEAD);
    expect(situation(managers)).toContain(READINGS_HEAD);
  });

  it('⭐ 1回目は全文、2回目は説明文を要点に畳み、数の行は毎回出す', () => {
    const explained: SituationExplained = new Map();
    const managers = [summary('mgr-1', 'done'), summary('mgr-2', 'running')];

    const first = situation(managers, explained);
    expect(first).toContain(READINGS_HEAD);
    expect(first).toContain(INVARIANT_HEAD);
    expect(first).not.toContain('要点だけにした');

    const second = situation(managers, explained);
    expect(second).not.toContain(READINGS_HEAD);
    expect(second).not.toContain(INVARIANT_HEAD);
    expect(second).toContain('要点だけにした');
    // 趣旨（読み替えを防ぐ）は要点として残る
    expect(second).toContain(
      '「手が空いている」は空き枠でも「終わった」でも「枠が空いた」でもない',
    );
    expect(second).toContain('枠を理由に仕事を見送らないこと');
    // 数の行は畳まない
    expect(second).toContain('委譲 全 2 本: 走行中 1');
    expect(second).toContain('器 1 台: connected 1。');
    expect(second).toContain('認証トークン: 現役は「鍵A」');
    expect(second.length).toBeLessThan(first.length / 2);
  });

  it('新しく出てきた注意書き（lost）は全文で出し、変わっていないものだけ畳む', () => {
    const explained: SituationExplained = new Map();
    situation([summary('mgr-1', 'done')], explained);

    const withLost = situation([summary('mgr-1', 'done'), summary('mgr-2', 'lost')], explained);
    expect(withLost).toContain(LOST_HEAD);
    expect(withLost).not.toContain(READINGS_HEAD);
    expect(withLost).toContain('要点だけにした');

    const again = situation([summary('mgr-1', 'done'), summary('mgr-2', 'lost')], explained);
    expect(again).not.toContain(LOST_HEAD);
    expect(again).toContain('lost は「終わった」ではない');
  });

  it('控えを空にすれば（会話の始まり・要約の後・一定ターンごと）、全文へ戻る', () => {
    const explained: SituationExplained = new Map();
    const managers = [summary('mgr-1', 'done')];
    situation(managers, explained);
    expect(situation(managers, explained)).not.toContain(READINGS_HEAD);

    explained.clear();
    expect(situation(managers, explained)).toContain(READINGS_HEAD);
  });

  it('鍵の行が無い回は、不変条件を出したことにしない（次に鍵の行が出る回は全文）', () => {
    const explained: SituationExplained = new Map();
    const managers = [summary('mgr-1', 'done')];
    situation(managers, explained, false);
    expect(situation(managers, explained, true)).toContain(INVARIANT_HEAD);
  });
});
