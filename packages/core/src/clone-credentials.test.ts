import { describe, it, expect } from 'vitest';
import { ALWAYS_REDELIVER, createClone } from './clone.js';
import { createLocalRunner } from './runner-local.js';
import { createRunnerRegistry } from './runner-protocol.js';
import { createMemoryStores } from './testing.js';
import { fakeSdk, waitFor } from './clone-test-harness.js';

describe('credentials（SDK 子プロセスへ重ねる鍵の現在値）', () => {
  let postSeq = 0;

  function cloneWithCredentials(input: {
    credentials?: () => Record<string, string>;
    profileEnv?: Record<string, string>;
    env?: NodeJS.ProcessEnv;
  }) {
    const { fn, calls } = fakeSdk();
    const clone = createClone({
      redeliveryGate: ALWAYS_REDELIVER,
      stores: createMemoryStores(),
      queryFn: fn,
      env: input.env ?? {},
      ...(input.credentials === undefined ? {} : { credentials: input.credentials }),
      ...(input.profileEnv === undefined
        ? {}
        : {
            profile: {
              env: () => input.profileEnv as Record<string, string>,
            } as unknown as Parameters<typeof createClone>[0]['profile'],
          }),
      runners: createRunnerRegistry([
        createLocalRunner({ workspacePath: '/work', queryFn: fakeSdk().fn, env: {} }),
      ]),
    });
    return { clone, calls };
  }

  it('渡さなければ、env とプロファイルだけ（既定の構成の挙動を変えない）', async () => {
    const { clone, calls } = cloneWithCredentials({ env: { FROM_ENV: 'yes' } });
    clone.post({
      type: 'human_message',
      id: `evt-cred-${String(++postSeq)}`,
      at: new Date().toISOString(),
      text: 'こんにちは',
      conversationId: 'conv-1',
    });
    await waitFor(() => calls.length > 0, 'セッションが開くこと');
    clone.stop();

    expect(calls[0]?.options.env?.FROM_ENV).toBe('yes');
    expect(calls[0]?.options.env).not.toHaveProperty('CLAUDE_CODE_OAUTH_TOKEN');
  });

  it('渡した鍵が、凍った env に勝って子へ届く', async () => {
    const { clone, calls } = cloneWithCredentials({
      env: { CLAUDE_CODE_OAUTH_TOKEN: 'frozen-at-startup' },
      credentials: () => ({ CLAUDE_CODE_OAUTH_TOKEN: 'rotated-now' }),
    });
    clone.post({
      type: 'human_message',
      id: `evt-cred-${String(++postSeq)}`,
      at: new Date().toISOString(),
      text: 'こんにちは',
      conversationId: 'conv-1',
    });
    await waitFor(() => calls.length > 0, 'セッションが開くこと');
    clone.stop();

    // **凍った env に勝つ。** 順番を逆にすると鍵が回らない（`runner.ts` と同じ規則）。
    expect(calls[0]?.options.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe('rotated-now');
  });

  it('セッションを起こすたびに読み直す（値を持たず関数を持つ理由）', async () => {
    let current = 'first';
    const { clone, calls } = cloneWithCredentials({
      credentials: () => ({ CLAUDE_CODE_OAUTH_TOKEN: current }),
    });
    clone.post({
      type: 'human_message',
      id: `evt-cred-${String(++postSeq)}`,
      at: new Date().toISOString(),
      text: 'こんにちは',
      conversationId: 'conv-1',
    });
    await waitFor(() => calls.length > 0, '1本目のセッションが開くこと');
    expect(calls[0]?.options.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe('first');

    // **走っているセッションには届かない**（env は起動時に凍る）。届くのは
    // 次に起こすセッションからである。
    current = 'second';
    expect(calls[0]?.options.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe('first');
    clone.stop();
  });

  it('⚠️ プロファイルが同じ名前を宣言していると、鍵が上書きされる', async () => {
    // **これは塞いでいない挙動を測る歯である。** 重ね順は `runner.ts` と揃えて
    // あり（プロファイルが鍵より後）、動かすと `GH_TOKEN` のほうが壊れる。
    // 塞ぐのは検出のほう（`credentialNamesShadowedByProfile`）。
    //
    // **測っておく理由は、順序を「直した」つもりで動かす人を止めるためである。**
    // ここが赤くなったら、それは規則が変わったということである。
    const { clone, calls } = cloneWithCredentials({
      credentials: () => ({ CLAUDE_CODE_OAUTH_TOKEN: 'rotated-now' }),
      profileEnv: { CLAUDE_CODE_OAUTH_TOKEN: 'declared-in-profile' },
    });
    clone.post({
      type: 'human_message',
      id: `evt-cred-${String(++postSeq)}`,
      at: new Date().toISOString(),
      text: 'こんにちは',
      conversationId: 'conv-1',
    });
    await waitFor(() => calls.length > 0, 'セッションが開くこと');
    clone.stop();

    expect(calls[0]?.options.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe('declared-in-profile');
  });
});

/**
 * 正本（`CredentialService`）をクローンへ通す口（人間の決定 2026-09-12、
 * 「梯子を1本に統一する」——Issue #865 の恒久策）。
 *
 * **ここが固定するのは、マネージャー側（`credential-service.test.ts` の
 * `resolveCredentialRows`）と同じ優先順位が、クローンの子プロセスへ届く
 * env にも同じ形で現れること**である。両方が同じ関数を通るので、この節と
 * あちらの節は同じ主張を別の観測点（子プロセスへ実際に渡る env）から測る。
 */
describe('credentialService（正本を同期で覗いて重ねる。#865）', () => {
  let postSeq2 = 0;

  function cloneWithVault(input: {
    vault?: readonly { name: string; value: string; updatedAt: string }[];
    env?: NodeJS.ProcessEnv;
    credentials?: () => Record<string, string>;
    profileEnv?: Record<string, string>;
  }) {
    const { fn, calls } = fakeSdk();
    const fakeCredentialService = {
      vaultSnapshot: () => input.vault ?? [],
    } as unknown as Parameters<typeof createClone>[0]['credentialService'];
    const clone = createClone({
      redeliveryGate: ALWAYS_REDELIVER,
      stores: createMemoryStores(),
      queryFn: fn,
      env: input.env ?? {},
      credentialService: fakeCredentialService,
      ...(input.credentials === undefined ? {} : { credentials: input.credentials }),
      ...(input.profileEnv === undefined
        ? {}
        : {
            profile: {
              env: () => input.profileEnv as Record<string, string>,
            } as unknown as Parameters<typeof createClone>[0]['profile'],
          }),
      runners: createRunnerRegistry([
        createLocalRunner({ workspacePath: '/work', queryFn: fakeSdk().fn, env: {} }),
      ]),
    });
    return { clone, calls };
  }

  function say(clone: ReturnType<typeof createClone>): void {
    clone.post({
      type: 'human_message',
      id: `evt-vault-${String(++postSeq2)}`,
      at: new Date().toISOString(),
      text: 'こんにちは',
      conversationId: 'conv-1',
    });
  }

  it('credentialService を渡さなければ、既定の構成の挙動を変えない', async () => {
    const { fn, calls } = fakeSdk();
    // **意図して `credentialService` を渡さない。** cloneWithVault は必ず渡すので
    // ここだけ直接 createClone を呼ぶ。
    const clone = createClone({
      redeliveryGate: ALWAYS_REDELIVER,
      stores: createMemoryStores(),
      queryFn: fn,
      env: { GH_TOKEN: 'from-container-env' },
      runners: createRunnerRegistry([
        createLocalRunner({ workspacePath: '/work', queryFn: fakeSdk().fn, env: {} }),
      ]),
    });
    say(clone);
    await waitFor(() => calls.length > 0, 'セッションが開くこと');
    clone.stop();

    expect(calls[0]?.options.env?.GH_TOKEN).toBe('from-container-env');
  });

  it('正本にしか無い GH_TOKEN も、クローンへ届く（以前は0件だった。梯子を1本に統一した副作用）', async () => {
    const { clone, calls } = cloneWithVault({
      vault: [{ name: 'GH_TOKEN', value: 'from-vault', updatedAt: '2026-09-12T00:00:00.000Z' }],
    });
    say(clone);
    await waitFor(() => calls.length > 0, 'セッションが開くこと');
    clone.stop();

    expect(calls[0]?.options.env?.GH_TOKEN).toBe('from-vault');
  });

  it('器の env が非空なら、正本より器の env が勝つ（GitHub の名前だけ）', async () => {
    const { clone, calls } = cloneWithVault({
      vault: [{ name: 'GH_TOKEN', value: 'from-vault', updatedAt: '2026-09-12T00:00:00.000Z' }],
      env: { GH_TOKEN: 'from-container-env' },
    });
    say(clone);
    await waitFor(() => calls.length > 0, 'セッションが開くこと');
    clone.stop();

    expect(calls[0]?.options.env?.GH_TOKEN).toBe('from-container-env');
  });

  it('🔴 器の env が空文字なら、正本が勝つ（空は「置かれていない」と同じ）', async () => {
    const { clone, calls } = cloneWithVault({
      vault: [{ name: 'GH_TOKEN', value: 'from-vault', updatedAt: '2026-09-12T00:00:00.000Z' }],
      env: { GH_TOKEN: '' },
    });
    say(clone);
    await waitFor(() => calls.length > 0, 'セッションが開くこと');
    clone.stop();

    expect(calls[0]?.options.env?.GH_TOKEN).toBe('from-vault');
  });

  it('🔴 ROTATABLE_CREDENTIAL_KEYS に無い任意の名前は、器の env が在っても正本が勝つ', async () => {
    const { clone, calls } = cloneWithVault({
      vault: [{ name: 'NPM_TOKEN', value: 'from-vault', updatedAt: '2026-09-12T00:00:00.000Z' }],
      env: { NPM_TOKEN: 'from-container-env' },
    });
    say(clone);
    await waitFor(() => calls.length > 0, 'セッションが開くこと');
    clone.stop();

    expect(calls[0]?.options.env?.NPM_TOKEN).toBe('from-vault');
  });

  it('🔴 CLAUDE_CODE_OAUTH_TOKEN はこの重ねの対象外——Anthropic のプールの鍵が最後まで勝つ', async () => {
    // **正本にも同名の行が在る想定**（正規の口では作れないが、`vaultSnapshot` は
    // 直接差し込めるので、対象外であることをここで測る）。プールの `credentials`
    // が最後に重なるので、正本にも器の env にも引きずられずプールの値が届く。
    const { clone, calls } = cloneWithVault({
      vault: [
        {
          name: 'CLAUDE_CODE_OAUTH_TOKEN',
          value: 'from-vault',
          updatedAt: '2026-09-12T00:00:00.000Z',
        },
      ],
      env: { CLAUDE_CODE_OAUTH_TOKEN: 'frozen-at-startup' },
      credentials: () => ({ CLAUDE_CODE_OAUTH_TOKEN: 'rotated-now' }),
    });
    say(clone);
    await waitFor(() => calls.length > 0, 'セッションが開くこと');
    clone.stop();

    expect(calls[0]?.options.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe('rotated-now');
  });

  it('正本の写しがまだ何も無い（vaultSnapshot が空を返す）ときも、器の env はそのまま届く', async () => {
    // **起動直後の窓の再現。** `vault` を渡さない ＝ `vaultSnapshot()` が `[]`。
    const { clone, calls } = cloneWithVault({ env: { GH_TOKEN: 'from-container-env' } });
    say(clone);
    await waitFor(() => calls.length > 0, 'セッションが開くこと');
    clone.stop();

    expect(calls[0]?.options.env?.GH_TOKEN).toBe('from-container-env');
  });

  /**
   * **重ね順そのものを測る。** 正本は「env の後・プロファイルの前」に重ねる
   * 約束（`#childEnv()` のdoc）——ここが崩れると、プロファイルが同じ名前を
   * 宣言していても正本に上書きされ、`credentialNamesShadowedByProfile` が
   * 検出できる形（人間が明示的に書いたほうが勝つ）が壊れる。
   */
  it('プロファイルが同じ名前を宣言していれば、正本より後で重なってプロファイルが勝つ', async () => {
    const { clone, calls } = cloneWithVault({
      vault: [{ name: 'GH_TOKEN', value: 'from-vault', updatedAt: '2026-09-12T00:00:00.000Z' }],
      profileEnv: { GH_TOKEN: 'declared-in-profile' },
    });
    say(clone);
    await waitFor(() => calls.length > 0, 'セッションが開くこと');
    clone.stop();

    expect(calls[0]?.options.env?.GH_TOKEN).toBe('declared-in-profile');
  });
});

/**
 * SDK 子プロセス（`Bash` / MCP / 作業者を含む）へ渡さない鍵（Issue #1495 ①）。
 *
 * **ここが固定するのは4つ** — (1) 渡さなければ何も伏せないこと（既定の構成の
 * 挙動を変えない）、(2) 伏せた鍵は `env` に在っても子へ渡る env から落ちること、
 * (3) 伏せない鍵（記憶ストアの鍵）はそのまま残ること、(4) 正本や
 * プロファイルが同じ名前を重ねてきても**最後に落ちて生き残らない**こと——
 * 記憶ストアの鍵（`GH_TOKEN` 等）は「プロファイルが明示的に宣言したほうが
 * 勝つ」（直上の `credentials` 節）が、ここは `#childEnv()` の最後で落ちるので
 * 同じ抜け道が無い。daemon 側の配線（`AUTH_WITHHELD_ENV_KEYS` が実際に
 * `createClone` へ届くこと）は `apps/daemon/src/index.test.ts` が固定する。
 */
describe('withheldEnvKeys（SDK 子プロセスへ渡さない鍵。Issue #1495 ①）', () => {
  let postSeq3 = 0;

  function cloneWithWithheld(input: {
    env?: NodeJS.ProcessEnv;
    withheldEnvKeys?: readonly string[];
    credentials?: () => Record<string, string>;
    profileEnv?: Record<string, string>;
  }) {
    const { fn, calls } = fakeSdk();
    const clone = createClone({
      redeliveryGate: ALWAYS_REDELIVER,
      stores: createMemoryStores(),
      queryFn: fn,
      env: input.env ?? {},
      ...(input.withheldEnvKeys === undefined ? {} : { withheldEnvKeys: input.withheldEnvKeys }),
      ...(input.credentials === undefined ? {} : { credentials: input.credentials }),
      ...(input.profileEnv === undefined
        ? {}
        : {
            profile: {
              env: () => input.profileEnv as Record<string, string>,
            } as unknown as Parameters<typeof createClone>[0]['profile'],
          }),
      runners: createRunnerRegistry([
        createLocalRunner({ workspacePath: '/work', queryFn: fakeSdk().fn, env: {} }),
      ]),
    });
    return { clone, calls };
  }

  function say(clone: ReturnType<typeof createClone>): void {
    clone.post({
      type: 'human_message',
      id: `evt-withheld-${String(++postSeq3)}`,
      at: new Date().toISOString(),
      text: 'こんにちは',
      conversationId: 'conv-1',
    });
  }

  it('渡さなければ何も伏せない（既定の構成の挙動を変えない）', async () => {
    const { clone, calls } = cloneWithWithheld({
      env: { ALTEROID_GOOGLE_CLIENT_SECRET: 'leaked-if-no-withhold' },
    });
    say(clone);
    await waitFor(() => calls.length > 0, 'セッションが開くこと');
    clone.stop();

    expect(calls[0]?.options.env?.ALTEROID_GOOGLE_CLIENT_SECRET).toBe('leaked-if-no-withhold');
  });

  it('伏せた鍵は、env に在っても SDK へ渡る env から落ちる', async () => {
    const sourceEnv = { ALTEROID_GOOGLE_CLIENT_SECRET: 'super-secret' };
    const { clone, calls } = cloneWithWithheld({
      env: sourceEnv,
      withheldEnvKeys: ['ALTEROID_GOOGLE_CLIENT_SECRET'],
    });
    say(clone);
    await waitFor(() => calls.length > 0, 'セッションが開くこと');
    clone.stop();

    expect(calls[0]?.options.env).not.toHaveProperty('ALTEROID_GOOGLE_CLIENT_SECRET');
    // **daemon（呼び出し元）が持つ元の env オブジェクトは変わらない。** daemon
    // 本体は OAuth の交換でこの値を使い続けるので、`#childEnv()` が書き換えて
    // はいけない（渡すのはコピーからの削除であって、`this.#env` 自体ではない）。
    expect(sourceEnv.ALTEROID_GOOGLE_CLIENT_SECRET).toBe('super-secret');
  });

  it('伏せない鍵（記憶ストアの鍵。例: ALTEROID_DATABASE_URL）はそのまま残る', async () => {
    const { clone, calls } = cloneWithWithheld({
      env: {
        ALTEROID_GOOGLE_CLIENT_SECRET: 'super-secret',
        ALTEROID_DATABASE_URL: 'postgres://alteroid:secret@db:5432/alteroid',
      },
      withheldEnvKeys: ['ALTEROID_GOOGLE_CLIENT_SECRET'],
    });
    say(clone);
    await waitFor(() => calls.length > 0, 'セッションが開くこと');
    clone.stop();

    expect(calls[0]?.options.env?.ALTEROID_DATABASE_URL).toBe(
      'postgres://alteroid:secret@db:5432/alteroid',
    );
  });

  it('正本（credentials）が同じ名前を重ねてきても、最後に落ちて生き残らない', async () => {
    const { clone, calls } = cloneWithWithheld({
      withheldEnvKeys: ['ALTEROID_GOOGLE_CLIENT_SECRET'],
      credentials: () => ({ ALTEROID_GOOGLE_CLIENT_SECRET: 'rotated-in-by-credentials' }),
    });
    say(clone);
    await waitFor(() => calls.length > 0, 'セッションが開くこと');
    clone.stop();

    expect(calls[0]?.options.env).not.toHaveProperty('ALTEROID_GOOGLE_CLIENT_SECRET');
  });

  it('プロファイルが同じ名前を明示的に宣言していても、最後に落ちて生き残らない', async () => {
    // **記憶ストアの鍵（`GH_TOKEN` 等）とは扱いが違う。** あちらはプロファイルの
    // 明示宣言が勝つ（直上の `credentials` 節「⚠️ プロファイルが同じ名前を
    // 宣言していると、鍵が上書きされる」）が、ここは `#childEnv()` の最後で
    // 落ちるので、人間が明示的に書いても勝てない。
    const { clone, calls } = cloneWithWithheld({
      withheldEnvKeys: ['ALTEROID_GOOGLE_CLIENT_SECRET'],
      profileEnv: { ALTEROID_GOOGLE_CLIENT_SECRET: 'declared-in-profile' },
    });
    say(clone);
    await waitFor(() => calls.length > 0, 'セッションが開くこと');
    clone.stop();

    expect(calls[0]?.options.env).not.toHaveProperty('ALTEROID_GOOGLE_CLIENT_SECRET');
  });
});

/**
 * 枠の観測を回し手へ渡す口（Issue #393 PR3）。
 *
 * **ここが固定するのは「何を渡すか」である。** クローンは回すかどうかを判断しない
 * ——判断も選択も撒きも回し手が持つ。
 */
