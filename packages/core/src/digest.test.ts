import { describe, expect, it } from 'vitest';

import {
  buildActivityDigest,
  classifyUnobservedOutcome,
  describeManagerState,
  describeSessionMissingKind,
  describeUnobservedOutcome,
  DIGEST_JOURNAL_SCAN_LIMIT,
  DIGEST_RETAIN_LIMIT,
  DIGEST_SOURCE_TALLY_LIMIT,
  isManagerAwaitingJudgement,
  isManagerOutcomeUnobserved,
  MAX_ITEMS,
  type UnobservedOutcomeInput,
  type UnobservedReportState,
} from './digest.js';
import { JOURNAL_SCAN_PAGE_SIZE } from './journal-scan.js';
import { createSyntheticJournalStore } from './journal-scan.test-support.js';
import type { SessionMissingKind } from './manager.js';
import { UnreadableApprovalError } from './store.js';
import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';
import { usageDate } from './usage.js';

describe('describeManagerState', () => {
  it('live: true は状態名だけ', () => {
    expect(describeManagerState('running', true)).toBe('running');
  });

  it('live: false は「/セッション切断」を足す', () => {
    expect(describeManagerState('running', false)).toBe('running/セッション切断');
  });

  it('live: undefined は「/セッション不明」——否定でも肯定でもない第三の値', () => {
    expect(describeManagerState('running', undefined)).toBe('running/セッション不明');
  });

  it('背景処理待ちのときは件数を足す（done が2つの状態を潰したままにしない）', () => {
    expect(describeManagerState('done', true, { tasks: 3 })).toBe('done/背景処理待ち×3');
  });

  it('セッション切断と背景処理待ちは両方並ぶ（片方が片方を隠さない）', () => {
    expect(describeManagerState('done', false, { tasks: 1 })).toBe(
      'done/セッション切断/背景処理待ち×1',
    );
    expect(describeManagerState('done', undefined, { tasks: 2 })).toBe(
      'done/セッション不明/背景処理待ち×2',
    );
  });

  it('第3引数を省略しても、直す前と1文字も変わらない', () => {
    expect(describeManagerState('done', true)).toBe('done');
    expect(describeManagerState('done', true, undefined)).toBe('done');
    expect(describeManagerState('done', false, undefined)).toBe('done/セッション切断');
    expect(describeManagerState('done', undefined, undefined)).toBe('done/セッション不明');
  });

  it('since が在れば「（<時刻> から）」を tasks の直後に添える', () => {
    expect(
      describeManagerState('done', true, { tasks: 3, since: '2026-09-16T11:00:00.000Z' }),
    ).toBe('done/背景処理待ち×3（2026-09-16T11:00:00.000Z から）');
  });

  it('since が undefined のときは、明示的に渡しても渡さなくても同じ字面のまま', () => {
    expect(describeManagerState('done', true, { tasks: 3 })).toBe('done/背景処理待ち×3');
    expect(describeManagerState('done', true, { tasks: 3, since: undefined })).toBe(
      'done/背景処理待ち×3',
    );
  });
});

describe('describeSessionMissingKind の字面（#619 の積み残し。#623 の describeDroppedTraceOrigin に倣う）', () => {
  it('describeSessionMissingKind(undefined) は空文字（「不明」と書かない）', () => {
    expect(describeSessionMissingKind(undefined)).toBe('');
  });

  it('SessionMissingKind の全ての値について、空でない文字列を返す', () => {
    const ALL_KINDS: Record<SessionMissingKind, true> = {
      'resume-failed': true,
      unlisted: true,
    };
    const kinds = Object.keys(ALL_KINDS) as SessionMissingKind[];
    expect(kinds.length).toBeGreaterThan(0);
    for (const kind of kinds) {
      expect(describeSessionMissingKind(kind)).not.toBe('');
    }
  });

  it('describeSessionMissingKind("resume-failed") は resume を試みて失敗した意味の文言を持つ', () => {
    expect(describeSessionMissingKind('resume-failed')).toContain('resume');
  });

  it('describeSessionMissingKind("unlisted") は名簿に載っていなかった意味の文言を持つ', () => {
    expect(describeSessionMissingKind('unlisted')).toContain('名簿');
  });

  it('describeSessionMissingKind は resume-failed / unlisted それぞれで文字列として完全一致する', () => {
    expect(describeSessionMissingKind('resume-failed')).toBe('resume でも入り直せなかった。');
    expect(describeSessionMissingKind('unlisted')).toBe(
      '名簿に載っていなかった。resume はまだ試していない。',
    );
  });

  it('resume-failed と unlisted の字面は異なる', () => {
    expect(describeSessionMissingKind('resume-failed')).not.toBe(
      describeSessionMissingKind('unlisted'),
    );
  });
});

