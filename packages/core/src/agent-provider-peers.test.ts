import { describe, expect, it } from 'vitest';

import type { AgentProviderId } from './agent-ports.js';
import {
  CODEX_PEER_CLOSED_REASON,
  MANAGER_PEER_CODEX_MODELS_ENV_KEY,
  PEER_PROVIDER_IDS,
  managerPeerModelsEnvKey,
  parsePeerModels,
  resolvePeerModels,
  resolvePeerModelsOf,
  resolvePeerOpening,
  samePeerOpening,
} from './agent-provider-peers.js';
import { agentProviderOf } from './agent-provider-selection.js';

const CODEX: AgentProviderId = 'codex';
const DEFAULTS: readonly string[] = ['model-a', 'model-b'];
const defaultsOf = (provider: AgentProviderId) => (provider === CODEX ? DEFAULTS : undefined);

describe('peer を開く条件は Codex の資格である（#4118）', () => {
  it('peer になれるのは Codex だけ（層の provider = Claude は入らない）', () => {
    expect(PEER_PROVIDER_IDS).toEqual(['codex']);
  });

  it('ChatGPT ログインか CODEX_API_KEY のどちらかが届いていれば開く', () => {
    for (const presence of [
      { codexApiKey: true, codexChatgptLogin: false },
      { codexApiKey: false, codexChatgptLogin: true },
      { codexApiKey: true, codexChatgptLogin: true },
    ]) {
      expect(resolvePeerOpening(presence)).toEqual({ open: ['codex'], closed: [] });
    }
  });

  it('どちらも無ければ閉じ、理由（何をすれば開くか）を返す', () => {
    const opening = resolvePeerOpening({ codexApiKey: false, codexChatgptLogin: false });
    expect(opening.open).toEqual([]);
    expect(opening.closed).toEqual([{ provider: 'codex', reason: CODEX_PEER_CLOSED_REASON }]);
    expect(CODEX_PEER_CLOSED_REASON).toContain('ログイン');
    expect(CODEX_PEER_CLOSED_REASON).toContain('CODEX_API_KEY');
    expect(CODEX_PEER_CLOSED_REASON).toContain('再起動なし');
  });

  it('samePeerOpening は開閉と理由の両方で比べる', () => {
    const open = resolvePeerOpening({ codexApiKey: true, codexChatgptLogin: false });
    const closed = resolvePeerOpening({ codexApiKey: false, codexChatgptLogin: false });
    expect(
      samePeerOpening(open, resolvePeerOpening({ codexApiKey: false, codexChatgptLogin: true })),
    ).toBe(true);
    expect(samePeerOpening(open, closed)).toBe(false);
    expect(
      samePeerOpening(closed, { open: [], closed: [{ provider: 'codex', reason: '別の理由' }] }),
    ).toBe(false);
  });
});

describe('ALTEROID_MANAGER_PEER_<PROVIDER>_MODELS の解釈（#3934）', () => {
  it('Codex の名前は固定である', () => {
    expect(managerPeerModelsEnvKey(CODEX)).toBe('ALTEROID_MANAGER_PEER_CODEX_MODELS');
    expect(MANAGER_PEER_CODEX_MODELS_ENV_KEY).toBe(managerPeerModelsEnvKey(CODEX));
  });

  it('未設定・空・空白だけは空（model 引数を出さない）', () => {
    for (const raw of [undefined, '', '   ']) {
      expect(parsePeerModels(raw, 'K')).toEqual([]);
    }
  });

  it('カンマ区切りで並べ、前後の空白を落とし、重複は1つに畳む', () => {
    expect(parsePeerModels(' gpt-5.5 , gpt-5.5-codex,gpt-5.5 ', 'K')).toEqual([
      'gpt-5.5',
      'gpt-5.5-codex',
    ]);
  });

  it('空の要素・空白を含む名前は起動時に止める', () => {
    expect(() => parsePeerModels('gpt-5.5,,x', 'K')).toThrow(/空の要素/);
    expect(() => parsePeerModels('gpt-5.5,', 'K')).toThrow(/空の要素/);
    expect(() => parsePeerModels('gpt 5', 'K')).toThrow(/空白/);
  });

  it('置かれた一覧は、開いているかどうかに依らず採る（資格は後から届くため）', () => {
    const env = { [MANAGER_PEER_CODEX_MODELS_ENV_KEY]: 'gpt-5.5' };
    expect(resolvePeerModels(env, defaultsOf)).toEqual({ codex: ['gpt-5.5'] });
  });

  it('未設定・空・空白だけなら既定の一覧', () => {
    for (const raw of [undefined, '', '   ']) {
      const env = raw === undefined ? {} : { [MANAGER_PEER_CODEX_MODELS_ENV_KEY]: raw };
      expect(resolvePeerModels(env, defaultsOf)).toEqual({ codex: [...DEFAULTS] });
      expect(resolvePeerModelsOf(env, CODEX, defaultsOf)?.source).toBe('default');
    }
  });

  it('既定の一覧も変数も無い provider は載せない（model 引数を出さない）', () => {
    expect(resolvePeerModels({}, () => undefined)).toEqual({});
    expect(resolvePeerModels({}, () => [])).toEqual({});
  });

  it('置かれた一覧は既定に足さず置き換える', () => {
    const env = { [MANAGER_PEER_CODEX_MODELS_ENV_KEY]: 'gpt-6-astra' };
    expect(resolvePeerModels(env, defaultsOf)).toEqual({ codex: ['gpt-6-astra'] });
    expect(resolvePeerModelsOf(env, CODEX, defaultsOf)).toEqual({
      models: ['gpt-6-astra'],
      source: 'env',
    });
  });

  it('既定の一覧を返しても、持ち主の定数は書き換わらない', () => {
    const got = resolvePeerModelsOf({}, CODEX, defaultsOf)!.models as string[];
    got.push('x');
    expect(DEFAULTS).not.toContain('x');
  });

  it('記述子の既定の一覧: Codex は astra と sol を含み、Claude は持たない', () => {
    expect(agentProviderOf(CODEX).defaultPeerModels).toEqual(
      expect.arrayContaining(['gpt-6-astra', 'gpt-6.1-sol']),
    );
    expect(agentProviderOf('claude').defaultPeerModels).toBeUndefined();
  });

  it('層の provider（Claude）の一覧は読まない', () => {
    expect(resolvePeerModels({ ALTEROID_MANAGER_PEER_CLAUDE_MODELS: 'opus' }, defaultsOf)).toEqual({
      codex: [...DEFAULTS],
    });
  });
});
