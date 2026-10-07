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

    current = 'second';
    expect(calls[0]?.options.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe('first');
    clone.stop();
  });

  it('⚠️ プロファイルが同じ名前を宣言していると、鍵が上書きされる', async () => {
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
    const { clone, calls } = cloneWithVault({ env: { GH_TOKEN: 'from-container-env' } });
    say(clone);
    await waitFor(() => calls.length > 0, 'セッションが開くこと');
    clone.stop();

    expect(calls[0]?.options.env?.GH_TOKEN).toBe('from-container-env');
  });

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
    const { clone, calls } = cloneWithBase({
      env: { NPM_TOKEN: 'written-at-boot', REAL_CONTAINER_VAR: 'kept' },
      childEnvBase: { REAL_CONTAINER_VAR: 'kept' },
      vault: [],
    });
    say(clone);
    await waitFor(() => calls.length > 0, 'セッションが開くこと');
    clone.stop();

    expect(calls[0]?.options.env).not.toHaveProperty('NPM_TOKEN');
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
