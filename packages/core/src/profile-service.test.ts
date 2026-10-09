import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { makeTempDirSync } from '../../../vitest.tmpdir.js';

import {
  createProfileApplier,
  createProfileVessel,
  fingerprintOf,
  type ProfileApplier,
} from './profile.js';
import {
  composedFingerprints,
  composeProfileScript,
  createProfileService,
  ProfileRollbackFailedError,
  profileScopeAppliesTo,
} from './profile-service.js';
import type { RunnerClient, RunnerProfileFingerprint } from './runner-protocol.js';
import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';

let dir: string;

beforeEach(() => {
  dir = makeTempDirSync('alteroid-profile-service-');
});

function fakeRunner(runnerId = 'runner-test') {
  const received: string[] = [];
  let held: RunnerProfileFingerprint | undefined;
  const runner = {
    runnerId,
    workspacePath: '/work',
    received,
    async profile() {
      return held;
    },
    async setProfile(script: string) {
      received.push(script);
      held =
        script.length === 0
          ? undefined
          : {
              sha256: fingerprintOf(script),
              bytes: Buffer.byteLength(script),
              updatedAt: '2026-01-01T00:00:00.000Z',
            };
      return { ok: true as const, ...(held === undefined ? {} : { profile: held }) };
    },
  };
  return runner as unknown as RunnerClient & { received: string[] };
}

/**
 * 最終状態だけを見ない: 直列化していない実装でも処理順しだいでたまたま揃って通るので、
 * 1更新の全段が終わる前に次が始まったかを直接見る。
 */
function tripwire(stores: Stores, runner: RunnerClient & { received: string[] }) {
  const violations: string[] = [];
  let busy = false;

  const store = stores.profile;
  stores.profile = {
    list: async () => {
      if (busy) violations.push('更新中に別の操作がストアを読んだ');
      return store.list();
    },
    set: (name, script, scope) => store.set(name, script, scope),
    remove: (name) => store.remove(name),
    replaceAll: (previous) => store.replaceAll(previous),
    clear: () => store.clear(),
  };

  const push = runner.setProfile.bind(runner);
  runner.setProfile = async (script: string) => {
    const result = await push(script);
    busy = false;
    return result;
  };

  return {
    violations,
    enter() {
      if (busy) violations.push('前の更新が終わる前に次の更新が始まった');
      busy = true;
    },
  };
}

function fakeApplier(check: (script: string) => void = () => undefined): ProfileApplier {
  return {
    vessel: {} as never,
    fingerprint: () => undefined,
    env: () => ({}),
    async apply(script: string) {
      const prepared = await this.prepare(script);
      if (prepared.ok) await prepared.commit();
      return prepared;
    },
    async prepare(script: string) {
      check(script);
      return {
        ok: true,
        commit: async () => undefined,
        discard: async () => undefined,
      };
    },
  };
}

function registryOf(runners: (RunnerClient & { received: string[] })[]) {
  return {
    async list() {
      return runners;
    },
    async get(id: string) {
      return runners.find((runner) => runner.runnerId === id) ?? null;
    },
    async select() {
      throw new Error('この検証では使わない');
    },
  } as never;
}

