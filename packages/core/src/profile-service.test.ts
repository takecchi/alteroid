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
  createProfileService,
  ProfileRollbackFailedError,
  profileScopeAppliesTo,
} from './profile-service.js';
import type { RunnerClient, RunnerProfileFingerprint } from './runner-protocol.js';
import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';

/**
 * 実行環境プロファイルの**同時更新**。
 *
 * 更新は3段ある（クローンの器へ commit → 記憶ストアへ保存 → runner へ配布）。
 * 直列化しないと、2つの更新が重なったときに層ごとに違う本文が残る:
 *
 *     A が① → B が①②③ → A が②③   ⇒ クローン=B、ストア/runner=A
 *
 * どちらの呼び出しも成功を返すので、**指紋を見ても食い違いの理由が分からない**。
 * しかもデーモンを再起動するとストアの A へ突然戻る。鍵の更新なら「同じ時点から
 * 仕事ごとに違う資格情報を使う」状態になる。
 *
 * クローンに `profile_write` を渡した以上、これは現実に起きる — クローンは自律
 * ターン（時間起点・発意）からも動くので、人間が `alteroid profile edit` している
 * 最中に書きうる。
 */

let dir: string;

beforeEach(() => {
  dir = makeTempDirSync('alteroid-profile-service-');
});

/** 器に置かれた本文をそのまま覚える runner。 */
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
 * **重なりそのものを踏み抜く仕掛け。**
 *
 * 最終状態だけを見るテストにしないこと。更新の3段が混ざるかどうかは処理順に依るので、
 * 直列化していない実装でもたまたま揃って通る（この検証を書いたとき実際に通った）。
 * だから「1更新の全段が終わる前に次が始まったか」を直接見る。
 *
 * 更新中とみなす区間は、評価に入った時点から runner へ配り終えるまで。
 */
function tripwire(stores: Stores, runner: RunnerClient & { received: string[] }) {
  const violations: string[] = [];
  let busy = false;

  const store = stores.profile;
  stores.profile = {
    read: async () => {
      if (busy) violations.push('更新中に別の操作がストアを読んだ');
      return store.read();
    },
    write: (script: string, scope) => store.write(script, scope),
    revert: (previous) => store.revert(previous),
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
    /** 評価に入ったことを知らせる（applier のふりをする側から呼ぶ）。 */
    enter() {
      if (busy) violations.push('前の更新が終わる前に次の更新が始まった');
      busy = true;
    },
  };
}

