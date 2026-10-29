import { describe, expect, it } from 'vitest';

import {
  createDelegatedPermissionRuleService,
  delegatedPermissionRulesOf,
  parseDelegatedPermissionRules,
} from './delegated-permission-rules.js';
import {
  createRunnerRegistry,
  RunnerPermissionRulesUnsupportedError,
  type RunnerClient,
  type RunnerPermissionRulesResult,
} from './runner-protocol.js';
import type { PermissionGrant } from './schema.js';
import { createMemoryStores } from './testing.js';

// 人間が承認した許可のうち、委譲先のセッションへ載せる規則を選び、runner へ配る（#4952）

function grant(id: string, rule: string, extra: Partial<PermissionGrant> = {}): PermissionGrant {
  return {
    id,
    rule,
    allows: ['x'],
    denies: ['y'],
    approvalId: `ap-${id}`,
    answer: '許可します',
    grantedAt: '2026-10-16T00:00:00.000Z',
    route: { principalKind: 'account', accountId: 'acc-1' },
    ...extra,
  };
}

describe('載せる許可の境界（#4952 の推奨の形）', () => {
  it('完全一致は載る', () => {
    expect(delegatedPermissionRulesOf([grant('g1', 'Bash(gh pr view 12)')])).toEqual({
      rules: ['Bash(gh pr view 12)'],
      grantIds: ['g1'],
      autoModeStripped: [],
    });
  });

  // 元は「前方一致は載らない」だった。#5435 でオーナーが前方一致も載せると決めたので期待値を反転した（承認 589d747b）。
  it('前方一致も載る', () => {
    expect(delegatedPermissionRulesOf([grant('g1', 'Bash(gh pr view:*)')])).toMatchObject({
      rules: ['Bash(gh pr view:*)'],
      grantIds: ['g1'],
    });
  });

  it('前方一致の prefix に `*` を含むもの・空の prefix（`Bash(:*)`・`Bash(*)`）は載らない', () => {
    expect(
      delegatedPermissionRulesOf([
        grant('g-star', 'Bash(ls *.ts:*)'),
        grant('g-empty', 'Bash(:*)'),
        grant('g-all', 'Bash(*)'),
        grant('g-star-only', 'Bash(*:*)'),
      ]),
    ).toMatchObject({ rules: [], grantIds: [] });
  });

  it('取り消し済みは載らない', () => {
    expect(
      delegatedPermissionRulesOf([
        grant('g1', 'Bash(gh pr view 12)', { revokedAt: '2026-10-16T01:00:00.000Z' }),
      ]).rules,
    ).toEqual([]);
  });

  it('`*` と改行を含む command は載らない', () => {
    expect(
      delegatedPermissionRulesOf([
        grant('g-star', 'Bash(ls *.ts)'),
        grant('g-nl', 'Bash(echo a\necho b)'),
        grant('g-cr', 'Bash(echo a\recho b)'),
      ]).rules,
    ).toEqual([]);
  });

  it('同じ規則の許可が2つあっても規則は1つ（id は両方残す）', () => {
    expect(
      delegatedPermissionRulesOf([grant('g1', 'Bash(make test)'), grant('g2', 'Bash(make test)')]),
    ).toEqual({ rules: ['Bash(make test)'], grantIds: ['g1', 'g2'], autoModeStripped: [] });
  });
});

describe('runner の側の検め直し（parseDelegatedPermissionRules）', () => {
  it('載せてよい形だけを通し、重複は1つにする', () => {
    expect(parseDelegatedPermissionRules(['Bash(echo a)', 'Bash(echo a)'])).toEqual([
      'Bash(echo a)',
    ]);
  });

  it('前方一致（`Bash(<prefix>:*)`）も通す（#5435）', () => {
    expect(parseDelegatedPermissionRules(['Bash(gh pr view:*)', 'Bash(echo a)'])).toEqual([
      'Bash(gh pr view:*)',
      'Bash(echo a)',
    ]);
  });

  // 元は ['前方一致', 'Bash(SECRET-cmd:*)'] を断る歯だった。#5435 で前方一致を受けるようにしたので、
  // 前方一致のまま壊れた形（`*` を含む prefix・空の prefix）を断る歯に反転した。
  for (const [label, rule] of [
    ['前方一致の prefix に `*` を含む', 'Bash(SECRET-cmd *:*)'],
    ['空の前方一致', 'Bash(:*)'],
    ['`*` だけ', 'Bash(*)'],
    ['`*` を含む', 'Bash(ls SECRET*.ts)'],
    ['Bash でない', 'Edit(SECRET)'],
    ['シェルの区切り', 'Bash(echo SECRET; rm -rf /)'],
  ] as const) {
    it(`${label} は断り、断りの文言に規則の本文を載せない`, () => {
      let message = '';
      try {
        parseDelegatedPermissionRules(['Bash(echo ok)', rule]);
      } catch (error) {
        message = String(error);
      }
      expect(message).toContain('1 番目');
      expect(message).not.toContain('SECRET');
    });
  }

  it('配列でなければ断る', () => {
    expect(() => parseDelegatedPermissionRules('Bash(echo a)')).toThrow('配列でない');
  });
});