describe('同時に更新されたとき', () => {
  it('層ごとに違う本文が残らない（最後の更新に3つとも揃う）', async () => {
    const stores = createMemoryStores();
    const runner = fakeRunner();
    const path = join(dir, 'profile.sh');

    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let evaluations = 0;

    const wire = tripwire(stores, runner);
    const vessel = createProfileVessel({ path });
    const real = createProfileApplier({ vessel, baseEnv: () => ({}) });
    const applier = {
      ...real,
      async apply(script: string) {
        evaluations += 1;
        wire.enter();
        if (evaluations === 1) await blocked;
        return real.apply(script);
      },
    };

    const service = createProfileService({
      stores,
      applier,
      runners: registryOf([runner]),
    });

    const first = service.apply('export WHICH=A');
    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = service.apply('export WHICH=B');
    release?.();
    await Promise.all([first, second]);

    const expected = 'export WHICH=B\n';
    expect((await stores.profile.list())[0]?.script).toBe(expected);
    expect(readFileSync(path, 'utf8')).toContain('export WHICH=B');
    expect(vessel.fingerprint()?.sha256).toBe(fingerprintOf(expected));
    expect(runner.received.at(-1)).toBe(expected);

    expect(runner.received).toEqual(['export WHICH=A\n', 'export WHICH=B\n']);
    expect(wire.violations).toEqual([]);
  });

  it('再接続時の降ろし直しも同じ列に入る（更新の途中に割り込まない）', async () => {
    const stores = createMemoryStores();
    const runner = fakeRunner();
    const path = join(dir, 'profile.sh');

    const wire = tripwire(stores, runner);

    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let evaluations = 0;
    const real = createProfileApplier({
      vessel: createProfileVessel({ path }),
      baseEnv: () => ({}),
    });
    const applier = {
      ...real,
      async apply(script: string) {
        evaluations += 1;
        wire.enter();
        if (evaluations === 1) await blocked;
        return real.apply(script);
      },
    };

    const service = createProfileService({ stores, applier, runners: registryOf([runner]) });

    const update = service.apply('export WHICH=NEW');
    await new Promise((resolve) => setTimeout(resolve, 10));
    const sync = service.syncRunner(runner);
    release?.();
    await Promise.all([update, sync]);

    expect(wire.violations).toEqual([]);
    expect((await stores.profile.list())[0]?.script).toBe('export WHICH=NEW\n');
    expect(runner.received.at(-1)).toBe('export WHICH=NEW\n');
  });

  it('正本へ書けなかったら、クローンにも効かせない（旧版で揃ったまま）', async () => {
    const stores = createMemoryStores();
    const runner = fakeRunner();
    const path = join(dir, 'profile.sh');
    const vessel = createProfileVessel({ path });
    const applier = createProfileApplier({ vessel, baseEnv: () => ({}) });
    const service = createProfileService({ stores, applier, runners: registryOf([runner]) });

    await service.apply('export WHICH=OLD');
    const before = await stores.profile.list();

    const write = stores.profile.set.bind(stores.profile);
    stores.profile.set = async () => {
      throw new Error('記憶ストアが一時的に落ちた');
    };

    await expect(service.apply('export WHICH=NEW')).rejects.toThrow('記憶ストア');

    stores.profile.set = write;

    expect(await stores.profile.list()).toEqual(before);
    expect(readFileSync(path, 'utf8')).toContain('export WHICH=OLD');
    expect(applier.env().WHICH).toBe('OLD');
    expect(vessel.fingerprint()?.sha256).toBe(fingerprintOf('export WHICH=OLD\n'));
    expect(runner.received).toEqual(['export WHICH=OLD\n']);
  });

  it('クローンへ反映できなかったら、正本も元へ戻す', async () => {
    const stores = createMemoryStores();
    const runner = fakeRunner();
    const path = join(dir, 'profile.sh');
    const vessel = createProfileVessel({ path });
    const real = createProfileApplier({ vessel, baseEnv: () => ({}) });

    let breakCommit = false;
    const applier: ProfileApplier = {
      ...real,
      async prepare(script: string) {
        const prepared = await real.prepare(script);
        if (!breakCommit) return prepared;
        return {
          ...prepared,
          commit: async () => {
            throw new Error('器へ移せなかった');
          },
        };
      },
    };
    const service = createProfileService({ stores, applier, runners: registryOf([runner]) });

    await service.apply('export WHICH=OLD');
    const before = await stores.profile.list();

    breakCommit = true;
    // 文言ではなく状態を先に見る: 文言を先に確かめると、補償を外したとき何が壊れたのか出てこない。
    const failure = await service.apply('export WHICH=NEW').then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).not.toBeNull();

    // 本文だけを見ない: 取り消した更新で `updatedAt` が進むと、成功していない更新が最後の変更に見える。
    expect(await stores.profile.list()).toEqual(before);
    expect(readFileSync(path, 'utf8')).toContain('export WHICH=OLD');
    expect(real.env().WHICH).toBe('OLD');
    expect(runner.received).toEqual(['export WHICH=OLD\n']);

    expect(await service.syncRunner(runner)).toBeNull();
    expect(runner.received).toEqual(['export WHICH=OLD\n']);

    expect(String(failure)).toContain('正本も元へ戻した');

    // `ProfileRollbackFailedError` は書き戻しまで落ちたことだけを示す。広げると呼び出し側が状態を誤って読む。
    expect(failure).not.toBeInstanceOf(ProfileRollbackFailedError);

    breakCommit = false;
    const next = await service.apply('export WHICH=NEXT');
    expect(next.stored).toBe(true);
    expect(runner.received.at(-1)).toBe('export WHICH=NEXT\n');
  });

  it('正本を書き戻せなかったら、その事実を理由つきで投げる', async () => {
    const stores = createMemoryStores();
    const path = join(dir, 'profile.sh');
    const real = createProfileApplier({
      vessel: createProfileVessel({ path }),
      baseEnv: () => ({}),
    });
    const applier: ProfileApplier = {
      ...real,
      async prepare(script: string) {
        const prepared = await real.prepare(script);
        return {
          ...prepared,
          commit: async () => {
            throw new Error('器へ移せなかった');
          },
        };
      },
    };
    stores.profile.replaceAll = async () => {
      throw new Error('記憶ストアも落ちている');
    };
    const service = createProfileService({ stores, applier });

    const failure = await service.apply('export WHICH=NEW').then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(ProfileRollbackFailedError);
    expect(String(failure)).toMatch(/正本だけ新版のまま残っている/);
  });

  it('読めない本文で列が止まらない（次の更新は通る）', async () => {
    const stores = createMemoryStores();
    const service = createProfileService({
      stores,
      applier: fakeApplier((script) => {
        if (script.includes('broken')) throw new Error('評価が落ちた');
      }),
    });

    const bad = await service.apply('broken');
    expect(bad.stored).toBe(false);

    const good = await service.apply('export OK=1');
    expect(good.stored).toBe(true);
    expect((await stores.profile.list())[0]?.script).toBe('export OK=1\n');
  });
});