/**
 * 器のふりをする applier。**評価の成否だけを差し替える。**
 *
 * `prepare` を本体にしてあるのは、本物がそうだからである（評価と反映を分けないと、
 * 正本へ書けなかった更新がクローンにだけ残る）。
 */
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

    // 1本目の評価を止めて、2本目を確実に重ねる。
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
    // 1本目が評価に入るのを待ってから2本目を出す（**重ねるのが目的**）。
    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = service.apply('export WHICH=B');
    release?.();
    await Promise.all([first, second]);

    const expected = 'export WHICH=B\n';
    // ① 記憶ストア（デーモンを作り直したときに戻ってくる本文）
    expect((await stores.profile.read())?.script).toBe(expected);
    // ② クローンの器（これから起こすクローンの子が読む本文）
    expect(readFileSync(path, 'utf8')).toContain('export WHICH=B');
    expect(vessel.fingerprint()?.sha256).toBe(fingerprintOf(expected));
    // ③ runner（マネージャーと作業者が読む本文）
    expect(runner.received.at(-1)).toBe(expected);

    // **混ざっていないこと自体も見る。** 最終状態だけを見ると、たまたま順序が
    // 揃っただけの実装が通ってしまう（ログインの経路で同じ失敗をしている）。
    expect(runner.received).toEqual(['export WHICH=A\n', 'export WHICH=B\n']);
    expect(wire.violations).toEqual([]);
  });

  it('再接続時の降ろし直しも同じ列に入る（更新の途中に割り込まない）', async () => {
    // **runner へ書く2人目である。** 更新の最中に走ると、保存前の本文を読んで
    // 新しい本文の上に置きうる。
    //
    // ここで見るのは最終状態ではなく**重なったかどうか**そのものにする。最終状態は
    // 処理順に依るので、たまたま揃っただけの実装が通ってしまう（ログインの経路で
    // 実際にそれをやって、上書きを見逃した）。
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
    // 更新の最中に runner が名乗り直す。
    const sync = service.syncRunner(runner);
    release?.();
    await Promise.all([update, sync]);

    expect(wire.violations).toEqual([]);
    expect((await stores.profile.read())?.script).toBe('export WHICH=NEW\n');
    expect(runner.received.at(-1)).toBe('export WHICH=NEW\n');
  });

  it('正本へ書けなかったら、クローンにも効かせない（旧版で揃ったまま）', async () => {
    // **一番たちの悪い分裂である。** 保存できていない ＝ 誰も成功と言っていない
    // 更新を、これから起こすクローンの子だけが使う。しかも再起動するとストアの
    // 古い値へ戻るので、後から見ても理由が分からない。
    const stores = createMemoryStores();
    const runner = fakeRunner();
    const path = join(dir, 'profile.sh');
    const vessel = createProfileVessel({ path });
    const applier = createProfileApplier({ vessel, baseEnv: () => ({}) });
    const service = createProfileService({ stores, applier, runners: registryOf([runner]) });

    await service.apply('export WHICH=OLD');
    const before = await stores.profile.read();

    // 正本（記憶ストア）だけが落ちる。評価は通る本文である。
    const write = stores.profile.write.bind(stores.profile);
    stores.profile.write = async () => {
      throw new Error('記憶ストアが一時的に落ちた');
    };

    await expect(service.apply('export WHICH=NEW')).rejects.toThrow('記憶ストア');

    stores.profile.write = write;

    // ① 正本は旧版のまま（更新日時ごと動いていない）
    expect(await stores.profile.read()).toEqual(before);
    // ② クローンの器も旧版のまま（本文・env・指紋の3つとも）
    expect(readFileSync(path, 'utf8')).toContain('export WHICH=OLD');
    expect(applier.env().WHICH).toBe('OLD');
    expect(vessel.fingerprint()?.sha256).toBe(fingerprintOf('export WHICH=OLD\n'));
    // ③ runner にも新版を配っていない
    expect(runner.received).toEqual(['export WHICH=OLD\n']);
  });

  it('クローンへ反映できなかったら、正本も元へ戻す', async () => {
    // **失敗を返したのに、どこか1層だけ新版、を残さない。** 残すと次に runner が
    // 名乗った時点で `syncRunner` がそれを配り、今度は「クローンだけ旧版」という
    // 別の分裂になる。器の不調が続いていれば、起こし直しても収束しない。
    const stores = createMemoryStores();
    const runner = fakeRunner();
    const path = join(dir, 'profile.sh');
    const vessel = createProfileVessel({ path });
    const real = createProfileApplier({ vessel, baseEnv: () => ({}) });

    // 反映（器への rename）だけが落ちる。評価も保存も通る本文である。
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
    const before = await stores.profile.read();

    breakCommit = true;
    // **文言ではなく状態を先に見る。** 文言を先に確かめると、補償を外したときに
    // 「別のエラーで落ちた」としか分からず、何が壊れているのかが出てこない。
    const failure = await service.apply('export WHICH=NEW').then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).not.toBeNull();

    // ① 正本は**まるごと**旧版に戻っている。
    //
    // **本文だけを見ない。** 取り消した更新で `updatedAt` が進むと、成功して
    // いない更新が「最後に本文を変えた時刻」として `profile status` に出る
    // （デーモンを起こすたびに動いていたのと同じ意味の壊れ方である）。
    expect(await stores.profile.read()).toEqual(before);
    // ② クローンの器も旧版のまま
    expect(readFileSync(path, 'utf8')).toContain('export WHICH=OLD');
    expect(real.env().WHICH).toBe('OLD');
    // ③ runner にも新版を配っていない
    expect(runner.received).toEqual(['export WHICH=OLD\n']);

    // ④ **確定していない版を、後から降ろし直しで配らない。**
    expect(await service.syncRunner(runner)).toBeNull();
    expect(runner.received).toEqual(['export WHICH=OLD\n']);

    // ⑥ 何が起きたかが理由として出ている（人間が手で直せるように）
    expect(String(failure)).toContain('正本も元へ戻した');

    // ⑦ **書き戻しが成功した場合は `ProfileRollbackFailedError` ではない**
    // （issue #2163。この型は「書き戻しまで落ちた」ことだけを示す——書き戻し
    // 自体が効いた今回のケースまで広げると、呼び出し側が状態を誤って読む）。
    expect(failure).not.toBeInstanceOf(ProfileRollbackFailedError);

    // ⑤ 列は止まっていない
    breakCommit = false;
    const next = await service.apply('export WHICH=NEXT');
    expect(next.stored).toBe(true);
    expect(runner.received.at(-1)).toBe('export WHICH=NEXT\n');
  });

  it('正本を書き戻せなかったら、その事実を理由つきで投げる', async () => {
    // ここまで来ると正本＝新版・クローン＝旧版が残る。**黙って握り潰さない。**
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
    stores.profile.revert = async () => {
      throw new Error('記憶ストアも落ちている');
    };
    const service = createProfileService({ stores, applier });

    // **issue #2163: 型の付いた例外で見分けられること。** 呼び出し側
    // （`PUT /profile` の `app.ts`・`profile_write` の `tools.ts`）はこの型を
    // `instanceof` で捕まえ、日誌の決定の行を状態どおりに書き換える。
    // **`message` は1文字も変えていない**——文言そのものは反映と書き戻しの
    // 両方が落ちたことを既に言っているので、変える理由が無い。
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
    expect((await stores.profile.read())?.script).toBe('export OK=1\n');
  });
});