describe('活動の要約', () => {
  it('その期間の判断・エスカレーション・記憶の更新・外部イベントを並べる', async () => {
    const stores = createMemoryStores();
    await stores.journal.append({ type: 'exchange', with: 'human', role: 'inbound', text: 'やあ' });
    await stores.journal.append({
      type: 'decision',
      decision: 'ログイン周りの修正を委譲した',
      grounds: '記憶にある「小さな修正は任せてよい」',
    });
    await stores.journal.append({
      type: 'memory_update',
      slug: 'values',
      cause: 'distill',
      summary: '検証の粒度についての好みを追記',
    });
    await stores.journal.append({
      type: 'external_event',
      source: 'ci',
      summary: 'main のビルドが落ちた',
    });

    const digest = await buildActivityDigest(stores, {
      since: new Date(Date.now() - 60_000),
    });

    expect(digest).toContain('人間からの発言: 1 件');
    expect(digest).toContain('ログイン周りの修正を委譲した');
    expect(digest).toContain('小さな修正は任せてよい');
    expect(digest).toContain('検証の粒度についての好みを追記');
    expect(digest).toContain('main のビルドが落ちた');
  });

  it('ツール実行は「マネージャー・作業者」と「自分の手」を分けて数える', async () => {
    const stores = createMemoryStores();
    for (const actor of ['clone', 'clone:sub:general-purpose', 'clone:distill']) {
      await stores.journal.append({ type: 'tool_use', actor, tool: 'Bash', input: {} });
    }
    await stores.journal.append({
      type: 'tool_use',
      actor: 'manager:mgr-1234abcd',
      tool: 'Edit',
      input: {},
    });
    await stores.journal.append({
      type: 'tool_use',
      actor: 'worker:mgr-1234abcd:worker',
      tool: 'Read',
      input: {},
    });

    const digest = await buildActivityDigest(stores, { since: new Date(Date.now() - 60_000) });

    expect(digest).toContain('マネージャー・作業者のツール実行: 2 件');
    expect(digest).toContain('あなた自身が手を動かした回数（委譲せずに使った道具）: 3 件');
  });

  it('継続中の依頼は期間の外でも常に材料に載る（頼まれたままの仕事を忘れないため）', async () => {
    const stores = createMemoryStores();
    await stores.schedules.put({
      kind: 'issue-round',
      spec: { type: 'daily', at: '09:00' },
      request: 'open issue を見て実装を進める',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });

    const digest = await buildActivityDigest(stores, { since: new Date(Date.now() - 60_000) });

    expect(digest).toContain('継続中の依頼');
    expect(digest).toContain('open issue を見て実装を進める');
    expect(digest).toContain('毎日 09:00');
    expect(digest).toContain('まだ一度も動いていない');
  });

  describe('読めない継続中の依頼の行（#2343）: 件数からもこの節からも消さない', () => {
    function withUnreadable(unreadable: { kind?: string; reason: string }[]) {
      const stores = createMemoryStores();
      const original = stores.schedules.list.bind(stores.schedules);
      stores.schedules.list = async () => ({ ...(await original()), unreadable });
      return stores;
    }
    const since = () => new Date(Date.now() - 60_000);

    it('読めない行が在るとき、件数の行と節の両方で言う。読めた依頼は今までどおり出る', async () => {
      const stores = withUnreadable([{ kind: 'broken-1', reason: '不正な欄: spec' }]);
      await stores.schedules.put({
        kind: 'issue-round',
        spec: { type: 'daily', at: '09:00' },
        request: '読める依頼の本文',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      });
      const digest = await buildActivityDigest(stores, { since: since() });
      expect(digest).toContain('- 継続中の依頼（定期の仕込み）: 1 件');
      expect(digest).toContain(
        '- 読めない継続中の依頼（壊れた行。上の件数には入っていない）: 1 件',
      );
      expect(digest).toContain('読める依頼の本文');
      expect(digest).toContain('読めない継続中の依頼が 1 件ある（kind: broken-1）');
    });

    it('読めた依頼が0件でも、読めない行の節は出る', async () => {
      const stores = withUnreadable([{ reason: '不正な行' }]);
      const digest = await buildActivityDigest(stores, { since: since() });
      expect(digest).toContain('## 継続中の依頼');
      expect(digest).toContain('読めない継続中の依頼が 1 件ある（kind も取れない）');
    });

    it('0件のときは行も節も作らない', async () => {
      const stores = withUnreadable([]);
      const digest = await buildActivityDigest(stores, { since: since() });
      expect(digest).not.toContain('読めない継続中の依頼');
      expect(digest).not.toContain('## 継続中の依頼');
    });
  });

  it('走行中のマネージャーと、人間の回答待ちは「いまの状態」として必ず出る', async () => {
    const stores = createMemoryStores();
    const now = new Date().toISOString();
    await stores.jobs.putJob({
      id: 'mgr-1234',
      createdAt: now,
      updatedAt: now,
      status: 'waiting_human',
      summary: 'ログイン周りを直して',
      request: 'ログイン周りを直して',
      lastReport: '原因まで分かった',
    });
    await stores.jobs.putApproval({
      id: 'ap-1',
      createdAt: now,
      question: '本番へ流してよいか',
      jobId: 'mgr-1234',
    });

    const digest = await buildActivityDigest(stores, { since: new Date(Date.now() - 60_000) });

    expect(digest).toContain('mgr-1234');
    expect(digest).toContain('原因まで分かった');
    expect(digest).toContain('いま人間の回答を待っているもの: 1 件');
    expect(digest).toContain('本番へ流してよいか');
  });

  it('直近のターンが失敗で終わっているとき、日報にその理由（code/via/at）が出る', async () => {
    const stores = createMemoryStores();
    const now = new Date().toISOString();
    await stores.jobs.putJob({
      id: 'mgr-failed-turn',
      createdAt: now,
      updatedAt: now,
      status: 'done',
      summary: '仕事',
      request: '仕事',
      lastFailure: {
        code: 'sentinel-code-9f2a71',
        via: 'sentinel-via-7c1b44',
        at: '2026-09-01T00:00:00.000Z',
      },
    });

    const digest = await buildActivityDigest(stores, { since: new Date(Date.now() - 60_000) });

    const start = digest.indexOf('mgr-failed-turn');
    expect(start).toBeGreaterThanOrEqual(0);
    const block = digest.slice(start);
    expect(block).toContain('sentinel-code-9f2a71');
    expect(block).toContain('sentinel-via-7c1b44');
    expect(block).toContain('2026-09-01T00:00:00.000Z');
    expect(digest.split('sentinel-code-9f2a71')).toHaveLength(2);
  });

  it('直近のターンが報告で終わっている（lastFailure が無い）ときは、失敗の一行が出ない（構造で見る。飾り文の toContain には依存しない）', async () => {
    const stores = createMemoryStores();
    const now = new Date().toISOString();
    await stores.jobs.putJob({
      id: 'mgr-healthy-turn',
      createdAt: now,
      updatedAt: now,
      status: 'done',
      summary: '仕事',
      request: '仕事',
      lastReport: '完了した',
    });

    const digest = await buildActivityDigest(stores, { since: new Date(Date.now() - 60_000) });

    const sectionStart = digest.indexOf('## マネージャー');
    expect(sectionStart).toBeGreaterThanOrEqual(0);
    const rest = digest.slice(sectionStart);
    const sectionEnd = rest.indexOf('\n\n');
    const section = sectionEnd === -1 ? rest : rest.slice(0, sectionEnd);

    expect(section.split('\n')).toEqual([
      '## マネージャー（走行中・返事待ちから先に出す）',
      '- mgr-healthy-turn [done/セッション不明] 仕事',
      '  直近の報告: 完了した',
    ]);
  });

  it('走行中のマネージャー2本を liveness で分けると、要約の行が互いに違う字面になる（実害の歯）', async () => {
    const stores = createMemoryStores();
    const now = new Date().toISOString();
    await stores.jobs.putJob({
      id: 'mgr-alive',
      createdAt: now,
      updatedAt: now,
      status: 'running',
      summary: '生きている仕事',
      request: '生きている仕事',
    });
    await stores.jobs.putJob({
      id: 'mgr-dead',
      createdAt: now,
      updatedAt: now,
      status: 'running',
      summary: 'セッションが切れた仕事',
      request: 'セッションが切れた仕事',
    });
    const liveness = new Map([
      ['mgr-alive', true],
      ['mgr-dead', false],
    ]);

    const digest = await buildActivityDigest(
      stores,
      { since: new Date(Date.now() - 60_000) },
      liveness,
    );

    const aliveLine = digest.split('\n').find((line) => line.includes('mgr-alive'));
    const deadLine = digest.split('\n').find((line) => line.includes('mgr-dead'));
    expect(aliveLine).toContain('[running]');
    expect(deadLine).toContain('[running/セッション切断]');
    expect(aliveLine).not.toEqual(deadLine);
  });

  it('liveness に載っていない id は「セッション不明」になる（取れなかったことを黙らない）', async () => {
    const stores = createMemoryStores();
    const now = new Date().toISOString();
    await stores.jobs.putJob({
      id: 'mgr-unknown',
      createdAt: now,
      updatedAt: now,
      status: 'running',
      summary: '仕事',
      request: '仕事',
    });

    const digest = await buildActivityDigest(
      stores,
      { since: new Date(Date.now() - 60_000) },
      new Map(),
    );

    const line = digest.split('\n').find((row) => row.includes('mgr-unknown'));
    expect(line).toContain('[running/セッション不明]');
  });

  it('liveness を省略すると「セッション不明」になる（既定が肯定側へ倒れていないことの歯）', async () => {
    const stores = createMemoryStores();
    const now = new Date().toISOString();
    await stores.jobs.putJob({
      id: 'mgr-omitted',
      createdAt: now,
      updatedAt: now,
      status: 'running',
      summary: '仕事',
      request: '仕事',
    });

    const digest = await buildActivityDigest(stores, { since: new Date(Date.now() - 60_000) });

    const line = digest.split('\n').find((row) => row.includes('mgr-omitted'));
    expect(line).toContain('[running/セッション不明]');
    expect(line).not.toContain('[running]');
  });

  it('期間の外の記録は数えない', async () => {
    const stores = createMemoryStores();
    await stores.journal.append({ type: 'decision', decision: 'いま決めた', grounds: '記憶' });

    const digest = await buildActivityDigest(stores, {
      since: new Date(Date.now() - 60_000),
      until: new Date(Date.now() - 30_000),
    });

    expect(digest).toContain('自分で決めたこと（日誌の decision）: 0 件');
    expect(digest).not.toContain('いま決めた');
  });
});