describe('デーモンの起動時', () => {
  it('効かせ直すだけで、保存し直さない（更新日時が動かない）', async () => {
    const stores = createMemoryStores();
    const path = join(dir, 'profile.sh');
    const applier = createProfileApplier({
      vessel: createProfileVessel({ path }),
      baseEnv: () => ({}),
    });
    const service = createProfileService({ stores, applier });

    await service.apply('export WHICH=KEEP');
    const saved = await stores.profile.list();

    const restored = createProfileApplier({
      vessel: createProfileVessel({ path: join(dir, 'restored.sh') }),
      baseEnv: () => ({}),
    });
    const next = createProfileService({ stores, applier: restored });
    const result = await next.restore();

    expect(result?.ok).toBe(true);
    expect(restored.env().WHICH).toBe('KEEP');
    expect(await stores.profile.list()).toEqual(saved);
  });

  it('置かれていなければ何もしない', async () => {
    const stores = createMemoryStores();
    const service = createProfileService({
      stores,
      applier: fakeApplier(),
    });
    expect(await service.restore()).toBeNull();
  });
});

describe('降ろし直し', () => {
  it('既に同じものが載っていれば触らない（再接続のたびに評価し直さない）', async () => {
    const stores = createMemoryStores();
    const runner = fakeRunner();
    const service = createProfileService({ stores, runners: registryOf([runner]) });

    await service.apply('export OK=1');
    expect(runner.received).toHaveLength(1);

    expect(await service.syncRunner(runner)).toBeNull();
    expect(runner.received).toHaveLength(1);
  });

  it('プロファイルが空で、指紋が読めなくても、「何も載っていない」と読まず、空を降ろす（#2508）', async () => {
    const stores = createMemoryStores();
    const runner = fakeRunner();
    const service = createProfileService({ stores, runners: registryOf([runner]) });

    await runner.setProfile('export FAKE_SECRET_VALUE_2508=1');
    const held = runner.profile.bind(runner);
    runner.received.length = 0;
    runner.profile = async () => {
      throw new Error('health unreadable (test)');
    };

    await service.syncRunner(runner);

    expect(runner.received).toEqual(['']);
    runner.profile = held;
    expect(await runner.profile()).toBeUndefined();
  });

  it('対照: 空で、読めて何も載っていなければ何もしない', async () => {
    const stores = createMemoryStores();
    const runner = fakeRunner();
    const service = createProfileService({ stores, runners: registryOf([runner]) });

    expect(await service.syncRunner(runner)).toBeNull();
    expect(runner.received).toEqual([]);
  });

  it('対照: 空で、読めて載っていれば空を降ろす', async () => {
    const stores = createMemoryStores();
    const runner = fakeRunner();
    const service = createProfileService({ stores, runners: registryOf([runner]) });

    await runner.setProfile('export FAKE_SECRET_VALUE_2508=1');
    runner.received.length = 0;
    await service.syncRunner(runner);
    expect(runner.received).toEqual(['']);
  });
});

