import { describe, expect, it } from 'vitest';

import { heuristicChars } from './quantity.js';
import type { CloneRuntimeFacts } from './self.js';
import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';
import { createCloneTools } from './tools.js';

/**
 * `self_status` に Codex の ChatGPT ログインの状態が出る（#3939）。切れた・失効したら再ログインを
 * 促す行が出る。**ログインしていなければ1行も足さない**（今までの出力のまま）。値は出ない。
 */
const RUNTIME: CloneRuntimeFacts = {
  revision: { commit: null, short: null, source: null },
  buildTime: { builtAt: null },
  declaredModel: 'fable',
  modelOverridden: false,
  modelEnvKey: 'ALTEROID_CLONE_MODEL',
  sdkModel: null,
  effort: null,
  requestedEffort: null,
  claudeCodeVersion: null,
  apiKeySource: null,
  permissionMode: null,
  requestedPermissionMode: 'auto',
  mcpServers: [],
  sessionId: null,
  resumedFrom: null,
  injectedMemoryChars: heuristicChars(0),
  systemPromptChars: heuristicChars(0),
  lastContextUsage: null,
};

async function selfStatus(stores: Stores): Promise<string> {
  const tools = createCloneTools({
    stores,
    emit: () => undefined,
    memoryCause: () => 'clone',
    conversationId: () => undefined,
    runtime: () => RUNTIME,
  });
  const found = tools.find((entry) => entry.name === 'self_status');
  if (!found) throw new Error('self_status が無い');
  const result = await found.handler({} as never, {});
  return (result.content ?? []).map((part) => ('text' in part ? part.text : '')).join('');
}

describe('self_status の Codex の ChatGPT ログイン（#3939）', () => {
  it('ログインしていなければ何も足さない', async () => {
    expect(await selfStatus(createMemoryStores())).not.toContain('Codex');
  });

  it('ログイン済みならアカウントとプランが出て、値は出ない', async () => {
    const stores = createMemoryStores();
    await stores.codexAuth.replace({
      value: '{"tokens":{"refresh_token":"rt-self-fake"}}',
      revision: 'r1',
      updatedAt: '2026-10-07T00:00:00.000Z',
      email: 'me@example.com',
      planType: 'plus',
      failure: null,
    });
    const reply = await selfStatus(stores);
    expect(reply).toContain('Codex の ChatGPT ログイン: あり（me@example.com・plus');
    expect(reply).not.toContain('rt-self-fake');
    expect(reply).not.toContain('再ログイン');
  });

  it('ログイン済みなら、使えるのは runner の peer だけで、この器の codex が未ログインなのは設計どおりだと出る', async () => {
    const stores = createMemoryStores();
    await stores.codexAuth.replace({
      value: '{}',
      revision: 'r1',
      updatedAt: '2026-10-07T00:00:00.000Z',
      email: 'me@example.com',
      planType: 'team',
      failure: null,
    });
    const reply = await selfStatus(stores);
    expect(reply).toContain('使えるのは runner のマネージャーが peer で頼む Codex だけ');
    expect(reply).toContain('クローンはマネージャーへの依頼として頼む');
    expect(reply).toContain('未ログインと出るのは設計どおり');
  });

  it('切れていたら理由と再ログインの促しが出る', async () => {
    const stores = createMemoryStores();
    await stores.codexAuth.replace({
      value: '{}',
      revision: 'r1',
      updatedAt: '2026-10-07T00:00:00.000Z',
      email: 'me@example.com',
      planType: 'plus',
      failure: { at: '2026-10-07T01:00:00.000Z', reason: 'refresh token was revoked' },
    });
    const reply = await selfStatus(stores);
    expect(reply).toContain('refresh token was revoked');
    expect(reply).toContain('再ログイン');
    expect(reply).toContain('alteroid codex login');
  });
});