describe('## エスカレーション — approvalId で束ねる（同じ問いの二重表示を直す）', () => {
  const since = () => new Date(Date.now() - 60_000);

  it('同じ approvalId の「聞いた」行と「答えた」行は1行に束ね、「回答あり」だけを出す（二重表示にしない）', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putApproval({
      id: 'ap-hub-issue',
      createdAt: new Date().toISOString(),
      question: 'virchamate の hub に、私が ISSUE を立ててよいですか',
      answeredAt: new Date().toISOString(),
      answer: '立てて良いです',
    });
    await stores.journal.append({
      type: 'escalation',
      question: 'virchamate の hub に、私が ISSUE を立ててよいですか',
      approvalId: 'ap-hub-issue',
    });
    await stores.journal.append({
      type: 'escalation',
      question: 'virchamate の hub に、私が ISSUE を立ててよいですか',
      approvalId: 'ap-hub-issue',
      answeredAt: new Date().toISOString(),
      answer: '立てて良いです',
    });

    const digest = await buildActivityDigest(stores, { since: since() });

    expect(digest).toContain('エスカレーション: 1 件');
    const escalationLines = digest.split('\n').filter((line) => line.includes('virchamate の hub'));
    expect(escalationLines).toHaveLength(1);
    expect(escalationLines[0]).toContain('回答: 立てて良いです');
    expect(escalationLines[0]).not.toContain('未回答');
    expect(escalationLines[0]).toContain('id: ap-hub-issue');
  });

  it('同じ approvalId の「聞いた」行と「取り下げた」行は1行に束ね、「取り下げ」だけを出す（未回答としては出さない）', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putApproval({
      id: 'ap-withdrawn',
      createdAt: new Date().toISOString(),
      question: '本番へ流してよいか',
      withdrawnAt: new Date().toISOString(),
      withdrawnReason: '自分で答えを見つけた',
    });
    await stores.journal.append({
      type: 'escalation',
      question: '本番へ流してよいか',
      approvalId: 'ap-withdrawn',
    });
    await stores.journal.append({
      type: 'escalation',
      question: '本番へ流してよいか',
      approvalId: 'ap-withdrawn',
      withdrawnAt: new Date().toISOString(),
      withdrawnReason: '自分で答えを見つけた',
    });

    const digest = await buildActivityDigest(stores, { since: since() });

    const escalationLines = digest
      .split('\n')
      .filter((line) => line.includes('本番へ流してよいか →'));
    expect(escalationLines).toHaveLength(1);
    expect(escalationLines[0]).toContain('取り下げ: 自分で答えを見つけた');
    expect(escalationLines[0]).not.toContain('未回答');
    expect(escalationLines[0]).toContain('id: ap-withdrawn');
  });

  it('この期間の日誌には取り下げ前の行しか無いが、キューでは既に取り下げ済み（この期間の外で取り下げられた）', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putApproval({
      id: 'ap-withdrawn-later',
      createdAt: new Date().toISOString(),
      question: '本番へ流してよいか（後で取り下げ）',
      withdrawnAt: new Date().toISOString(),
      withdrawnReason: '前提が消えた',
    });
    await stores.journal.append({
      type: 'escalation',
      question: '本番へ流してよいか（後で取り下げ）',
      approvalId: 'ap-withdrawn-later',
    });

    const digest = await buildActivityDigest(stores, { since: since() });

    const line = digest.split('\n').find((l) => l.includes('本番へ流してよいか（後で取り下げ） →'));
    expect(line).toContain('この期間の外で取り下げられた');
    expect(line).toContain('前提が消えた');
    expect(line).not.toContain('台帳の破損');
    expect(line).toContain('id: ap-withdrawn-later');
  });

  it('未回答で承認待ちキューに在る（次の一手: 待つ／催促する）。回答待ち節と同じ id が行そのものに出る', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putApproval({
      id: 'ap-pending',
      createdAt: new Date().toISOString(),
      question: '本番へ流してよいか',
    });
    await stores.journal.append({
      type: 'escalation',
      question: '本番へ流してよいか',
      approvalId: 'ap-pending',
    });

    const digest = await buildActivityDigest(stores, { since: since() });

    expect(digest).toContain('いま人間の回答を待っているもの: 1 件');
    const line = digest.split('\n').find((l) => l.includes('本番へ流してよいか →'));
    expect(line).toContain('承認待ちキューに在る');
    expect(line).not.toContain('回答あり');
    expect(line).toContain('id: ap-pending');
    const pendingLine = digest.split('\n').find((l) => l.startsWith('- ap-pending'));
    expect(pendingLine).toContain('本番へ流してよいか');
  });

  it('この期間の日誌には未回答の行しか無いが、キューでは既に回答済み（この期間の外で回答された）', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putApproval({
      id: 'ap-answered-later',
      createdAt: new Date().toISOString(),
      question: 'デプロイの時間帯を変えてよいか',
      answeredAt: new Date().toISOString(),
      answer: '良い、22時以降にして',
    });
    await stores.journal.append({
      type: 'escalation',
      question: 'デプロイの時間帯を変えてよいか',
      approvalId: 'ap-answered-later',
    });

    const digest = await buildActivityDigest(stores, { since: since() });

    const line = digest.split('\n').find((l) => l.includes('デプロイの時間帯を変えてよいか →'));
    expect(line).toContain('この期間の外で回答された');
    expect(line).toContain('良い、22時以降にして');
    expect(line).not.toContain('承認待ちキューに在る。下の');
    expect(line).toContain('id: ap-answered-later');
  });

  it('キューに行は在るが読めない（UnreadableApprovalError）: digest 全体を落とさず、その1件を「読めない」と出す（#2279）', async () => {
    const stores = createMemoryStores();
    stores.jobs.getApproval = async (id) => {
      throw new UnreadableApprovalError({ id });
    };
    await stores.journal.append({
      type: 'escalation',
      question: '壊れた行の確認',
      approvalId: 'ap-unreadable',
    });

    const digest = await buildActivityDigest(stores, { since: since() });

    const line = digest.split('\n').find((l) => l.includes('壊れた行の確認 →'));
    expect(line).toContain('在るが読めない形で入っている');
    expect(line).toContain('判定できない');
    expect(line).not.toContain('承認待ちキューに見つからず');
    expect(line).toContain('id: ap-unreadable');
  });

  it('この期間の外で回答されたが、回答の本文が無い記録（answeredAt はあるが answer が欠けている）', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putApproval({
      id: 'ap-answer-missing',
      createdAt: new Date().toISOString(),
      question: '欠けた回答の確認',
      answeredAt: new Date().toISOString(),
    });
    await stores.journal.append({
      type: 'escalation',
      question: '欠けた回答の確認',
      approvalId: 'ap-answer-missing',
    });

    const digest = await buildActivityDigest(stores, { since: since() });

    const line = digest.split('\n').find((l) => l.includes('欠けた回答の確認 →'));
    expect(line).toContain('台帳の破損の可能性がある');
    expect(line).not.toMatch(/回答された\):\s*（id:/);
    expect(line).toContain('id: ap-answer-missing');
  });

  it('キューに無く managerId が在る＝マネージャー発の確認。id は requestId であって承認待ちキューの id ではない', async () => {
    const stores = createMemoryStores();
    await stores.journal.append({
      type: 'escalation',
      question: 'この変更を manager がマージしてよいか',
      approvalId: 'req-1234',
      managerId: 'mgr-abcd',
    });

    const digest = await buildActivityDigest(stores, { since: since() });

    const line = digest
      .split('\n')
      .find((l) => l.includes('この変更を manager がマージしてよいか →'));
    expect(line).toContain('マネージャー mgr-abcd 発の確認');
    expect(line).toContain('欠落ではない');
    expect(line).toContain(
      'requestId: req-1234（マネージャー mgr-abcd 発。承認待ちキューの id ではない）',
    );
    expect(line).not.toContain('id: req-1234）');
  });

  it('キューにも無く managerId も無い＝判定できない。黙ってどちらか（未回答/回答あり）へ倒さない', async () => {
    const stores = createMemoryStores();
    await stores.journal.append({
      type: 'escalation',
      question: '出所不明の確認',
      approvalId: 'ap-orphan',
    });

    const digest = await buildActivityDigest(stores, { since: since() });

    const line = digest.split('\n').find((l) => l.includes('出所不明の確認 →'));
    expect(line).toContain('判定できない');
    expect(line).not.toContain('未回答（承認待ちキューに在る');
    expect(line).not.toContain('回答:');
    expect(line).toContain('id: ap-orphan');
  });

  it('件数の行・回答待ちの一覧・エスカレーション欄の3つが食い違わない（1問=1件として揃う。id も突き合わせられる）', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putApproval({
      id: 'ap-a',
      createdAt: new Date().toISOString(),
      question: '質問A',
    });
    await stores.journal.append({ type: 'escalation', question: '質問A', approvalId: 'ap-a' });
    await stores.jobs.putApproval({
      id: 'ap-b',
      createdAt: new Date().toISOString(),
      question: '質問B',
      answeredAt: new Date().toISOString(),
      answer: '回答B',
    });
    await stores.journal.append({ type: 'escalation', question: '質問B', approvalId: 'ap-b' });
    await stores.journal.append({
      type: 'escalation',
      question: '質問B',
      approvalId: 'ap-b',
      answeredAt: new Date().toISOString(),
      answer: '回答B',
    });

    const digest = await buildActivityDigest(stores, { since: since() });

    expect(digest).toContain('エスカレーション: 2 件');
    expect(digest).toContain('いま人間の回答を待っているもの: 1 件');
    const pendingSection = digest.slice(digest.indexOf('## 人間の回答待ち'));
    expect(pendingSection).toContain('ap-a');
    expect(pendingSection).not.toContain('ap-b');
    const lineA = digest.split('\n').find((l) => l.includes('質問A →'));
    expect(lineA).toContain('id: ap-a');
    const lineB = digest.split('\n').find((l) => l.includes('質問B →'));
    expect(lineB).toContain('id: ap-b');
  });

  it('束ねた後は at の新しい順に並ぶ（journal.list が新しい順を返す契約に頼らない防御的な並べ替えを測る）', async () => {
    const stores = createMemoryStores();
    await stores.journal.append({ type: 'escalation', question: '古い質問', approvalId: 'ap-old' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await stores.journal.append({
      type: 'escalation',
      question: '新しい質問',
      approvalId: 'ap-new',
    });

    const originalList = stores.journal.list.bind(stores.journal);
    stores.journal.list = async (query) => [...(await originalList(query))].reverse();

    const digest = await buildActivityDigest(stores, { since: since() });
    const section = digest.slice(
      digest.indexOf('## エスカレーション'),
      digest.indexOf('## 人間の回答待ち') === -1 ? undefined : digest.indexOf('## 人間の回答待ち'),
    );
    const oldIndex = section.indexOf('古い質問');
    const newIndex = section.indexOf('新しい質問');
    expect(oldIndex).toBeGreaterThan(-1);
    expect(newIndex).toBeGreaterThan(-1);
    expect(newIndex).toBeLessThan(oldIndex);
  });

  it('承認待ちキューへの個別の問い合わせ（getApproval）は MAX_ITEMS 件で頭打ちになる（総数に比例しない）', async () => {
    const stores = createMemoryStores();
    const total = MAX_ITEMS + 5;
    for (let i = 0; i < total; i += 1) {
      await stores.jobs.putApproval({
        id: `ap-bound-${i}`,
        createdAt: new Date().toISOString(),
        question: `束ねる問い ${i}`,
        answeredAt: new Date().toISOString(),
        answer: `回答 ${i}`,
      });
      await stores.journal.append({
        type: 'escalation',
        question: `束ねる問い ${i}`,
        approvalId: `ap-bound-${i}`,
      });
    }

    let getApprovalCalls = 0;
    let listApprovalsCalls = 0;
    const originalGetApproval = stores.jobs.getApproval.bind(stores.jobs);
    const originalListApprovals = stores.jobs.listApprovals.bind(stores.jobs);
    stores.jobs.getApproval = async (id) => {
      getApprovalCalls += 1;
      return originalGetApproval(id);
    };
    stores.jobs.listApprovals = async (options) => {
      listApprovalsCalls += 1;
      expect(options?.pendingOnly).toBe(true);
      return originalListApprovals(options);
    };

    const digest = await buildActivityDigest(stores, { since: since() });

    expect(digest).toContain(`エスカレーション: ${total} 件`);
    expect(listApprovalsCalls).toBe(1);
    expect(getApprovalCalls).toBeLessThanOrEqual(MAX_ITEMS);
    expect(getApprovalCalls).toBeGreaterThan(0);
  });

  describe('読めない承認待ちの行（#2298）: 件数からもこの節からも消さない', () => {
    function withUnreadable(unreadable: { id?: string; reason: string }[]) {
      const stores = createMemoryStores();
      const original = stores.jobs.listApprovals.bind(stores.jobs);
      stores.jobs.listApprovals = async (options) => ({
        ...(await original(options)),
        unreadable,
      });
      return stores;
    }

    it('読めない行が在るとき、件数の行と節の両方で言う。読めた回答待ちは今までどおり出る', async () => {
      const stores = withUnreadable([{ id: 'ap-bad-1', reason: '不正な欄: createdAt' }]);
      await stores.jobs.putApproval({
        id: 'ap-ok',
        createdAt: new Date().toISOString(),
        question: '読める質問',
      });
      const digest = await buildActivityDigest(stores, { since: since() });
      expect(digest).toContain('- いま人間の回答を待っているもの: 1 件');
      expect(digest).toContain('- 読めない承認待ち（壊れた行。上の件数には入っていない）: 1 件');
      expect(digest).toContain('ap-ok');
      expect(digest).toContain('読めない承認待ちが 1 件ある（id: ap-bad-1）');
    });

    it('読めた回答待ちが0件でも、読めない行の節は出る', async () => {
      const stores = withUnreadable([{ reason: '不正な行' }]);
      const digest = await buildActivityDigest(stores, { since: since() });
      expect(digest).toContain('## 人間の回答待ち');
      expect(digest).toContain('読めない承認待ちが 1 件ある（id も取れない）');
    });

    it('0件のときは行も節も作らない', async () => {
      const stores = withUnreadable([]);
      const digest = await buildActivityDigest(stores, { since: since() });
      expect(digest).not.toContain('読めない承認待ち');
      expect(digest).not.toContain('## 人間の回答待ち');
    });
  });
});

