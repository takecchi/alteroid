import { describe, expect, it } from 'vitest';

import type { AgentProviderId } from './agent-ports.js';
import {
  MANAGER_PEER_CODEX_MODELS_ENV_KEY,
  MANAGER_PEERS_ENV_KEY,
  isPeerAllowed,
  managerPeerModelsEnvKey,
  parsePeerModels,
  parsePeers,
  resolvePeerModels,
  resolvePeers,
} from './agent-provider-peers.js';

const KNOWN: readonly AgentProviderId[] = ['claude', 'codex'];
const CLAUDE: AgentProviderId = 'claude';
const CODEX: AgentProviderId = 'codex';

describe('ALTEROID_MANAGER_PEERS の解釈', () => {
  it('環境変数名は固定である', () => {
    expect(MANAGER_PEERS_ENV_KEY).toBe('ALTEROID_MANAGER_PEERS');
  });

  it('未設定・空・空白だけは閉じている（空集合）', () => {
    for (const raw of [undefined, '', '   ', '\t\n']) {
      const resolved = parsePeers(raw, CLAUDE, KNOWN);
      expect([...resolved.peers]).toEqual([]);
      expect(resolved.selfListed).toBe(false);
    }
  });

  it('開けた provider だけが許され、開けていないものは false', () => {
    const { peers } = parsePeers('codex', CLAUDE, KNOWN);
    expect(isPeerAllowed(CLAUDE, peers, CODEX)).toBe(true);
    const { peers: closed } = parsePeers('', CLAUDE, KNOWN);
    expect(isPeerAllowed(CLAUDE, closed, CODEX)).toBe(false);
  });

  it('カンマ区切り・前後の空白は落とす・重複は1つ', () => {
    const { peers } = parsePeers(' claude , codex,codex ', 'other' as AgentProviderId, KNOWN);
    expect([...peers]).toEqual(['claude', 'codex']);
    const { peers: both } = parsePeers(' codex ', CLAUDE, KNOWN);
    expect([...both]).toEqual(['codex']);
  });

  it('未知の値は黙って閉じも開けもせず、変数名を名指しして例外', () => {
    expect(() => parsePeers('cladue', CLAUDE, KNOWN)).toThrow(new RegExp(MANAGER_PEERS_ENV_KEY));
    expect(() => parsePeers('codex,cladue', CLAUDE, KNOWN)).toThrow(/cladue/);
  });

  it('大文字小文字は緩めない', () => {
    expect(() => parsePeers('Codex', CLAUDE, KNOWN)).toThrow();
  });

  it('空の要素（連続・末尾のカンマ）は例外', () => {
    expect(() => parsePeers('codex,,claude', CLAUDE, KNOWN)).toThrow();
    expect(() => parsePeers('codex,', CLAUDE, KNOWN)).toThrow();
    expect(() => parsePeers(',', CLAUDE, KNOWN)).toThrow();
  });

  it('自分の層の provider は例外にせず集合から除く。ただし書かれていたことは返す（黙らせない）', () => {
    const only = parsePeers('claude', CLAUDE, KNOWN);
    expect([...only.peers]).toEqual([]);
    expect(only.selfListed).toBe(true);
    const mixed = parsePeers('codex,claude', CLAUDE, KNOWN);
    expect([...mixed.peers]).toEqual(['codex']);
    expect(mixed.selfListed).toBe(true);
  });

  it('自分の層を書かなければ selfListed は false', () => {
    expect(parsePeers('codex', CLAUDE, KNOWN).selfListed).toBe(false);
  });

  it('既定の known（AGENT_PROVIDER_IDS）では claude も codex も受け付ける。未知の値は例外', () => {
    expect([...parsePeers('codex', CLAUDE).peers]).toEqual(['codex']);
    expect(parsePeers('claude', CLAUDE).selfListed).toBe(true);
    expect(() => parsePeers('gemini', CLAUDE)).toThrow();
    expect([...parsePeers(undefined, CLAUDE).peers]).toEqual([]);
  });

  it('resolvePeers は ALTEROID_MANAGER_PEERS だけを読む（旧 ALTEROID_CLONE_PEERS は効かない）', () => {
    expect([...resolvePeers({ ALTEROID_CLONE_PEERS: 'codex' }, CLAUDE, KNOWN).peers]).toEqual([]);
    expect([...resolvePeers({ [MANAGER_PEERS_ENV_KEY]: 'codex' }, CLAUDE, KNOWN).peers]).toEqual([
      'codex',
    ]);
  });

  it('isPeerAllowed は自分自身を許さない（集合に紛れても false）', () => {
    expect(isPeerAllowed(CLAUDE, new Set([CLAUDE, CODEX]), CLAUDE)).toBe(false);
    expect(isPeerAllowed(CLAUDE, new Set([CLAUDE, CODEX]), CODEX)).toBe(true);
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

  it('開いている peer の一覧だけを採り、開いていない provider の一覧は使わずに名前を返す', () => {
    const env = { [MANAGER_PEER_CODEX_MODELS_ENV_KEY]: 'gpt-5.5' };
    expect(resolvePeerModels(env, new Set([CODEX]), KNOWN)).toEqual({
      models: { codex: ['gpt-5.5'] },
      unusedKeys: [],
    });
    expect(resolvePeerModels(env, new Set(), KNOWN)).toEqual({
      models: {},
      unusedKeys: [MANAGER_PEER_CODEX_MODELS_ENV_KEY],
    });
  });
});