describe('合成（composeProfileScript）', () => {
  const row = (name: string, script: string, scope: 'all' | 'app' | 'runner') => ({
    name,
    script,
    scope,
    updatedAt: '2026-10-03T00:00:00.000Z',
  });

  it('名前のコード単位順につなぐ（ロケールに依存しない。大文字は小文字より先）', () => {
    const rows = [
      row('b', 'export B=1\n', 'all'),
      row('B', 'export UP=1\n', 'all'),
      row('a', 'export A=1\n', 'all'),
    ];

    expect(composeProfileScript(rows, 'clone')).toBe('export UP=1\n\nexport A=1\n\nexport B=1\n');
    expect(composeProfileScript([...rows].reverse(), 'clone')).toBe(
      composeProfileScript(rows, 'clone'),
    );
  });

  it('対象に掛かる行だけをつなぐ。掛かる行が0なら空', () => {
    const rows = [
      row('a-app', 'export APP=1\n', 'app'),
      row('b-runner', 'export RUN=1\n', 'runner'),
      row('c-all', 'export ALL=1\n', 'all'),
    ];

    expect(composeProfileScript(rows, 'clone')).toBe('export APP=1\n\nexport ALL=1\n');
    expect(composeProfileScript(rows, 'runner')).toBe('export RUN=1\n\nexport ALL=1\n');
    expect(composeProfileScript(rows, 'all')).toBe(
      'export APP=1\n\nexport RUN=1\n\nexport ALL=1\n',
    );
    expect(composeProfileScript([row('r', 'export R=1\n', 'runner')], 'clone')).toBe('');
    expect(composeProfileScript([], 'runner')).toBe('');
  });

  it('1行だけなら本文そのまま（1本の時代と指紋が変わらない）。末尾の改行は整える', () => {
    expect(composeProfileScript([row('default', 'export A=1', 'all')], 'clone')).toBe(
      'export A=1\n',
    );
    expect(composedFingerprints([row('default', 'export A=1\n', 'all')])).toEqual({
      clone: { sha256: fingerprintOf('export A=1\n'), bytes: 11 },
      runner: { sha256: fingerprintOf('export A=1\n'), bytes: 11 },
    });
  });

  it('撒く先の掛かる側が0の指紋は欠ける', () => {
    expect(composedFingerprints([row('r', 'export A=1\n', 'runner')]).clone).toEqual({});
  });
});