describe('## 記憶の更新 — action / バイト数（#339）', () => {
  const since = () => new Date(Date.now() - 60_000);

  it('action と前後バイト数を出す（新形式のエントリ）', async () => {
    const stores = createMemoryStores();
    await stores.journal.append({
      type: 'memory_update',
      slug: 'values',
      cause: 'clone',
      action: 'write',
      bytesBefore: 12,
      bytesAfter: 34,
      summary: '価値観を書いた',
    });

    const digest = await buildActivityDigest(stores, { since: since() });

    expect(digest).toContain('write');
    expect(digest).toContain('12→34 バイト');
  });

  it('action / バイト数を持たない古いエントリは「不明」と明示し、0 としては出さない', async () => {
    const stores = createMemoryStores();
    await stores.journal.append({
      type: 'memory_update',
      slug: 'values',
      cause: 'human',
      summary: '古い形式のエントリ（action フィールドが無い）',
    });

    const digest = await buildActivityDigest(stores, { since: since() });

    expect(digest).not.toContain('0→0 バイト');
    expect(digest).toContain('不明');
  });

  it('バイト数（機械可読）と summary に埋め込まれた文字数（自由文）が同じ括弧に混在しない', async () => {
    const stores = createMemoryStores();
    await stores.journal.append({
      type: 'memory_update',
      slug: 'temp-note',
      cause: 'clone',
      action: 'remove',
      bytesBefore: 42,
      bytesAfter: 0,
      summary: '片付け（削除直前 40 文字）',
    });

    const digest = await buildActivityDigest(stores, { since: since() });
    const line = digest.split('\n').find((row) => row.includes('temp-note'));
    expect(line).toBeDefined();
    if (line === undefined) throw new Error('記憶の更新の行が見つからない');
    const closingParenIndex = line.indexOf('）');
    const structured = line.slice(0, closingParenIndex);
    const freeText = line.slice(closingParenIndex + 1);

    expect(structured).toContain('42→0 バイト');
    expect(structured).not.toContain('文字');
    expect(freeText).toContain('40 文字');
    expect(freeText).not.toContain('バイト');
  });
});

describe('上限で切ったことを黙らない', () => {
  const since = () => new Date(Date.now() - 60_000);

  it('マネージャー節（この節が黙って切れていた）', async () => {
    const stores = createMemoryStores();
    const now = new Date().toISOString();
    const total = MAX_ITEMS + 3;
    for (let i = 0; i < total; i += 1) {
      await stores.jobs.putJob({
        id: `mgr-${i}`,
        createdAt: now,
        updatedAt: now,
        status: 'done',
        summary: `仕事 ${i}`,
        request: `仕事 ${i}`,
      });
    }

    const digest = await buildActivityDigest(stores, { since: since() });

    expect(digest).toContain(`マネージャーへの委譲（この期間に動いたもの）: ${total} 本`);
    expect(digest).toContain('…ほか 3 件');
    expect(digest).toContain('manager_list');
    const shownIds = Array.from({ length: total }, (_, i) => i).filter((i) =>
      digest.includes(`mgr-${i} [`),
    );
    expect(shownIds).toHaveLength(MAX_ITEMS);
    expect(shownIds.length + 3).toBe(total);
  });

  it('切るときは走行中・返事待ちを先に残す（古い done に押し出させない）', async () => {
    const stores = createMemoryStores();
    const inWindow = new Date().toISOString();
    for (let i = 0; i < MAX_ITEMS; i += 1) {
      await stores.jobs.putJob({
        id: `done-${i}`,
        createdAt: inWindow,
        updatedAt: inWindow,
        status: 'done',
        summary: `片付いた ${i}`,
      });
    }
    await stores.jobs.putJob({
      id: 'mgr-running',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      status: 'running',
      summary: '本番の移行作業',
    });

    const digest = await buildActivityDigest(stores, { since: since() });

    expect(digest).toContain('mgr-running');
    expect(digest).toContain('…ほか 1 件');
  });

  it('人間の回答待ち節', async () => {
    const stores = createMemoryStores();
    const now = new Date().toISOString();
    const total = MAX_ITEMS + 1;
    for (let i = 0; i < total; i += 1) {
      await stores.jobs.putApproval({
        id: `ap-${i}`,
        createdAt: now,
        question: `確認 ${i}`,
      });
    }

    const digest = await buildActivityDigest(stores, { since: since() });

    expect(digest).toContain('…ほか 1 件');
    expect(digest).toContain('approvals_list');
    const shownIds = Array.from({ length: total }, (_, i) => i).filter((i) =>
      digest.includes(`ap-${i}（`),
    );
    expect(shownIds).toHaveLength(MAX_ITEMS);
    expect(shownIds.length + 1).toBe(total);
  });

  it('読めない行の id は MAX_ITEMS で切り、続きの取り方を書く（issue #296 / #414）', async () => {
    const stores = createMemoryStores();
    const now = new Date().toISOString();
    const unreadable = Array.from({ length: MAX_ITEMS + 1 }, (_, i) => ({
      id: `cm-unreadable-${i}`,
      at: now,
      reason: `台帳の行が壊れている ${i}`,
    }));
    const originalList = stores.commitments.list.bind(stores.commitments);
    stores.commitments.list = async (options) => {
      const base = await originalList(options);
      return { ...base, unreadable };
    };

    const digest = await buildActivityDigest(stores, { since: since() });

    expect(digest).toContain(`読めない行が ${MAX_ITEMS + 1} 件ある`);
    expect(digest).toContain('cm-unreadable-0');
    expect(digest).toContain(`cm-unreadable-${MAX_ITEMS - 1}`);
    expect(digest).not.toContain(`cm-unreadable-${MAX_ITEMS}`);
    expect(digest).toContain(
      '…ほか 1 件。id は commitment_list（id を指定しない一覧モード）を呼べば読めない行の id が全部出る',
    );
  });

  it('物理削除された片付き行の累計を頭の集計に出す（issue #416）', async () => {
    const stores = createMemoryStores();
    const originalList = stores.commitments.list.bind(stores.commitments);
    stores.commitments.list = async (options) => {
      const base = await originalList(options);
      return { ...base, trimmedClosed: 12 };
    };

    const digest = await buildActivityDigest(stores, { since: since() });

    expect(digest).toContain('保持上限を超えて物理削除された片付き行');
    expect(digest).toContain('12 件');
  });

  it('物理削除された片付き行が0件でも、その旨の行は出す（他の集計行と同じ扱い）', async () => {
    const stores = createMemoryStores();
    const digest = await buildActivityDigest(stores, { since: since() });

    expect(digest).toContain(
      '保持上限を超えて物理削除された片付き行（累計。この記憶ストアが最初から数えている分）: 0 件',
    );
  });

  const journalSections = [
    {
      name: '聞かずに決めたこと',
      entry: (i: number) =>
        ({ type: 'decision', decision: `決めた ${i}`, grounds: '記憶' }) as const,
      types: 'types=["decision"]',
      label: (i: number) => `決めた ${i}（`,
    },
    {
      name: 'エスカレーション',
      entry: (i: number) =>
        ({ type: 'escalation', question: `聞いた ${i}`, approvalId: `ap-${i}` }) as const,
      types: 'types=["escalation"]',
      label: (i: number) => `聞いた ${i} →`,
    },
    {
      name: '記憶の更新',
      entry: (i: number) =>
        ({
          type: 'memory_update',
          slug: 'values',
          cause: 'clone',
          summary: `直した ${i}`,
        }) as const,
      types: 'types=["memory_update"]',
      label: (i: number) => `直した ${i}\n`,
    },
    {
      name: '届いた外部イベント',
      entry: (i: number) =>
        ({ type: 'external_event', source: 'ci', summary: `届いた ${i}` }) as const,
      types: 'types=["external_event"]',
      label: (i: number) => `届いた ${i}\n`,
    },
  ];

  it.each(journalSections)('$name 節', async ({ entry, types, label }) => {
    const stores = createMemoryStores();
    const total = MAX_ITEMS + 2;
    for (let i = 0; i < total; i += 1) await stores.journal.append(entry(i));

    const digest = await buildActivityDigest(stores, { since: since() });

    expect(digest).toContain('…ほか 2 件');
    expect(digest).toContain(types);
    const shown = Array.from({ length: total }, (_, i) => i).filter((i) =>
      digest.includes(label(i)),
    );
    expect(shown).toHaveLength(MAX_ITEMS);
    expect(shown.length + 2).toBe(total);
  });
});

