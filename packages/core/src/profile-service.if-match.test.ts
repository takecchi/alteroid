import { describe, expect, it } from 'vitest';

import {
  createProfileService,
  profileEntryVersionOf,
  ProfileVersionMismatchError,
} from './profile-service.js';
import { createMemoryStores } from './testing.js';
import { createCloneTools } from './tools.js';

function setup() {
  const stores = createMemoryStores();
  const profile = createProfileService({ stores });
  return { stores, profile };
}

describe('プロファイルの行の版（ifMatch）で、読んだ後の変更を黙って上書き・削除しない（#4592）', () => {
  it('読んだ後にほかで書き換えられていれば、読んだ版での set は何も変えずに断る', async () => {
    const { stores, profile } = setup();
    await profile.set('rust', 'export R=1');
    const read = profileEntryVersionOf((await profile.read())[0]!);

    // 読んだ後に、ほか（クローン）が書き換える
    await profile.set('rust', 'export R=clone');

    await expect(
      profile.set('rust', 'export R=human', undefined, { ifMatch: read }),
    ).rejects.toThrow(ProfileVersionMismatchError);
    expect((await stores.profile.list())[0]?.script).toBe('export R=clone\n');
  });

  it('読んだ後にほかで書き換えられていれば、読んだ版での remove は外さずに断る', async () => {
    const { stores, profile } = setup();
    await profile.set('rust', 'export R=1');
    const read = profileEntryVersionOf((await profile.read())[0]!);
    await profile.set('rust', 'export R=clone');

    await expect(profile.remove('rust', { ifMatch: read })).rejects.toThrow(
      ProfileVersionMismatchError,
    );
    expect(await stores.profile.list()).toHaveLength(1);
  });

  it('ifMatch: null は「無いときだけ作る」: 読んだ後にほかで作られていれば断る', async () => {
    const { stores, profile } = setup();
    await profile.set('rust', 'export R=clone');

    const error = await profile
      .set('rust', 'export R=human', undefined, { ifMatch: null })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ProfileVersionMismatchError);
    // 断りの文に本文（鍵が入りうる）を載せない
    expect(String((error as Error).message)).not.toContain('export R=');
    expect((await stores.profile.list())[0]?.script).toBe('export R=clone\n');
  });

  it('撒く先だけの変更でも版が変わる', async () => {
    const { profile } = setup();
    await profile.set('rust', 'export R=1');
    const before = profileEntryVersionOf((await profile.read())[0]!);
    await profile.set('rust', 'export R=1', 'runner');

    expect(profileEntryVersionOf((await profile.read())[0]!)).not.toBe(before);
  });

  it('版が合えば置き換え・外す。対照: ifMatch を渡さなければ今までどおり比べない', async () => {
    const { stores, profile } = setup();
    await profile.set('rust', 'export R=1');
    const read = profileEntryVersionOf((await profile.read())[0]!);
    await profile.set('rust', 'export R=2', undefined, { ifMatch: read });
    expect((await stores.profile.list())[0]?.script).toBe('export R=2\n');

    await profile.set('rust', 'export R=3');
    expect((await stores.profile.list())[0]?.script).toBe('export R=3\n');
    await profile.remove('rust');
    expect(await stores.profile.list()).toEqual([]);
  });
});

describe('クローンの profile_write / profile_remove の任意の base_version（#4592）', () => {
  function tools() {
    const { stores, profile } = setup();
    const all = createCloneTools({
      memoryCause: () => 'clone',
      conversationId: () => undefined,
      stores,
      emit: () => undefined,
      profile,
    });
    async function call(name: string, args: Record<string, unknown>): Promise<string> {
      const found = all.find((entry) => entry.name === name);
      if (found === undefined) throw new Error(`道具 ${name} が無い`);
      const result = await found.handler(args as never, {});
      return (result.content ?? []).map((b) => (b.type === 'text' ? b.text : '')).join('');
    }
    return { stores, profile, call };
  }

  it('profile_read name=<名前> が base_version を出し、それで書き直せる', async () => {
    const { stores, call } = tools();
    await call('profile_write', { name: 'rust', script: 'export R=1', summary: 'r' });
    const read = await call('profile_read', { name: 'rust' });
    const version = /base_version=([0-9a-f]+)/.exec(read)?.[1];
    expect(version).toBeDefined();

    await call('profile_write', {
      name: 'rust',
      script: 'export R=2',
      summary: 'r',
      base_version: version,
    });
    expect((await stores.profile.list())[0]?.script).toBe('export R=2\n');
  });

  it('読んだ後に人間が書き換えていれば、profile_write も profile_remove も何も変えずに断る', async () => {
    const { stores, profile, call } = tools();
    await call('profile_write', { name: 'rust', script: 'export R=1', summary: 'r' });
    const read = await call('profile_read', { name: 'rust' });
    const version = /base_version=([0-9a-f]+)/.exec(read)?.[1];

    // 読んだ後に、人間が書き換える
    await profile.set('rust', 'export R=human');

    const written = await call('profile_write', {
      name: 'rust',
      script: 'export R=clone',
      summary: 'r',
      base_version: version,
    });
    expect(written).toMatch(/読んだ後に変わっている/);
    expect(written).toMatch(/profile_read name=rust/);
    const removed = await call('profile_remove', {
      name: 'rust',
      summary: 'r',
      base_version: version,
    });
    expect(removed).toMatch(/読んだ後に変わっている/);
    expect((await stores.profile.list())[0]?.script).toBe('export R=human\n');
  });

  it('対照: base_version を省けば、今までどおり比べずに置き換える', async () => {
    const { stores, profile, call } = tools();
    await call('profile_write', { name: 'rust', script: 'export R=1', summary: 'r' });
    await profile.set('rust', 'export R=human');

    await call('profile_write', { name: 'rust', script: 'export R=clone', summary: 'r' });

    expect((await stores.profile.list())[0]?.script).toBe('export R=clone\n');
  });
});
