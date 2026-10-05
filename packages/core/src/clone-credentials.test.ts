import { describe, it, expect } from 'vitest';
import { ALWAYS_REDELIVER, createClone } from './clone.js';
import { createLocalRunner } from './runner-local.js';
import { createRunnerRegistry } from './runner-protocol.js';
import { createMemoryStores } from './testing.js';
import { fakeSdk, waitFor } from './clone-test-harness.js';

/**
 * 認証トークンのプールの現役をクローンへ届ける口（Issue #393 PR3）。
 *
 * **ここで固定するのは3つ** — 呼ばれるたびに読み直すこと（凍らないこと）、
 * 渡さなければ今までどおりであること、そして**プロファイルが同じ名前を宣言して
 * いると鍵が上書きされること**（塞がない代わりに測っておく）。
 */
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
    vault?: readonly {
      name: string;
      value: string;
      updatedAt: string;
      scope?: 'all' | 'app' | 'runner';
    }[];
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

  /**
   * **⚠️ このテストは 2026-10-06 に期待値を反転した。** 元の題と期待:
   * 「器の env が非空なら、正本より器の env が勝つ（GitHub の名前だけ）」——
   * `expect(...GH_TOKEN).toBe('from-container-env')`。
   *
   * **GitHub の特別扱い（`GITHUB_CREDENTIAL_NAMES`）を撤去した**（オーナー決定 2026-10-06
   * 「GH_TOKEN も通常の環境変数と同じように扱ってほしい」）。実害は、勝っていた「器の env」が
   * 起動時に正本から書き写された古い値だったこと（画面で更新しても古い値が配られた。
   * 実測 2026-10-05）。いまは**正本が子プロセスの env の土台に必ず勝つ**。
   *
   * **保証は弱くなっていない。** 元は「GitHub の名前だけ器の env に揃える」で、いまは
   * 「どの名前でも、土台の env に何が在っても正本の行が勝つ」——後者のほうが強く、下の
   * 「🔴 任意の名前」の歯（元から正本が勝っていた）と同じ主張に畳まれた。
   */
  it('器の env が非空でも、正本が勝つ（GitHub の名前も他の名前と同じ。2026-10-06）', async () => {
    const { clone, calls } = cloneWithVault({
      vault: [{ name: 'GH_TOKEN', value: 'from-vault', updatedAt: '2026-09-12T00:00:00.000Z' }],
      env: { GH_TOKEN: 'from-container-env' },
    });
    say(clone);
    await waitFor(() => calls.length > 0, 'セッションが開くこと');
    clone.stop();

    expect(calls[0]?.options.env?.GH_TOKEN).toBe('from-vault');
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

  /**
   * **scope: 'runner' がクローン側でどう扱われるかを実測する（issue #1894）。**
   * Issue が「マネージャーもクローンも器の env で合っている*はず*だという
   * 判定だけ」と書いていた claim を、ここで実測に変える——`resolveCredentialRows`
   * の describe（`credential-service.test.ts`）は manager 側を実測している。
   * こちらはクローン自身の `#childEnv()`（`this.#env` を先に重ね、その上へ
   * `resolveCredentialRows(rows, 'clone')` を重ねる）まで通した
   * 観測点である。
   *
   * `scope: 'runner'` は `target: 'clone'` に適用されない
   * （`scopeAppliesTo`）ので、`resolveCredentialRows` はこの名前について
   * クローンへ何も返さない。それでもクローンが器の env の値で走るのは、
   * `#childEnv()` が `this.#env`（器の env）を土台として先に重ねるからで
   * あって、`resolveCredentialRows` の解決を経由してはいない。
   */
  it('scope: runner の行があっても、クローンは器の env の値で走る（正本の重ねが素通りする）', async () => {
    const { clone, calls } = cloneWithVault({
      vault: [
        {
          name: 'GH_TOKEN',
          value: 'from-vault',
          updatedAt: '2026-09-12T00:00:00.000Z',
          scope: 'runner',
        },
      ],
      env: { GH_TOKEN: 'from-container-env' },
    });
    say(clone);
    await waitFor(() => calls.length > 0, 'セッションが開くこと');
    clone.stop();

    expect(calls[0]?.options.env?.GH_TOKEN).toBe('from-container-env');
  });

  it('scope: runner の行を外しても、クローンに届く値は変わらない', async () => {
    const withRow = cloneWithVault({
      vault: [
        {
          name: 'GH_TOKEN',
          value: 'from-vault',
          updatedAt: '2026-09-12T00:00:00.000Z',
          scope: 'runner',
        },
      ],
      env: { GH_TOKEN: 'from-container-env' },
    });
    say(withRow.clone);
    await waitFor(() => withRow.calls.length > 0, 'セッションが開くこと（行あり）');
    withRow.clone.stop();

    const withoutRow = cloneWithVault({ env: { GH_TOKEN: 'from-container-env' } });
    say(withoutRow.clone);
    await waitFor(() => withoutRow.calls.length > 0, 'セッションが開くこと（行なし）');
    withoutRow.clone.stop();

    expect(withRow.calls[0]?.options.env?.GH_TOKEN).toBe('from-container-env');
    expect(withoutRow.calls[0]?.options.env?.GH_TOKEN).toBe(
      withRow.calls[0]?.options.env?.GH_TOKEN,
    );
  });
});