describe('デーモンの起動時', () => {
  it('効かせ直すだけで、保存し直さない（更新日時が動かない）', async () => {
    // ここが動くと、`profile status` / `GET /profile` の「更新」が
    // 「最後にデーモンを起こした時刻」になる。本文を一度も変えていないのに
    // 監査情報が消えるので、後から「いつ誰が変えたのか」を追えなくなる。
    const stores = createMemoryStores();
    const path = join(dir, 'profile.sh');
    const applier = createProfileApplier({
      vessel: createProfileVessel({ path }),
      baseEnv: () => ({}),
    });
    const service = createProfileService({ stores, applier });

    await service.apply('export WHICH=KEEP');
    const saved = await stores.profile.read();

    // 器を作り直した想定で、同じ本文を効かせ直す。
    const restored = createProfileApplier({
      vessel: createProfileVessel({ path: join(dir, 'restored.sh') }),
      baseEnv: () => ({}),
    });
    const next = createProfileService({ stores, applier: restored });
    const result = await next.restore();

    expect(result?.ok).toBe(true);
    // クローンには効いている
    expect(restored.env().WHICH).toBe('KEEP');
    // **正本は1文字も動いていない**
    expect(await stores.profile.read()).toEqual(saved);
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

    // runner には外したはずのプロファイルが載っている。正本は空。
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

/**
 * 撒く先（scope。2026-10-03。オーナー指示「env-profileを環境変数と同じように指定
 * できるようにして欲しい」「デフォルトは両方です」）。
 *
 * **測るのは「届かない側へ本文が降りないこと」だけではない。** all → runner のように
 * 撒く先を**狭めた**とき、本文が同じでも、外れた側から**確実に外れる**こと。
 * 「届かない側は触らない」実装だと、前の本文（鍵を含みうる）がクローンに残り続け、
 * 本文だけを見るテストは全部緑になる。
 */
describe('撒く先（scope）', () => {
  /** クローンの器へ効かせた本文を順に覚える applier。 */
  function recordingApplier() {
    const cloneReceived: string[] = [];
    const applier = fakeApplier((script) => {
      cloneReceived.push(script);
    });
    return { applier, cloneReceived };
  }

  it('scope=runner: クローンは空を受け取り、runner は本文を受け取る', async () => {
    const stores = createMemoryStores();
    const { applier, cloneReceived } = recordingApplier();
    const runner = fakeRunner();
    const service = createProfileService({ stores, applier, runners: registryOf([runner]) });

    const result = await service.apply('export ONLY_RUNNER=1', 'runner');

    expect(cloneReceived).toEqual(['']);
    expect(runner.received).toEqual(['export ONLY_RUNNER=1\n']);
    // 正本は本文をそのまま持つ（クローンが profile_read で読める）。
    expect(await stores.profile.read()).toMatchObject({
      script: 'export ONLY_RUNNER=1\n',
      scope: 'runner',
    });
    expect(result.scope).toBe('runner');
    // 指紋は正本の本文から取る（届かない側があっても消えない）。
    expect(result.sha256).toBe(fingerprintOf('export ONLY_RUNNER=1\n'));
  });

  it('scope=app: クローンは本文を受け取り、runner は空を受け取る', async () => {
    const stores = createMemoryStores();
    const { applier, cloneReceived } = recordingApplier();
    const runner = fakeRunner();
    const service = createProfileService({ stores, applier, runners: registryOf([runner]) });

    await service.apply('export ONLY_APP=1', 'app');

    expect(cloneReceived).toEqual(['export ONLY_APP=1\n']);
    expect(runner.received).toEqual(['']);
  });

  it('既定は all（両方が本文を受け取る）', async () => {
    const stores = createMemoryStores();
    const { applier, cloneReceived } = recordingApplier();
    const runner = fakeRunner();
    const service = createProfileService({ stores, applier, runners: registryOf([runner]) });

    const result = await service.apply('export BOTH=1');

    expect(cloneReceived).toEqual(['export BOTH=1\n']);
    expect(runner.received).toEqual(['export BOTH=1\n']);
    expect(result.scope).toBe('all');
  });

  it('scope を省くと既存の撒く先を保つ（本文だけ直して all へ戻らない）', async () => {
    const stores = createMemoryStores();
    const { applier, cloneReceived } = recordingApplier();
    const runner = fakeRunner();
    const service = createProfileService({ stores, applier, runners: registryOf([runner]) });

    await service.apply('export A=1', 'runner');
    cloneReceived.length = 0;
    runner.received.length = 0;
    const result = await service.apply('export A=2');

    expect(result.scope).toBe('runner');
    expect((await stores.profile.read())?.scope).toBe('runner');
    expect(cloneReceived).toEqual(['']);
    expect(runner.received).toEqual(['export A=2\n']);
  });

  it('all → runner へ変えると、本文が同じでもクローンから外れる', async () => {
    const stores = createMemoryStores();
    const { applier, cloneReceived } = recordingApplier();
    const runner = fakeRunner();
    const service = createProfileService({ stores, applier, runners: registryOf([runner]) });

    await service.apply('export SAME=1', 'all');
    expect(cloneReceived.at(-1)).toBe('export SAME=1\n');

    await service.apply('export SAME=1', 'runner');

    // クローンには空が効いた（外れた）。runner は本文のまま。
    expect(cloneReceived.at(-1)).toBe('');
    expect(runner.received.at(-1)).toBe('export SAME=1\n');
  });

  it('all → app へ変えると、本文が同じでも runner から外れる', async () => {
    const stores = createMemoryStores();
    const { applier, cloneReceived } = recordingApplier();
    const runner = fakeRunner();
    const service = createProfileService({ stores, applier, runners: registryOf([runner]) });

    await service.apply('export SAME=1', 'all');
    expect(await runner.profile()).toBeDefined();

    await service.apply('export SAME=1', 'app');

    expect(await runner.profile()).toBeUndefined();
    expect(cloneReceived.at(-1)).toBe('export SAME=1\n');
  });

  it('外す（空）と撒く先も消える（次に置くものへ古い撒く先が効かない）', async () => {
    const stores = createMemoryStores();
    const service = createProfileService({ stores, runners: registryOf([fakeRunner()]) });

    await service.apply('export A=1', 'runner');
    await service.apply('');
    expect(await stores.profile.read()).toBeNull();

    const next = await service.apply('export B=1');
    expect(next.scope).toBe('all');
  });

  it('クローンへ反映できなかったら、正本は本文も撒く先も元へ戻す', async () => {
    const stores = createMemoryStores();
    const service0 = createProfileService({ stores });
    await service0.apply('export OLD=1', 'app');
    const before = await stores.profile.read();

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

    await expect(service.apply('export NEW=1', 'runner')).rejects.toThrow();
    expect(await stores.profile.read()).toEqual(before);
  });

  describe('restore / syncRunner', () => {
    it('restore: scope=runner なら、起動時もクローンへは空を効かせる', async () => {
      const stores = createMemoryStores();
      await stores.profile.write('export R=1\n', 'runner');
      const { applier, cloneReceived } = recordingApplier();
      const service = createProfileService({ stores, applier });

      await service.restore();

      expect(cloneReceived).toEqual(['']);
    });

    it('restore: scope=app / all ならクローンへ本文を効かせる', async () => {
      for (const scope of ['app', 'all'] as const) {
        const stores = createMemoryStores();
        await stores.profile.write('export R=1\n', scope);
        const { applier, cloneReceived } = recordingApplier();
        await createProfileService({ stores, applier }).restore();
        expect(cloneReceived).toEqual(['export R=1\n']);
      }
    });

    it('syncRunner: scope=app で runner に載っていれば、空を降ろす', async () => {
      const stores = createMemoryStores();
      const runner = fakeRunner();
      const service = createProfileService({ stores, runners: registryOf([runner]) });
      await stores.profile.write('export A=1\n', 'app');
      await runner.setProfile('export A=1\n');
      runner.received.length = 0;

      await service.syncRunner(runner);

      expect(runner.received).toEqual(['']);
      expect(await runner.profile()).toBeUndefined();
    });

    it('syncRunner: scope=app で runner が既に空なら何もしない', async () => {
      const stores = createMemoryStores();
      const runner = fakeRunner();
      const service = createProfileService({ stores, runners: registryOf([runner]) });
      await stores.profile.write('export A=1\n', 'app');

      expect(await service.syncRunner(runner)).toBeNull();
      expect(runner.received).toEqual([]);
    });

    it('syncRunner: scope=runner なら本文を降ろす', async () => {
      const stores = createMemoryStores();
      const runner = fakeRunner();
      const service = createProfileService({ stores, runners: registryOf([runner]) });
      await stores.profile.write('export A=1\n', 'runner');

      await service.syncRunner(runner);

      expect(runner.received).toEqual(['export A=1\n']);
    });
  });

  it('profileScopeAppliesTo: 未設定は all と同じ', () => {
    expect(profileScopeAppliesTo(undefined, 'clone')).toBe(true);
    expect(profileScopeAppliesTo(undefined, 'runner')).toBe(true);
    expect(profileScopeAppliesTo('app', 'runner')).toBe(false);
    expect(profileScopeAppliesTo('runner', 'clone')).toBe(false);
  });
});
