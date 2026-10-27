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

    // 材料が1つ違う（走行中が1本増えた）回: 同じ材料だと #5295 で1行になるので、畳み形を見るために変える
    const second = situation([...managers, summary('mgr-3', 'running')], explained);
    expect(second).not.toContain(READINGS_HEAD);
    expect(second).not.toContain(INVARIANT_HEAD);
    expect(second).toContain('要点だけにした');
    // 趣旨（読み替えを防ぐ）は要点として残る
    expect(second).toContain(
      '「手が空いている」は空き枠でも「終わった」でも「枠が空いた」でもない',
    );
    expect(second).toContain('枠を理由に仕事を見送らないこと');
    // 数の行は畳まない
    expect(second).toContain('委譲 全 3 本: 走行中 2');
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

    // 材料を1つ変える（走行中が1本増えた）: 同じ材料だと #5295 で1行になるので、lost の断りの畳みを見るために変える
    const again = situation(
      [summary('mgr-1', 'done'), summary('mgr-2', 'lost'), summary('mgr-3', 'running')],
      explained,
    );
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

const UNCHANGED_HEAD = '[system] いまの全体: 前のターンと変化なし';

describe('材料の行が前回と同じなら、1行にする（#5295）', () => {
  const managers = [summary('mgr-1', 'done'), summary('mgr-2', 'running')];

  it('(d) 初回は全文で、「変化なし」にはならない', () => {
    const first = situation(managers, new Map());
    expect(first).not.toContain(UNCHANGED_HEAD);
    expect(first).toContain(READINGS_HEAD);
  });

  it('(a) ⭐ 材料が前回と同じなら、数の行も説明文も要点も出さず1行にする', () => {
    const explained: SituationExplained = new Map();
    situation(managers, explained);

    const second = situation(managers, explained);
    expect(second).toBe(
      '[system] いまの全体: 前のターンと変化なし（04:00:00Z に数え直した）。\n\n---\n',
    );
  });

  it('(a) 時刻だけが違うときも変化なし（見出しの時刻は新しい値を名乗る）', () => {
    const explained: SituationExplained = new Map();
    situation(managers, explained);

    const later = describeSituation({
      managers,
      runners: [{ state: 'connected' }],
      tokens: [{ id: 'tok-a', label: '鍵A' }],
      active: { tokenId: 'tok-a' },
      at: AT + 7 * 60 * 1000,
      explained,
    });
    // 「最後に起こしたのは N分前」の経過は動くが、起動そのものは同じなので変化とは数えない
    expect(later).toContain(`${UNCHANGED_HEAD}（04:07:00Z に数え直した）`);
  });

  it('(b) 材料が1つでも違えば、行の全体を出す（説明文は畳み形のまま）', () => {
    let explained: SituationExplained = new Map();
    const variants: Record<string, () => string> = {
      委譲の数: () => situation([...managers, summary('mgr-3', 'running')], explained),
      器の数: () =>
        describeSituation({
          managers,
          runners: [{ state: 'connected' }, { state: 'vacating' }],
          tokens: [{ id: 'tok-a', label: '鍵A' }],
          active: { tokenId: 'tok-a' },
          at: AT,
          explained,
        }),
      鍵の行: () =>
        describeSituation({
          managers,
          runners: [{ state: 'connected' }],
          tokens: [{ id: 'tok-a', label: '鍵A', cooldownUntil: AT + 3600_000 }],
          active: { tokenId: 'tok-a' },
          at: AT,
          explained,
        }),
      受信箱の滞留: () =>
        describeSituation({
          managers,
          runners: [{ state: 'connected' }],
          tokens: [{ id: 'tok-a', label: '鍵A' }],
          active: { tokenId: 'tok-a' },
          backlog: { count: 3 },
          at: AT,
          explained,
        }),
    };
    for (const [name, vary] of Object.entries(variants)) {
      explained = new Map();
      situation(managers, explained);
      const second = vary();
      expect(second, name).not.toContain(UNCHANGED_HEAD);
      expect(second, name).toContain('委譲 全');
      expect(second, name).toContain('認証トークン:');
      expect(second, name).toContain('要点だけにした');
      expect(second, name).not.toContain(READINGS_HEAD);
    }
  });

  it('(c) 控えを空にすれば（会話が変わった・要約・観測が無い・失敗の次）、同じ材料でも全文へ戻る', () => {
    const explained: SituationExplained = new Map();
    situation(managers, explained);
    expect(situation(managers, explained)).toContain(UNCHANGED_HEAD);

    explained.clear();
    const afterClear = situation(managers, explained);
    expect(afterClear).not.toContain(UNCHANGED_HEAD);
    expect(afterClear).toContain(READINGS_HEAD);
    expect(afterClear).toContain(INVARIANT_HEAD);
  });

  it('(e) 「変化なし」の直後に材料が変われば畳み形へ戻り、その次に同じなら再び1行', () => {
    const explained: SituationExplained = new Map();
    situation(managers, explained);
    expect(situation(managers, explained)).toContain(UNCHANGED_HEAD);

    const changedManagers = [...managers, summary('mgr-3', 'done')];
    const changed = situation(changedManagers, explained);
    expect(changed).not.toContain(UNCHANGED_HEAD);
    expect(changed).toContain('委譲 全 3 本');
    expect(changed).toContain('要点だけにした');

    expect(situation(changedManagers, explained)).toContain(UNCHANGED_HEAD);
  });

  it('控えへ書かなければ（入力が SDK へ入らなかった写しを捨てる）、同じ材料でも全文を畳まない', () => {
    const committed: SituationExplained = new Map();
    situation(managers, committed);
    // 呼び手は写しへ書かせ、入力が入ったときだけ本物へ移す（#4484）。移さなかった写しは捨てる
    const staged: SituationExplained = new Map(committed);
    situation([...managers, summary('mgr-3', 'done')], staged);
    // 本物の控えは前回のまま: 材料が違った回の全体は会話に載っていないので、元の材料へ戻れば「変化なし」でよい
    expect(situation(managers, committed)).toContain(UNCHANGED_HEAD);
    // 写しに書かれた新しい材料は、移していないので本物の控えでは「変化なし」にならない
    expect(situation([...managers, summary('mgr-3', 'done')], committed)).not.toContain(
      UNCHANGED_HEAD,
    );
  });

  it('文字数: 変化なしの回は、畳み形の4分の1にも満たない', () => {
    const explained: SituationExplained = new Map();
    situation(managers, explained);
    const folded = situation([...managers, summary('mgr-3', 'running')], explained);
    const unchanged = situation([...managers, summary('mgr-3', 'running')], explained);
    expect(unchanged.length).toBeLessThan(folded.length / 4);
  });
});