/**
 * **子プロセスの env の土台は、正本を書き写す前のスナップショットである**
 * （`CloneOptions.childEnvBase`。2026-10-06）。
 *
 * デーモンは起動時に正本の `scope: all | app` の行を `process.env` へ書き写す。**書き写した後の
 * `process.env` を土台にすると、正本から外した名前の古い値が、起動時の写しとして子に残り続ける**
 * （どの名前でも。実測 2026-10-05）。ここが測るのは3つ: (1) 土台に書き写された値は、正本から
 * 外せば子から本当に消える (2) 正本を更新すれば、書き写された古い値ではなく新しい値が子に届く
 * (3) 土台を分けても、モデル帯など**デーモン自身の設定の読み出し**（`env`）は従来どおり
 * 書き写し後の値を読む。
 */
describe('childEnvBase（子の env の土台は、書き写す前のスナップショット。2026-10-06）', () => {
  let postSeq4 = 0;

  function cloneWithBase(input: {
    env: NodeJS.ProcessEnv;
    childEnvBase?: NodeJS.ProcessEnv;
    vault?: { name: string; value: string; updatedAt: string; scope?: 'all' | 'app' | 'runner' }[];
  }) {
    const { fn, calls } = fakeSdk();
    const vault = input.vault ?? [];
    const clone = createClone({
      redeliveryGate: ALWAYS_REDELIVER,
      stores: createMemoryStores(),
      queryFn: fn,
      env: input.env,
      ...(input.childEnvBase === undefined ? {} : { childEnvBase: input.childEnvBase }),
      credentialService: {
        vaultSnapshot: () => vault,
      } as unknown as Parameters<typeof createClone>[0]['credentialService'],
      runners: createRunnerRegistry([
        createLocalRunner({ workspacePath: '/work', queryFn: fakeSdk().fn, env: {} }),
      ]),
    });
    return { clone, calls };
  }

  function say(clone: ReturnType<typeof createClone>): void {
    clone.post({
      type: 'human_message',
      id: `evt-base-${String(++postSeq4)}`,
      at: new Date().toISOString(),
      text: 'こんにちは',
      conversationId: 'conv-1',
    });
  }

  it('(1) 起動時に書き写された名前は、正本から外せば次に起こす子から消える', async () => {
    // `env` は書き写し後の process.env（NPM_TOKEN が正本から書き写されている）。
    // 土台のスナップショットには無い。正本（vault）は空 ＝ 画面で消した後。
    const { clone, calls } = cloneWithBase({
      env: { NPM_TOKEN: 'written-at-boot', REAL_CONTAINER_VAR: 'kept' },
      childEnvBase: { REAL_CONTAINER_VAR: 'kept' },
      vault: [],
    });
    say(clone);
    await waitFor(() => calls.length > 0, 'セッションが開くこと');
    clone.stop();

    expect(calls[0]?.options.env).not.toHaveProperty('NPM_TOKEN');
    // 本物の器の環境変数（スナップショットに在るもの）は普通の名前として届く。
    expect(calls[0]?.options.env?.REAL_CONTAINER_VAR).toBe('kept');
  });

  it('(2) 正本を更新すれば、書き写された古い値ではなく新しい値が子に届く（GH_TOKEN）', async () => {
    const { clone, calls } = cloneWithBase({
      env: { GH_TOKEN: 'old-written-at-boot' },
      childEnvBase: {},
      vault: [{ name: 'GH_TOKEN', value: 'new-in-vault', updatedAt: '2026-10-06T00:00:00.000Z' }],
    });
    say(clone);
    await waitFor(() => calls.length > 0, 'セッションが開くこと');
    clone.stop();

    expect(calls[0]?.options.env?.GH_TOKEN).toBe('new-in-vault');
  });

  it('(3) 土台を分けても、デーモン自身の設定（モデル帯）は書き写し後の env から読む', async () => {
    const { clone, calls } = cloneWithBase({
      env: { ALTEROID_CLONE_MODEL: 'sonnet' },
      childEnvBase: {},
    });
    say(clone);
    await waitFor(() => calls.length > 0, 'セッションが開くこと');
    clone.stop();

    expect(calls[0]?.options.model).toBe('sonnet');
  });

  it('childEnvBase を渡さなければ、土台は env のまま（既定の構成の挙動を変えない）', async () => {
    const { clone, calls } = cloneWithBase({ env: { FROM_ENV: 'yes' } });
    say(clone);
    await waitFor(() => calls.length > 0, 'セッションが開くこと');
    clone.stop();

    expect(calls[0]?.options.env?.FROM_ENV).toBe('yes');
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