function fakeRunner(
  runnerId: string,
  behavior: 'ok' | 'fail' | 'unsupported' = 'ok',
): RunnerClient & { placed: string[][] } {
  const placed: string[][] = [];
  let last = '';
  return {
    runnerId,
    placed,
    async setPermissionRules(rules: readonly string[]): Promise<RunnerPermissionRulesResult> {
      if (behavior === 'fail') throw new Error('runner に繋がらない（テスト）');
      if (behavior === 'unsupported') throw new RunnerPermissionRulesUnsupportedError(runnerId);
      placed.push([...rules]);
      const key = JSON.stringify(rules);
      const changed = key !== last;
      last = key;
      return { count: rules.length, changed };
    },
  } as unknown as RunnerClient & { placed: string[][] };
}

describe('配るサービス（#4952）', () => {
  it('pushAll は開いている全 runner へ一覧を配り、runner ごとの件数と許可の id を日誌に残す（規則の本文は書かない）', async () => {
    const stores = createMemoryStores();
    await stores.permissionGrants.put(grant('g1', 'Bash(gh pr view 12)'));
    await stores.permissionGrants.put(grant('g2', 'Bash(gh pr view:*)'));
    const a = fakeRunner('runner-a');
    const b = fakeRunner('runner-b');
    const service = createDelegatedPermissionRuleService({
      stores,
      runners: createRunnerRegistry([a, b]),
    });

    const results = await service.pushAll('許可 g1 が記録された');

    // 元は前方一致の g2 を載せず 1 件だった。#5435 で前方一致も載せるので 2 件にした
    expect(a.placed).toEqual([['Bash(gh pr view 12)', 'Bash(gh pr view:*)']]);
    expect(b.placed).toEqual([['Bash(gh pr view 12)', 'Bash(gh pr view:*)']]);
    expect(results.map((r) => [r.runnerId, r.ok, r.count])).toEqual([
      ['runner-a', true, 2],
      ['runner-b', true, 2],
    ]);
    const journal = await stores.journal.list({});
    const text = JSON.stringify(journal);
    expect(text).toContain('runner-a へ委譲先の許可規則を 2 件配った（許可 id: g1, g2）');
    expect(text).toContain('runner-b へ委譲先の許可規則を 2 件配った（許可 id: g1, g2）');
    expect(text).toContain('許可 g1 が記録された');
    expect(text).not.toContain('gh pr view');
  });

  it('配れなかった runner は理由を日誌に残し、投げない（他の runner には届く）', async () => {
    const stores = createMemoryStores();
    await stores.permissionGrants.put(grant('g1', 'Bash(make test)'));
    const ok = fakeRunner('runner-ok');
    const broken = fakeRunner('runner-broken', 'fail');
    const old = fakeRunner('runner-old', 'unsupported');
    const service = createDelegatedPermissionRuleService({
      stores,
      runners: createRunnerRegistry([ok, broken, old]),
    });
    const pushed: unknown[] = [];
    service.onPushed?.((results) => pushed.push(results));

    const results = await service.pushAll('許可 g1 が取り消された');

    expect(ok.placed).toEqual([['Bash(make test)']]);
    expect(results.find((r) => r.runnerId === 'runner-broken')).toMatchObject({
      ok: false,
      error: expect.stringContaining('runner に繋がらない（テスト）'),
    });
    expect(results.find((r) => r.runnerId === 'runner-old')).toMatchObject({
      ok: false,
      unsupported: true,
    });
    expect(pushed).toHaveLength(1);
    const text = JSON.stringify(await stores.journal.list({}));
    expect(text).toContain('runner-broken へ委譲先の許可規則を配れなかった');
    expect(text).toContain('runner に繋がらない（テスト）');
    expect(text).not.toContain('make test');
  });

  it('syncRunner は一覧が変わったときだけ「配った」を日誌に残す（名乗り直しで積まない）', async () => {
    const stores = createMemoryStores();
    await stores.permissionGrants.put(grant('g1', 'Bash(make test)'));
    const runner = fakeRunner('runner-a');
    const service = createDelegatedPermissionRuleService({ stores });

    expect(await service.syncRunner(runner)).toEqual({ count: 1, changed: true });
    expect(await service.syncRunner(runner)).toEqual({ count: 1, changed: false });

    const placed = (await stores.journal.list({})).filter(
      (entry) => entry.type === 'decision' && entry.decision.includes('件配った'),
    );
    expect(placed).toHaveLength(1);
  });

  it('auto mode に捨てられる見込みの規則は、許可 id と規則の名前を日誌に1本残す（配る一覧からは外さない）', async () => {
    const stores = createMemoryStores();
    await stores.permissionGrants.put(grant('g-ok', 'Bash(gh pr merge:*)'));
    await stores.permissionGrants.put(grant('g-exact', 'Bash(make SECRET-exact)'));
    await stores.permissionGrants.put(grant('g-py', 'Bash(python:*)'));
    await stores.permissionGrants.put(grant('g-npm', 'Bash(npm run:*)'));
    const runner = fakeRunner('runner-a');
    const service = createDelegatedPermissionRuleService({ stores });

    await service.syncRunner(runner);

    // 回り道で防がない: 捨てられる見込みの規則も配る一覧に載ったまま
    expect(runner.placed).toEqual([
      ['Bash(gh pr merge:*)', 'Bash(make SECRET-exact)', 'Bash(python:*)', 'Bash(npm run:*)'],
    ]);
    const stripped = (await stores.journal.list({})).filter(
      (entry) => entry.type === 'decision' && entry.decision.includes('捨てられる見込み'),
    );
    expect(stripped).toHaveLength(1);
    const text = JSON.stringify(stripped);
    expect(text).toContain('g-py `Bash(python:*)`');
    expect(text).toContain('g-npm `Bash(npm run:*)`');
    expect(text).toContain('配る一覧からは外していない');
    expect(text).toContain('0.3.312');
    // 当たらない規則・完全一致の本文は載せない
    expect(text).not.toContain('gh pr merge');
    expect(text).not.toContain('SECRET-exact');

    // 同じ一覧の名乗り直しでは積まない
    await service.syncRunner(runner);
    const again = (await stores.journal.list({})).filter(
      (entry) => entry.type === 'decision' && entry.decision.includes('捨てられる見込み'),
    );
    expect(again).toHaveLength(1);
  });

  it('捨てられる見込みの規則が無ければ、その日誌は出ない', async () => {
    const stores = createMemoryStores();
    await stores.permissionGrants.put(grant('g1', 'Bash(gh pr merge:*)'));
    await stores.permissionGrants.put(grant('g2', 'Bash(python script.py)'));
    const runner = fakeRunner('runner-a');
    const service = createDelegatedPermissionRuleService({
      stores,
      runners: createRunnerRegistry([runner]),
    });

    await service.syncRunner(runner);
    await service.pushAll('試験');

    const entries = await stores.journal.list({});
    expect(JSON.stringify(entries)).not.toContain('捨てられる見込み');
  });

  it('pushAll も、一覧が変わった runner にだけ捨てられる見込みの規則を残す', async () => {
    const stores = createMemoryStores();
    await stores.permissionGrants.put(grant('g-env', 'Bash(env:*)'));
    const runner = fakeRunner('runner-a');
    const service = createDelegatedPermissionRuleService({
      stores,
      runners: createRunnerRegistry([runner]),
    });

    await service.pushAll('1回目');
    await service.pushAll('2回目（同じ一覧）');

    const stripped = (await stores.journal.list({})).filter(
      (entry) => entry.type === 'decision' && entry.decision.includes('捨てられる見込み'),
    );
    expect(stripped).toHaveLength(1);
    expect(JSON.stringify(stripped)).toContain('g-env `Bash(env:*)`');
  });

  it('syncRunner は口を持たない runner へは null を返す', async () => {
    const service = createDelegatedPermissionRuleService({ stores: createMemoryStores() });
    expect(await service.syncRunner({ runnerId: 'r' } as unknown as RunnerClient)).toBeNull();
  });
});