describe('届いた外部イベント — 発行元（source）別の内訳（#783）', () => {
  const since = () => new Date(Date.now() - 60_000);

  it('同じ source の同じ summary が複数件あるとき、正確な件数（source tally）と本文の形（保持した標本）がそれぞれ正しい', async () => {
    const stores = createMemoryStores();
    await stores.journal.append({ type: 'external_event', source: 'ci', summary: '落ちた' });
    await stores.journal.append({ type: 'external_event', source: 'ci', summary: '落ちた' });
    await stores.journal.append({ type: 'external_event', source: 'ci', summary: '落ちた' });
    await stores.journal.append({ type: 'external_event', source: 'ci', summary: '直った' });
    await stores.journal.append({ type: 'external_event', source: 'webhook', summary: 'ping' });

    const digest = await buildActivityDigest(stores, { since: since() });

    expect(digest).toContain('- ci: 4 件');
    expect(digest).toContain('- webhook: 1 件');
    expect(digest).toContain('- ci: 同じ本文は 2 種。最も多い1種が 3 件');
    expect(digest).toContain('- webhook: 同じ本文は 1 種。最も多い1種が 1 件');
    expect(digest).toContain('- ci: 落ちた');
    expect(digest).toContain('- webhook: ping');
  });

  it('発行元が MAX_ITEMS を超えたとき、個別行の省略と「本文の形」側の省略が両方出る', async () => {
    const stores = createMemoryStores();
    const total = MAX_ITEMS + 3;
    for (let i = 0; i < total; i += 1) {
      await stores.journal.append({
        type: 'external_event',
        source: `source-${i}`,
        summary: `届いた ${i}`,
      });
    }

    const digest = await buildActivityDigest(stores, { since: since() });

    const occurrences = digest.split('…ほか 3 件').length - 1;
    expect(occurrences).toBe(2);
    expect(digest).toContain('- その他: 3 件（3 の発行元）');
  });

  it('既存の個別行と「…ほか N 件」が消えていない', async () => {
    const stores = createMemoryStores();
    const total = MAX_ITEMS + 2;
    for (let i = 0; i < total; i += 1) {
      await stores.journal.append({
        type: 'external_event',
        source: 'ci',
        summary: `届いた ${i}`,
      });
    }

    const digest = await buildActivityDigest(stores, { since: since() });

    expect(digest).toContain('## 届いた外部イベント');
    expect(digest).toContain(`- ci: 届いた ${total - 1}`);
    expect(digest).toContain('…ほか 2 件');
    expect(digest).toContain('発行元（source）別の件数');
  });

  it('内訳（source tally）の合計が、外部イベントの正確な総数（externalsCount）と一致する（上限に当たらない場合）', async () => {
    const stores = createMemoryStores();
    const counts = [5, 4, 3, 2, 1];
    for (const [i, count] of counts.entries()) {
      for (let j = 0; j < count; j += 1) {
        await stores.journal.append({
          type: 'external_event',
          source: `src-${i}`,
          summary: `evt-${i}-${j}`,
        });
      }
    }
    const total = counts.reduce((sum, count) => sum + count, 0);

    const digest = await buildActivityDigest(stores, { since: since() });

    expect(digest).toContain(`外部イベント（日誌 external_event の行数）: ${total} 件`);
    for (const [i, count] of counts.entries()) {
      expect(digest).toContain(`- src-${i}: ${count} 件`);
    }
    expect(counts.reduce((sum, count) => sum + count, 0)).toBe(total);
    expect(digest).not.toContain('その他:');
    expect(digest).not.toContain('上限（`DIGEST_SOURCE_TALLY_LIMIT`）を超えて現れた発行元');
  });

  it('内訳（source tally）の合計が externalsCount と厳密に一致する（複数 source が DIGEST_RETAIN_LIMIT を跨ぐ場合。保持側だけでは出せない値であることも当てる）', async () => {
    const stores = createMemoryStores();
    const countA = DIGEST_RETAIN_LIMIT + 20;
    const countB = 90;
    for (let j = 0; j < countA; j += 1) {
      await stores.journal.append({ type: 'external_event', source: 'source-a', summary: `a${j}` });
    }
    for (let j = 0; j < countB; j += 1) {
      await stores.journal.append({ type: 'external_event', source: 'source-b', summary: `b${j}` });
    }
    const total = countA + countB;
    expect(countA).toBeGreaterThan(DIGEST_RETAIN_LIMIT);
    expect(total).toBeGreaterThan(DIGEST_RETAIN_LIMIT);

    const digest = await buildActivityDigest(stores, { since: since() });

    expect(digest).toContain(`外部イベント（日誌 external_event の行数）: ${total} 件`);
    expect(digest).toContain(`- source-a: ${countA} 件`);
    expect(digest).toContain(`- source-b: ${countB} 件`);
    expect(countA + countB).toBe(total);
    expect(digest).not.toContain('その他:');
    expect(digest).not.toContain('上限（`DIGEST_SOURCE_TALLY_LIMIT`）を超えて現れた発行元');
  });

  it('内訳（source tally）の件数は保持の上限（DIGEST_RETAIN_LIMIT）ではなく総数を数えている', async () => {
    const stores = createMemoryStores();
    const total = Math.floor(DIGEST_RETAIN_LIMIT * 1.5);
    for (let i = 0; i < total; i += 1) {
      await stores.journal.append({ type: 'external_event', source: 'ci', summary: `e${i}` });
    }

    const digest = await buildActivityDigest(stores, { since: since() });

    expect(total).toBeGreaterThan(DIGEST_RETAIN_LIMIT);
    expect(digest).toContain(`- ci: ${total} 件`);
    expect(digest).not.toContain(`- ci: ${DIGEST_RETAIN_LIMIT} 件`);
    expect(digest).toContain(`外部イベント（日誌 external_event の行数）: ${total} 件`);
  });

  it('表示上限（MAX_ITEMS）を超えた追跡済み発行元が「その他: N 件（M の発行元）」へ畳まれ、N と M が正しい（N ≠ M）', async () => {
    const stores = createMemoryStores();
    const sourceCount = MAX_ITEMS + 5;
    expect(sourceCount).toBeLessThan(DIGEST_SOURCE_TALLY_LIMIT);
    const counts = Array.from({ length: sourceCount }, (_, i) => sourceCount - i);
    for (const [i, count] of counts.entries()) {
      for (let j = 0; j < count; j += 1) {
        await stores.journal.append({
          type: 'external_event',
          source: `src-${String(i).padStart(2, '0')}`,
          summary: `e${i}-${j}`,
        });
      }
    }
    const total = counts.reduce((sum, count) => sum + count, 0);
    const shownCounts = counts.slice(0, MAX_ITEMS);
    const foldedCounts = counts.slice(MAX_ITEMS);
    const foldedTotal = foldedCounts.reduce((sum, count) => sum + count, 0);

    const digest = await buildActivityDigest(stores, { since: since() });

    for (const [i, count] of shownCounts.entries()) {
      expect(digest).toContain(`- src-${String(i).padStart(2, '0')}: ${count} 件`);
    }
    expect(foldedTotal).not.toBe(foldedCounts.length);
    expect(digest).toContain(`- その他: ${foldedTotal} 件（${foldedCounts.length} の発行元）`);
    const shownTotal = shownCounts.reduce((sum, count) => sum + count, 0);
    expect(shownTotal + foldedTotal).toBe(total);
    expect(digest).toContain(`外部イベント（日誌 external_event の行数）: ${total} 件`);
    expect(digest).not.toContain('上限（`DIGEST_SOURCE_TALLY_LIMIT`）を超えて現れた発行元');
  });

  it('追跡する発行元数の上限（DIGEST_SOURCE_TALLY_LIMIT）を超えたとき、超過ぶんの件数が出力に現れ、内訳の合計＋その他＋上限超過が externalsCount と一致する', async () => {
    const stores = createMemoryStores();
    const overflowSourceCount = MAX_ITEMS - 1;
    const sourceCount = DIGEST_SOURCE_TALLY_LIMIT + overflowSourceCount;
    for (let i = 0; i < sourceCount; i += 1) {
      await stores.journal.append({
        type: 'external_event',
        source: `src-${String(i).padStart(3, '0')}`,
        summary: `e${i}`,
      });
    }
    const trackedStart = overflowSourceCount;
    const trackedSources = Array.from(
      { length: DIGEST_SOURCE_TALLY_LIMIT },
      (_, i) => trackedStart + i,
    );
    const shownSources = trackedSources.slice(0, MAX_ITEMS);
    const foldedSources = trackedSources.slice(MAX_ITEMS);

    const digest = await buildActivityDigest(stores, { since: since() });

    for (const i of shownSources) {
      expect(digest).toContain(`- src-${String(i).padStart(3, '0')}: 1 件`);
    }
    expect(digest).toContain(
      `- その他: ${foldedSources.length} 件（${foldedSources.length} の発行元）`,
    );
    expect(digest).toContain(
      `- 上限（\`DIGEST_SOURCE_TALLY_LIMIT\`）を超えて現れた発行元: ${overflowSourceCount} 件（発行元の数は数えていない`,
    );
    expect(digest).toContain(`外部イベント（日誌 external_event の行数）: ${sourceCount} 件`);
    expect(shownSources.length + foldedSources.length + overflowSourceCount).toBe(sourceCount);
  });
});

