import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createProfileApplier,
  createProfileVessel,
  fingerprintOf,
  type ProfileApplier,
} from './profile.js';
import { createProfileService } from './profile-service.js';
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
  dir = mkdtempSync(join(tmpdir(), 'alteroid-profile-service-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
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
    write: (script: string) => store.write(script),
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

    // ① 正本は旧版に戻っている（更新日時は動くが、本文は直前の版）
    expect((await stores.profile.read())?.script).toBe(before?.script);
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

    // ⑤ 列は止まっていない
    breakCommit = false;
    const next = await service.apply('export WHICH=NEXT');
    expect(next.stored).toBe(true);
    expect(runner.received.at(-1)).toBe('export WHICH=NEXT\n');
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
});