describe('行の更新（set / remove / clearAll / apply）', () => {
  function setup() {
    const stores = createMemoryStores();
    const cloneReceived: string[] = [];
    const applier = fakeApplier((script) => {
      cloneReceived.push(script);
    });
    const runner = fakeRunner();
    const service = createProfileService({ stores, applier, runners: registryOf([runner]) });
    return { stores, cloneReceived, runner, service };
  }

  it('scope=runner: クローンは空を受け取り、runner は本文を受け取る', async () => {
    const { stores, cloneReceived, runner, service } = setup();

    const result = await service.set('rust', 'export ONLY_RUNNER=1', 'runner');

    expect(cloneReceived).toEqual(['']);
    expect(runner.received).toEqual(['export ONLY_RUNNER=1\n']);
    expect(await stores.profile.list()).toMatchObject([
      { name: 'rust', script: 'export ONLY_RUNNER=1\n', scope: 'runner' },
    ]);
    expect(result.composed).toEqual({
      clone: {},
      runner: { sha256: fingerprintOf('export ONLY_RUNNER=1\n'), bytes: 21 },
    });
  });

  it('scope=app: クローンは本文を受け取り、runner は空を受け取る', async () => {
    const { cloneReceived, runner, service } = setup();

    await service.set('only-app', 'export ONLY_APP=1', 'app');

    expect(cloneReceived).toEqual(['export ONLY_APP=1\n']);
    expect(runner.received).toEqual(['']);
  });

  it('既定は all（両方が本文を受け取る）', async () => {
    const { stores, cloneReceived, runner, service } = setup();

    await service.set('both', 'export BOTH=1');

    expect(cloneReceived).toEqual(['export BOTH=1\n']);
    expect(runner.received).toEqual(['export BOTH=1\n']);
    expect((await stores.profile.list())[0]?.scope).toBe('all');
  });

  it('scope を省くと既存の行の撒く先を保つ（本文だけ直して all へ戻らない）', async () => {
    const { stores, cloneReceived, runner, service } = setup();
    await service.set('a', 'export A=1', 'runner');
    cloneReceived.length = 0;
    runner.received.length = 0;

    await service.set('a', 'export A=2');

    expect((await stores.profile.list())[0]?.scope).toBe('runner');
    expect(cloneReceived).toEqual(['']);
    expect(runner.received).toEqual(['export A=2\n']);
  });

  it('複数行は名前の順につながって、掛かる側ごとに降りる', async () => {
    const { cloneReceived, runner, service } = setup();

    await service.set('b-shared', 'export B=1', 'all');
    await service.set('a-runner', 'export A=1', 'runner');

    expect(cloneReceived.at(-1)).toBe('export B=1\n');
    expect(runner.received.at(-1)).toBe('export A=1\n\nexport B=1\n');
  });

  it('all → runner へ変えると、本文が同じでもクローンから外れる', async () => {
    const { cloneReceived, runner, service } = setup();
    await service.set('same', 'export SAME=1', 'all');
    expect(cloneReceived.at(-1)).toBe('export SAME=1\n');

    await service.set('same', 'export SAME=1', 'runner');

    expect(cloneReceived.at(-1)).toBe('');
    expect(runner.received.at(-1)).toBe('export SAME=1\n');
  });

  it('all → app へ変えると、本文が同じでも runner から外れる', async () => {
    const { cloneReceived, runner, service } = setup();
    await service.set('same', 'export SAME=1', 'all');
    expect(await runner.profile()).toBeDefined();

    await service.set('same', 'export SAME=1', 'app');

    expect(await runner.profile()).toBeUndefined();
    expect(cloneReceived.at(-1)).toBe('export SAME=1\n');
  });

  it('remove: 1行だけが消え、他の行の合成が降り直す。最後の1行なら空が降りる', async () => {
    const { stores, cloneReceived, runner, service } = setup();
    await service.set('a', 'export A=1', 'all');
    await service.set('b', 'export B=1', 'runner');

    const first = await service.remove('a');

    expect(first.removed).toBe(true);
    expect((await stores.profile.list()).map((row) => row.name)).toEqual(['b']);
    expect(cloneReceived.at(-1)).toBe('');
    expect(runner.received.at(-1)).toBe('export B=1\n');

    await service.remove('b');
    expect(runner.received.at(-1)).toBe('');
    expect(await runner.profile()).toBeUndefined();
  });

  it('remove: 無い名前は何も変えず removed=false', async () => {
    const { stores, service } = setup();
    await service.set('a', 'export A=1', 'all');
    const before = await stores.profile.list();

    const result = await service.remove('zzz');

    expect(result.removed).toBe(false);
    expect(await stores.profile.list()).toEqual(before);
  });

  it('clearAll: 全行が消え、両側へ空が降りる', async () => {
    const { stores, cloneReceived, runner, service } = setup();
    await service.set('a', 'export A=1', 'all');
    await service.set('b', 'export B=1', 'runner');

    await service.clearAll();

    expect(await stores.profile.list()).toEqual([]);
    expect(cloneReceived.at(-1)).toBe('');
    expect(runner.received.at(-1)).toBe('');
  });

  it('apply（旧来の全文置換）: 全行が default 1行（撒く先 all）になる。空白だけなら全部外す', async () => {
    const { stores, cloneReceived, service } = setup();
    await service.set('a', 'export A=1', 'runner');
    await service.set('b', 'export B=1', 'app');

    await service.apply('export WHOLE=1');

    expect(await stores.profile.list()).toMatchObject([
      { name: 'default', script: 'export WHOLE=1\n', scope: 'all' },
    ]);
    expect(cloneReceived.at(-1)).toBe('export WHOLE=1\n');

    await service.apply('  \n');
    expect(await stores.profile.list()).toEqual([]);
  });

  it('空白だけの本文・不正な名前は置けない（投げる。何も変えない）', async () => {
    const { stores, service } = setup();

    await expect(service.set('a', '  \n', 'all')).rejects.toThrow('空の本文');
    await expect(service.set('../x', 'export A=1', 'all')).rejects.toThrow('名前の形が不正');
    expect(await stores.profile.list()).toEqual([]);
  });

  it('クローンへ反映できなかったら、行の集合ごと（本文・撒く先・更新日時）元へ戻る', async () => {
    const stores = createMemoryStores();
    await stores.profile.set('a', 'export A=1\n', 'runner');
    await stores.profile.set('b', 'export B=1\n', 'all');
    await stores.profile.replaceAll(
      (await stores.profile.list()).map((row) => ({
        ...row,
        updatedAt: '2000-01-01T00:00:00.000Z',
      })),
    );
    const before = await stores.profile.list();

    const failing: ProfileApplier = {
      ...fakeApplier(),
      async prepare() {
        return {
          ok: true,
          commit: async () => {
            throw new Error('commit failed (test)');
          },
          discard: async () => undefined,
        };
      },
    };
    const service = createProfileService({ stores, applier: failing });

    await expect(service.set('c', 'export C=1', 'app')).rejects.toThrow();
    await expect(service.remove('a')).rejects.toThrow();
    await expect(service.apply('export X=1')).rejects.toThrow();

    expect(await stores.profile.list()).toEqual(before);
  });

  it('apply の書き込みが途中（clear の後の set）で落ちても、前の集合へ戻る', async () => {
    const stores = createMemoryStores();
    await stores.profile.set('a', 'export A=1\n', 'runner');
    await stores.profile.set('b', 'export B=1\n', 'app');
    const before = await stores.profile.list();
    stores.profile.set = async () => {
      throw new Error('記憶ストアが一時的に落ちた');
    };
    const service = createProfileService({ stores, applier: fakeApplier() });

    await expect(service.apply('export X=1')).rejects.toThrow('記憶ストアが一時的に落ちた');

    expect(await stores.profile.list()).toEqual(before);
  });

  describe('restore / syncRunner', () => {
    it('restore: クローンに掛かる行だけを合成して効かせる。掛かる行が0なら空を効かせる', async () => {
      const stores = createMemoryStores();
      await stores.profile.set('a', 'export A=1\n', 'app');
      await stores.profile.set('b', 'export B=1\n', 'runner');
      const received: string[] = [];
      const service = createProfileService({
        stores,
        applier: fakeApplier((script) => {
          received.push(script);
        }),
      });

      await service.restore();
      expect(received).toEqual(['export A=1\n']);

      await stores.profile.remove('a');
      received.length = 0;
      await service.restore();
      expect(received).toEqual(['']);
    });

    it('restore: 何も置かれていなければ何もしない', async () => {
      const service = createProfileService({
        stores: createMemoryStores(),
        applier: fakeApplier(),
      });
      expect(await service.restore()).toBeNull();
    });

    it('syncRunner: runner に掛かる行が0（app だけ）で載っていれば、空を降ろす', async () => {
      const stores = createMemoryStores();
      const runner = fakeRunner();
      const service = createProfileService({ stores, runners: registryOf([runner]) });
      await stores.profile.set('a', 'export A=1\n', 'app');
      await runner.setProfile('export A=1\n');
      runner.received.length = 0;

      await service.syncRunner(runner);

      expect(runner.received).toEqual(['']);
      expect(await runner.profile()).toBeUndefined();
    });

    it('syncRunner: runner に掛かる行が0で、既に空なら何もしない', async () => {
      const stores = createMemoryStores();
      const runner = fakeRunner();
      const service = createProfileService({ stores, runners: registryOf([runner]) });
      await stores.profile.set('a', 'export A=1\n', 'app');

      expect(await service.syncRunner(runner)).toBeNull();
      expect(runner.received).toEqual([]);
    });

    it('syncRunner: runner に掛かる行を名前の順につないで降ろす。同じなら何もしない', async () => {
      const stores = createMemoryStores();
      const runner = fakeRunner();
      const service = createProfileService({ stores, runners: registryOf([runner]) });
      await stores.profile.set('b', 'export B=1\n', 'all');
      await stores.profile.set('a', 'export A=1\n', 'runner');
      await stores.profile.set('c', 'export C=1\n', 'app');

      await service.syncRunner(runner);
      expect(runner.received).toEqual(['export A=1\n\nexport B=1\n']);

      expect(await service.syncRunner(runner)).toBeNull();
      expect(runner.received).toHaveLength(1);
    });
  });

  it('profileScopeAppliesTo: 未設定は all と同じ', () => {
    expect(profileScopeAppliesTo(undefined, 'clone')).toBe(true);
    expect(profileScopeAppliesTo(undefined, 'runner')).toBe(true);
    expect(profileScopeAppliesTo('app', 'runner')).toBe(false);
    expect(profileScopeAppliesTo('runner', 'clone')).toBe(false);
  });
});