describe('引き受けたまま終わっていない仕事: 古い側と新しい側の両端を出す', () => {
  const since = () => new Date(Date.now() - 60_000);

  const seedCommitments = async (stores: ReturnType<typeof createMemoryStores>, count: number) => {
    const base = Date.parse('2026-01-01T00:00:00.000Z');
    for (let i = 0; i < count; i += 1) {
      await stores.commitments.open({
        id: `cm-edge-${i}`,
        at: new Date(base + i * 1000).toISOString(),
        origin: 'human',
        body: `未了 ${i}`,
      });
    }
  };

  const shownIndices = (digest: string, total: number) =>
    Array.from({ length: total }, (_, i) => i).filter((i) => digest.includes(`cm-edge-${i}（`));

  it('未了が MAX_ITEMS より十分多いとき、最古の行と最新の行が両方出る', async () => {
    const stores = createMemoryStores();
    const total = MAX_ITEMS + 25;
    await seedCommitments(stores, total);

    const digest = await buildActivityDigest(stores, { since: since() });

    expect(digest).toContain('cm-edge-0（');
    expect(digest).toContain(`cm-edge-${total - 1}（`);
  });

  it('真ん中の行は出ない（両端に絞れている＝件数の床が上がっていない）', async () => {
    const stores = createMemoryStores();
    const total = MAX_ITEMS + 25;
    await seedCommitments(stores, total);

    const digest = await buildActivityDigest(stores, { since: since() });

    expect(digest).not.toContain('cm-edge-20（');
  });

  it('出す件数は常に MAX_ITEMS のまま、かつ重なりが無い（同じ id が2回出ない）', async () => {
    const stores = createMemoryStores();
    const total = MAX_ITEMS + 25;
    await seedCommitments(stores, total);

    const digest = await buildActivityDigest(stores, { since: since() });

    const shown = shownIndices(digest, total);
    expect(shown).toHaveLength(MAX_ITEMS);
    for (const i of shown) {
      const needle = `cm-edge-${i}（`;
      expect(digest.split(needle).length - 1).toBe(1);
    }
  });

  it('省略の断り書きが、省いた件数（真ん中の件数）を正しく言う', async () => {
    const stores = createMemoryStores();
    const total = MAX_ITEMS + 25;
    await seedCommitments(stores, total);

    const digest = await buildActivityDigest(stores, { since: since() });

    expect(digest).toContain('…ほか 25 件');
    expect(digest).toContain('真ん中を省いている');
    expect(digest).toContain('commitment_list');
  });

  it('境界: ちょうど MAX_ITEMS 件なら全件が出て、省略は1件も出ない', async () => {
    const stores = createMemoryStores();
    const total = MAX_ITEMS;
    await seedCommitments(stores, total);

    const digest = await buildActivityDigest(stores, { since: since() });

    expect(shownIndices(digest, total)).toHaveLength(total);
    expect(digest).not.toContain('…ほか');
  });

  it('境界: MAX_ITEMS 未満なら全件が出て、省略は1件も出ない', async () => {
    const stores = createMemoryStores();
    const total = MAX_ITEMS - 3;
    await seedCommitments(stores, total);

    const digest = await buildActivityDigest(stores, { since: since() });

    expect(shownIndices(digest, total)).toHaveLength(total);
    expect(digest).not.toContain('…ほか');
  });

  it('境界: MAX_ITEMS + 1 件なら、両端は残り真ん中の1件だけが省かれる（重なりなし）', async () => {
    const stores = createMemoryStores();
    const total = MAX_ITEMS + 1;
    await seedCommitments(stores, total);

    const digest = await buildActivityDigest(stores, { since: since() });

    const shown = shownIndices(digest, total);
    expect(shown).toHaveLength(MAX_ITEMS);
    expect(shown.length + 1).toBe(total);
    expect(digest).toContain('cm-edge-0（');
    expect(digest).toContain(`cm-edge-${total - 1}（`);
    expect(digest).toContain('…ほか 1 件');
    for (const i of shown) {
      const needle = `cm-edge-${i}（`;
      expect(digest.split(needle).length - 1).toBe(1);
    }
  });
});

describe('使った分', () => {
  const models = {
    'claude-opus-5': {
      inputTokens: 10,
      outputTokens: 100,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      webSearchRequests: 0,
      costUsd: 2,
    },
    'claude-sonnet-5': {
      inputTokens: 5,
      outputTokens: 50,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      webSearchRequests: 0,
      costUsd: 0.5,
    },
  };

  it('台帳が空なら「0」ではなく「記録が無い」と書く', async () => {
    const stores = createMemoryStores();

    const digest = await buildActivityDigest(stores, { since: new Date(2026, 7, 14) });

    expect(digest).toContain('## 使った分');
    expect(digest).toContain('記録が無い');
    expect(digest).not.toContain('合計: $0');
  });

  it('モデル別と高かった委譲を出し、但し書きを添える', async () => {
    const stores = createMemoryStores();
    const at = new Date(2026, 7, 14, 10, 0);
    await stores.usage.record({
      layer: 'manager',
      site: 'session',
      accumulation: 'cumulative',
      managerId: 'mgr-heavy',
      date: usageDate(at),
      at: at.toISOString(),
      snapshot: { models },
    });

    const digest = await buildActivityDigest(stores, { since: new Date(2026, 7, 14) });

    expect(digest).toContain('合計: $2.50');
    expect(digest).toContain('claude-opus-5 $2.00');
    expect(digest).toContain('mgr-heavy');
    expect(digest).toContain('請求明細ではない');
  });
});

describe('4軸の合図を1つの関数に閉じる（#415）', () => {
  const since = () => new Date(Date.now() - 60_000);
  const totals = (costUsd: number) => ({
    inputTokens: 1,
    outputTokens: 1,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    webSearchRequests: 0,
    costUsd,
  });

  it('モデル別: MAX_ITEMS を超えたら合図が出る（axis="model"）', async () => {
    const stores = createMemoryStores();
    const at = new Date();
    for (let i = 0; i < MAX_ITEMS + 1; i += 1) {
      await stores.usage.record({
        layer: 'clone',
        site: 'session',
        accumulation: 'oneshot',
        managerId: 'shared-manager',
        date: usageDate(at),
        at: at.toISOString(),
        snapshot: { models: { [`model-${i}`]: totals(100 - i) } },
      });
    }

    const digest = await buildActivityDigest(stores, { since: since() });

    expect(digest).toContain('…ほか 1 件（`usage_read` に axis="model" を渡すと続きから辿れる）');
    expect(digest).toContain('model-0 $100.00');
    expect(digest).not.toContain(`model-${MAX_ITEMS} `);
  });

  it('高かった委譲: MAX_ITEMS を超えたら合図が出る（既存の文言のまま。axis="manager"）', async () => {
    const stores = createMemoryStores();
    const at = new Date();
    for (let i = 0; i < MAX_ITEMS + 1; i += 1) {
      await stores.usage.record({
        layer: 'manager',
        site: 'session',
        accumulation: 'oneshot',
        managerId: `mgr-${i}`,
        date: usageDate(at),
        at: at.toISOString(),
        snapshot: { models: { 'shared-model': totals(100 - i) } },
      });
    }

    const digest = await buildActivityDigest(stores, { since: since() });

    expect(digest).toContain(
      '  - …ほか 1 本（`usage_read` に axis="manager" を渡すと続きから辿れる）',
    );
    expect(digest).toContain('mgr-0: $100.00');
    expect(digest).not.toContain(`mgr-${MAX_ITEMS}: `);
  });

  it('ちょうど MAX_ITEMS 件（超えていない）なら、どの軸にも合図が出ない', async () => {
    const stores = createMemoryStores();
    const at = new Date();
    for (let i = 0; i < MAX_ITEMS; i += 1) {
      await stores.usage.record({
        layer: i % 2 === 0 ? 'clone' : 'manager',
        site: i % 2 === 0 ? 'session' : 'distill',
        accumulation: 'oneshot',
        managerId: `mgr-${i}`,
        date: usageDate(at),
        at: at.toISOString(),
        snapshot: { models: { [`model-${i}`]: totals(100 - i) } },
      });
    }

    const digest = await buildActivityDigest(stores, { since: since() });

    expect(digest).not.toContain('axis="model"');
    expect(digest).not.toContain('axis="manager"');
    expect(digest).not.toContain('axis="layer"');
    expect(digest).not.toContain('axis="site"');
  });

  it('層別・場所別は2値の閉じた enum なので、行数を増やしても合図が出ない（逆向きの歯）', async () => {
    const stores = createMemoryStores();
    const at = new Date();
    for (let i = 0; i < MAX_ITEMS + 5; i += 1) {
      await stores.usage.record({
        layer: i % 2 === 0 ? 'clone' : 'manager',
        site: i % 2 === 0 ? 'session' : 'distill',
        accumulation: 'oneshot',
        managerId: `mgr-${i}`,
        date: usageDate(at),
        at: at.toISOString(),
        snapshot: { models: { [`model-${i}`]: totals(100 - i) } },
      });
    }

    const digest = await buildActivityDigest(stores, { since: since() });

    expect(digest).toContain('axis="model"');
    expect(digest).toContain('axis="manager"');
    expect(digest).not.toContain('axis="layer"');
    expect(digest).not.toContain('axis="site"');
  });

  it('出した件数と「…ほか N 件」の和が総数に戻る（合図の数が出した数から離れない）', async () => {
    const stores = createMemoryStores();
    const at = new Date();
    const total = MAX_ITEMS + 5;
    for (let i = 0; i < total; i += 1) {
      await stores.usage.record({
        layer: 'clone',
        site: 'session',
        accumulation: 'oneshot',
        managerId: 'shared-manager',
        date: usageDate(at),
        at: at.toISOString(),
        snapshot: { models: { [`model-${i}`]: totals(100 - i) } },
      });
    }

    const digest = await buildActivityDigest(stores, { since: since() });

    const line = digest.split('\n').find((l) => l.startsWith('- モデル別: '));
    expect(line).toBeDefined();
    const parts = (line ?? '').slice('- モデル別: '.length).split(' / ');
    const notice = parts.at(-1) ?? '';
    const shown = parts.slice(0, -1);
    expect(shown).toHaveLength(MAX_ITEMS);
    expect(notice).toContain(`…ほか ${total - shown.length} 件`);
  });
});

describe('digest 全体の大きさを測る歯（#414）', () => {
  const long = (n: number) => 'あ'.repeat(n);

  async function seedWorstCase() {
    const stores = createMemoryStores();
    const now = new Date().toISOString();
    const COUNT = MAX_ITEMS + 5;

    for (let i = 0; i < COUNT; i += 1) {
      await stores.commitments.open({
        id: `cm-open-${i}`,
        at: now,
        origin: 'human',
        body: `未了の依頼 ${i} ${long(300)}`,
      });
    }

    for (let i = 0; i < COUNT; i += 1) {
      const id = `cm-closed-${i}`;
      await stores.commitments.open({
        id,
        at: now,
        origin: 'human',
        body: `片付け予定だった依頼 ${i} ${long(300)}`,
      });
      await stores.commitments.close(id, now, `片付いたとした理由 ${i} ${long(200)}`, 'clone');
    }

    const unreadable = Array.from({ length: COUNT }, (_, i) => ({
      id: `cm-unreadable-${i}-${long(20)}`,
      at: now,
      reason: `台帳の行が壊れている ${i}`,
    }));
    const originalList = stores.commitments.list.bind(stores.commitments);
    stores.commitments.list = async (options) => {
      const base = await originalList(options);
      return { ...base, unreadable };
    };

    for (let i = 0; i < COUNT; i += 1) {
      await stores.schedules.put({
        kind: `kind-${i}`,
        spec: { type: 'daily', at: '09:00' },
        request: `継続中の依頼 ${i} ${long(300)}`,
        createdAt: now,
        updatedAt: now,
      });
    }

    for (let i = 0; i < COUNT; i += 1) {
      await stores.jobs.putJob({
        id: `mgr-worst-${i}`,
        createdAt: now,
        updatedAt: now,
        status: 'done',
        summary: `仕事 ${i}`,
        request: `依頼本文 ${i} ${long(300)}`,
        lastReport: `直近の報告 ${i} ${long(300)}`,
        lastFailure: {
          code: `billing_error-${i}-${long(20)}`,
          via: `stream_event-${i}-${long(20)}`,
          at: now,
        },
      });
    }

    for (let i = 0; i < COUNT; i += 1) {
      await stores.jobs.putApproval({
        id: `ap-worst-${i}`,
        createdAt: now,
        question: `確認したいこと ${i} ${long(300)}`,
      });
    }

    for (let i = 0; i < COUNT; i += 1) {
      await stores.journal.append({
        type: 'decision',
        decision: `決めたこと ${i} ${long(300)}`,
        grounds: `根拠 ${i} ${long(150)}`,
      });
      await stores.journal.append({
        type: 'escalation',
        question: `聞いたこと ${i} ${long(300)}`,
        approvalId: `ap-esc-${i}`,
        answer: `回答 ${i} ${long(150)}`,
      });
      await stores.journal.append({
        type: 'memory_update',
        slug: 'values',
        cause: 'clone',
        action: 'write',
        bytesBefore: i,
        bytesAfter: i + 1,
        summary: `直した内容 ${i} ${long(250)}`,
      });
      await stores.journal.append({
        type: 'external_event',
        source: 'ci',
        summary: `届いた内容 ${i} ${long(250)}`,
      });
    }

    const at = new Date();
    for (let i = 0; i < COUNT; i += 1) {
      await stores.usage.record({
        layer: i % 2 === 0 ? 'clone' : 'manager',
        site: i % 2 === 0 ? 'session' : 'distill',
        accumulation: 'oneshot',
        managerId: `mgr-usage-${i}-${long(20)}`,
        date: usageDate(at),
        at: at.toISOString(),
        snapshot: {
          models: {
            [`model-usage-${i}-${long(20)}`]: totals(1000 - i),
          },
        },
      });
    }

    return stores;
  }

  function totals(costUsd: number) {
    return {
      inputTokens: 1,
      outputTokens: 1,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      webSearchRequests: 0,
      costUsd,
    };
  }

  const DECLARED_SECTIONS = [
    '## 引き受けたまま終わっていない仕事' +
      '（古い側と新しい側の両端。入り切らない分は真ん中を省く。' +
      '片付いたら `commitment_close` で閉じる）',
    '## 継続中の依頼（時刻が来れば届く。前回からの続きがあるか見ること）',
    '## この期間に片付けた仕事',
    '## マネージャー（走行中・返事待ちから先に出す）',
    '## 聞かずに決めたこと',
    '## エスカレーション',
    '## 人間の回答待ち（保留中。他の仕事は進めてよい）',
    '## 記憶の更新',
    '## 届いた外部イベント',
    '## 使った分',
  ];

  it(`どの節も ${MAX_ITEMS} 件以下なら、合図（…ほか）が1つも出ない`, async () => {
    const stores = createMemoryStores();
    const now = new Date().toISOString();
    const at = new Date();
    for (let i = 0; i < MAX_ITEMS; i += 1) {
      await stores.commitments.open({
        id: `q-open-${i}`,
        at: now,
        origin: 'human',
        body: `未了 ${i}`,
      });
      const closedId = `q-closed-${i}`;
      await stores.commitments.open({
        id: closedId,
        at: now,
        origin: 'human',
        body: `片付け ${i}`,
      });
      await stores.commitments.close(closedId, now, `理由 ${i}`, 'clone');
      await stores.schedules.put({
        kind: `q-kind-${i}`,
        spec: { type: 'daily', at: '09:00' },
        request: `継続 ${i}`,
        createdAt: now,
        updatedAt: now,
      });
      await stores.jobs.putJob({
        id: `q-mgr-${i}`,
        createdAt: now,
        updatedAt: now,
        status: 'done',
        summary: `仕事 ${i}`,
        request: `依頼 ${i}`,
      });
      await stores.jobs.putApproval({ id: `q-ap-${i}`, createdAt: now, question: `確認 ${i}` });
      await stores.journal.append({ type: 'decision', decision: `決めた ${i}`, grounds: '記憶' });
      await stores.journal.append({
        type: 'escalation',
        question: `聞いた ${i}`,
        approvalId: `q-esc-${i}`,
      });
      await stores.journal.append({
        type: 'memory_update',
        slug: 'values',
        cause: 'clone',
        action: 'write',
        bytesBefore: i,
        bytesAfter: i + 1,
        summary: `直した ${i}`,
      });
      await stores.journal.append({ type: 'external_event', source: 'ci', summary: `届いた ${i}` });
      await stores.usage.record({
        layer: i % 2 === 0 ? 'clone' : 'manager',
        site: i % 2 === 0 ? 'session' : 'distill',
        accumulation: 'oneshot',
        managerId: `q-usage-${i}`,
        date: usageDate(at),
        at: at.toISOString(),
        snapshot: { models: { [`q-model-${i}`]: totals(10 - i / 100) } },
      });
    }
    const unreadable = Array.from({ length: MAX_ITEMS }, (_, i) => ({
      id: `q-unreadable-${i}`,
      at: now,
      reason: `壊れている ${i}`,
    }));
    const originalList = stores.commitments.list.bind(stores.commitments);
    stores.commitments.list = async (options) => {
      const base = await originalList(options);
      return { ...base, unreadable };
    };

    const digest = await buildActivityDigest(stores, { since: new Date(Date.now() - 60_000) });

    for (const heading of DECLARED_SECTIONS) expect(digest).toContain(heading);
    expect(digest).not.toContain('…ほか');
  });
  it('見出し（`## `）の集合が、宣言した集合と完全一致する', async () => {
    const stores = await seedWorstCase();
    const digest = await buildActivityDigest(stores, { since: new Date(Date.now() - 60_000) });

    const headings = digest.split('\n').filter((line) => line.startsWith('## '));
    expect(new Set(headings)).toEqual(new Set(DECLARED_SECTIONS));
  });

  const CHARACTER_BUDGET = 47_000;

  it(`worst case でも digest.length が ${CHARACTER_BUDGET} 文字以下である`, async () => {
    const stores = await seedWorstCase();
    const digest = await buildActivityDigest(stores, { since: new Date(Date.now() - 60_000) });

    process.stderr.write(`digest.length=${digest.length}\n`);
    expect(digest.length).toBeLessThanOrEqual(CHARACTER_BUDGET);
  });
});

describe('#857: 終端していて誰も望んでいない終わり方（lost / failed）を分類する', () => {
  function input(over: Partial<UnobservedOutcomeInput> = {}): UnobservedOutcomeInput {
    return {
      status: 'lost',
      ...over,
    };
  }

  const FAILURE = {
    code: 'billing_error',
    via: 'assistant_error',
    at: '2026-09-12T01:00:00.000Z',
  } as const;

  describe('isManagerOutcomeUnobserved（述語）', () => {
    it('lost と failed だけが真である', () => {
      expect(isManagerOutcomeUnobserved('lost')).toBe(true);
      expect(isManagerOutcomeUnobserved('failed')).toBe(true);
    });

    it('⭐ running / waiting_human / done / stopped は偽である', () => {
      for (const status of ['running', 'waiting_human', 'done', 'stopped'] as const) {
        expect(isManagerOutcomeUnobserved(status), `${status} が対象に入っている`).toBe(false);
      }
    });

    it('⛔ isManagerAwaitingJudgement は lost 1値のままである（failed を飲み込んでいない）', () => {
      expect(isManagerAwaitingJudgement('lost')).toBe(true);
      expect(isManagerAwaitingJudgement('failed')).toBe(false);
    });
  });

  describe('順位の芯: 依頼者に本文が届いているか', () => {
    it('lastReport が無ければ none（rank 0。最優先）', () => {
      const outcome = classifyUnobservedOutcome(input());
      expect(outcome?.reportState).toBe('none');
      expect(outcome?.rank).toBe(0);
    });

    it('lastReport が在り lastFailure も在れば failure-wrapped（rank 1）', () => {
      const outcome = classifyUnobservedOutcome(
        input({
          lastReport: '（このターンは応答を返さずに終わった: billing_error）',
          lastFailure: FAILURE,
        }),
      );
      expect(outcome?.reportState).toBe('failure-wrapped');
      expect(outcome?.rank).toBe(1);
    });

    it('lastReport が在り lastFailure が無ければ delivered（rank 2）', () => {
      const outcome = classifyUnobservedOutcome(input({ lastReport: '終わった' }));
      expect(outcome?.reportState).toBe('delivered');
      expect(outcome?.rank).toBe(2);
    });

    it('⭐ lastReport が空文字でも「届いていない」とは言わない（undefined とは別）', () => {
      expect(classifyUnobservedOutcome(input({ lastReport: '' }))?.reportState).toBe('delivered');
    });

    it('failed でも同じ3値が立つ（lost 専用の軸ではない）', () => {
      expect(classifyUnobservedOutcome(input({ status: 'failed' }))?.reportState).toBe('none');
      expect(
        classifyUnobservedOutcome(
          input({ status: 'failed', lastReport: 'x', lastFailure: FAILURE }),
        )?.reportState,
      ).toBe('failure-wrapped');
    });
  });

  it('⭐ 対象外の委譲は null（分類も字面も出ない）', () => {
    for (const status of ['running', 'waiting_human', 'done', 'stopped'] as const) {
      expect(classifyUnobservedOutcome(input({ status })), status).toBeNull();
      expect(describeUnobservedOutcome(input({ status })), status).toBeNull();
    }
  });

  describe('字面（describeUnobservedOutcome）', () => {
    it('⭐ 3値は互いに違う文になる', () => {
      const none = describeUnobservedOutcome(input());
      const wrapped = describeUnobservedOutcome(input({ lastReport: 'x', lastFailure: FAILURE }));
      const delivered = describeUnobservedOutcome(input({ lastReport: 'x' }));
      expect(new Set([none, wrapped, delivered]).size).toBe(3);
    });

    it('⭐ 3値に固有の語が在り、他の2値には出ない（入れ替えると赤くなる）', () => {
      const texts: Record<UnobservedReportState, string> = {
        none: describeUnobservedOutcome(input())!,
        'failure-wrapped': describeUnobservedOutcome(
          input({ lastReport: 'x', lastFailure: FAILURE }),
        )!,
        delivered: describeUnobservedOutcome(input({ lastReport: 'x' }))!,
      };
      const signature: Record<UnobservedReportState, string> = {
        none: '終端までに本文が1文字も届いていない',
        'failure-wrapped': '包んだエラー文であって報告ではない',
        delivered: '完遂した報告とは限らない',
      };
      for (const [state, word] of Object.entries(signature) as [UnobservedReportState, string][]) {
        expect(texts[state], `${state} に固有の語が無い`).toContain(word);
        for (const other of Object.keys(signature) as UnobservedReportState[]) {
          if (other === state) continue;
          expect(texts[other], `${other} に ${state} の語が漏れている`).not.toContain(word);
        }
      }
    });

    it('🔴 どの枝でも「成果が無い」と断定する語を出さない', () => {
      const reports: Partial<UnobservedOutcomeInput>[] = [
        {},
        { lastReport: 'x', lastFailure: FAILURE },
        { lastReport: 'x' },
      ];
      for (const report of reports) {
        const text = describeUnobservedOutcome(input(report))!;
        expect(text, `${JSON.stringify(report)}`).not.toBeNull();
        for (const forbidden of ['成果が無い', '成果は無い', '成果なし', '成果が無かった']) {
          expect(text, `断定の語（${forbidden}）が出ている`).not.toContain(forbidden);
        }
      }
    });
  });
});

describe('OOM の本体を直す（issue #1283）— 日誌走査をページ単位に有界化する', () => {
  function storesWithSyntheticJournal(journal: Stores['journal']): Stores {
    return { ...createMemoryStores(), journal };
  }

  it('⭐ 窓に大量の tool_use 行があっても、渡した limit は常に有限で、渡ってきた総件数が上限で頭打ちになる（ヒープが有界であることの代理指標）', async () => {
    // `total` は固定の数値リテラルにする: 定数から掛け算で作ると、変異で `Infinity` になり偽ストアの走査が終わらなくなるため
    const total = 150_000;
    const fake = createSyntheticJournalStore({
      total,
      baseTimeMs: Date.now(),
      entryAt: () => ({ type: 'tool_use', actor: 'manager:mgr-oom', tool: 'Bash', input: {} }),
    });

    const digest = await buildActivityDigest(storesWithSyntheticJournal(fake.store), {
      since: new Date(0),
    });

    expect(fake.totalReturned).toBeLessThanOrEqual(
      DIGEST_JOURNAL_SCAN_LIMIT + JOURNAL_SCAN_PAGE_SIZE,
    );
    expect(fake.totalReturned).toBeLessThan(total);

    expect(fake.calls.length).toBeGreaterThan(0);
    for (const call of fake.calls) {
      expect(Number.isFinite(call.limit)).toBe(true);
      expect(call.limit).toBeGreaterThan(0);
    }

    expect(fake.calls.length).toBeLessThan(250);

    expect(digest).toContain('DIGEST_JOURNAL_SCAN_LIMIT');

    expect(digest).toContain(`マネージャー・作業者のツール実行: ${DIGEST_JOURNAL_SCAN_LIMIT} 件`);
  });

  it('打ち切っていない普通の窓では、件数が正確で、打ち切りの名乗りが出力に無い', async () => {
    const total = 12;
    const fake = createSyntheticJournalStore({
      total,
      baseTimeMs: Date.now(),
      entryAt: (index) => {
        if (index % 4 === 0) {
          return { type: 'decision', decision: `decision-${index}`, grounds: 'g' };
        }
        if (index % 4 === 1) {
          return {
            type: 'memory_update',
            slug: 'values',
            cause: 'clone',
            summary: `memo-${index}`,
          };
        }
        if (index % 4 === 2) {
          return { type: 'external_event', source: 'ci', summary: `event-${index}` };
        }
        return { type: 'tool_use', actor: 'clone', tool: 'Bash', input: {} };
      },
    });

    const digest = await buildActivityDigest(storesWithSyntheticJournal(fake.store), {
      since: new Date(0),
    });

    expect(digest).not.toContain('DIGEST_JOURNAL_SCAN_LIMIT');
    expect(digest).toContain('自分で決めたこと（日誌の decision）: 3 件');
    expect(digest).toContain('記憶の更新: 3 件');
    expect(digest).toContain('外部イベント（日誌 external_event の行数）: 3 件');
    expect(digest).toContain('あなた自身が手を動かした回数（委譲せずに使った道具）: 3 件');
  });

  it('保持の上限（DIGEST_RETAIN_LIMIT）を超えた種別があっても、走査そのものは打ち切っておらず、件数はカウンタの値で正確なまま（保持した配列の .length から取っていない）', async () => {
    const total = Math.floor(DIGEST_RETAIN_LIMIT * 1.5);
    const fake = createSyntheticJournalStore({
      total,
      baseTimeMs: Date.now(),
      entryAt: (index) => ({ type: 'decision', decision: `decision-${index}`, grounds: 'g' }),
    });

    const digest = await buildActivityDigest(storesWithSyntheticJournal(fake.store), {
      since: new Date(0),
    });

    expect(digest).not.toContain('DIGEST_JOURNAL_SCAN_LIMIT');
    expect(digest).toContain(`自分で決めたこと（日誌の decision）: ${total} 件`);
    const shown = digest.split('\n').filter((row) => row.includes('decision-')).length;
    expect(shown).toBe(MAX_ITEMS);
    expect(digest).toContain(`…ほか ${total - MAX_ITEMS} 件`);
  });

  it('exchange の走査は with: ["human"] をストア側へ渡す（人間以外の往復が limit の予算を食わない。issue #418 と同じ形の再発を防ぐ歯）', async () => {
    const total = 150_001;
    const humanIndex = total - 1;
    const fake = createSyntheticJournalStore({
      total,
      baseTimeMs: Date.now(),
      entryAt: (index) =>
        index === humanIndex
          ? { type: 'exchange', with: 'human', role: 'inbound', text: 'やあ' }
          : { type: 'exchange', with: 'manager', role: 'outbound', text: 'ノイズ' },
    });

    const digest = await buildActivityDigest(storesWithSyntheticJournal(fake.store), {
      since: new Date(0),
    });

    const exchangeCalls = fake.calls.filter((call) => call.types?.includes('exchange'));
    expect(exchangeCalls.length).toBeGreaterThan(0);
    for (const call of exchangeCalls) {
      expect(call.with).toEqual(['human']);
    }

    expect(digest).toContain('人間からの発言: 1 件');
  });

  it('escalation の保持上限に当たったときは、件数の行に「束ねた元の行を全部は読んでいない」という注記が付く', async () => {
    const total = DIGEST_RETAIN_LIMIT + 50;
    const fake = createSyntheticJournalStore({
      total,
      baseTimeMs: Date.now(),
      entryAt: (index) => ({
        type: 'escalation',
        question: `question-${index}`,
        approvalId: `ap-${index}`,
      }),
    });

    const digest = await buildActivityDigest(storesWithSyntheticJournal(fake.store), {
      since: new Date(0),
    });

    expect(digest).not.toContain('DIGEST_JOURNAL_SCAN_LIMIT');

    const line = digest.split('\n').find((row) => row.startsWith('- エスカレーション:'));
    expect(line).toBeDefined();
    expect(line).toContain('束ねた元の行を全部は読んでいない');
  });

  it('escalation の保持上限に当たっていないときは、件数の行に注記が付かない（既存の文面を1文字も変えない）', async () => {
    const fake = createSyntheticJournalStore({
      total: 3,
      baseTimeMs: Date.now(),
      entryAt: (index) => ({
        type: 'escalation',
        question: `question-${index}`,
        approvalId: `ap-${index}`,
      }),
    });

    const digest = await buildActivityDigest(storesWithSyntheticJournal(fake.store), {
      since: new Date(0),
    });

    const line = digest.split('\n').find((row) => row.startsWith('- エスカレーション:'));
    expect(line).toBe('- エスカレーション: 3 件');
  });
});
