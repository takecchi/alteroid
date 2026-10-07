import { describe, expect, it } from 'vitest';

import type { AgentProviderId } from './agent-ports.js';
import {
  CLONE_PEERS_ENV_KEY,
  MANAGER_PEERS_ENV_KEY,
  isPeerAllowed,
  parsePeers,
  resolvePeers,
} from './agent-provider-peers.js';

const KNOWN: readonly AgentProviderId[] = ['claude', 'codex'];
const CLAUDE: AgentProviderId = 'claude';
const CODEX: AgentProviderId = 'codex';

describe('ALTEROID_<層>_PEERS の解釈', () => {
  it('環境変数名は固定である', () => {
    expect(CLONE_PEERS_ENV_KEY).toBe('ALTEROID_CLONE_PEERS');
    expect(MANAGER_PEERS_ENV_KEY).toBe('ALTEROID_MANAGER_PEERS');
  });

  for (const layer of ['clone', 'manager'] as const) {
    describe(layer, () => {
      it('未設定・空・空白だけは閉じている（空集合）', () => {
        for (const raw of [undefined, '', '   ', '\t\n']) {
          const resolved = parsePeers(layer, raw, CLAUDE, KNOWN);
          expect([...resolved.peers]).toEqual([]);
          expect(resolved.selfListed).toBe(false);
        }
      });

      it('開けた provider だけが許され、開けていないものは false', () => {
        const { peers } = parsePeers(layer, 'codex', CLAUDE, KNOWN);
        expect(isPeerAllowed(CLAUDE, peers, CODEX)).toBe(true);
        const { peers: closed } = parsePeers(layer, '', CLAUDE, KNOWN);
        expect(isPeerAllowed(CLAUDE, closed, CODEX)).toBe(false);
      });

      it('カンマ区切り・前後の空白は落とす・重複は1つ', () => {
        const { peers } = parsePeers(
          layer,
          ' claude , codex,codex ',
          'other' as AgentProviderId,
          KNOWN,
        );
        expect([...peers]).toEqual(['claude', 'codex']);
        const { peers: both } = parsePeers(layer, ' codex ', CLAUDE, KNOWN);
        expect([...both]).toEqual(['codex']);
      });

      it('未知の値は黙って閉じも開けもせず、変数名を名指しして例外', () => {
        const key = layer === 'clone' ? CLONE_PEERS_ENV_KEY : MANAGER_PEERS_ENV_KEY;
        expect(() => parsePeers(layer, 'cladue', CLAUDE, KNOWN)).toThrow(new RegExp(key));
        expect(() => parsePeers(layer, 'codex,cladue', CLAUDE, KNOWN)).toThrow(/cladue/);
      });

      it('大文字小文字は緩めない', () => {
        expect(() => parsePeers(layer, 'Codex', CLAUDE, KNOWN)).toThrow();
      });

      it('空の要素（連続・末尾のカンマ）は例外', () => {
        expect(() => parsePeers(layer, 'codex,,claude', CLAUDE, KNOWN)).toThrow();
        expect(() => parsePeers(layer, 'codex,', CLAUDE, KNOWN)).toThrow();
        expect(() => parsePeers(layer, ',', CLAUDE, KNOWN)).toThrow();
      });

      it('自分の層の provider は例外にせず集合から除く。ただし書かれていたことは返す（黙らせない）', () => {
        const only = parsePeers(layer, 'claude', CLAUDE, KNOWN);
        expect([...only.peers]).toEqual([]);
        expect(only.selfListed).toBe(true);
        const mixed = parsePeers(layer, 'codex,claude', CLAUDE, KNOWN);
        expect([...mixed.peers]).toEqual(['codex']);
        expect(mixed.selfListed).toBe(true);
        const fromCodex = parsePeers(layer, 'codex,claude', CODEX, KNOWN);
        expect([...fromCodex.peers]).toEqual(['claude']);
        expect(fromCodex.selfListed).toBe(true);
      });

      it('自分の層を書かなければ selfListed は false', () => {
        expect(parsePeers(layer, 'codex', CLAUDE, KNOWN).selfListed).toBe(false);
      });

      it('既定の known（AGENT_PROVIDER_IDS）では claude も codex も受け付ける。未知の値は例外', () => {
        expect([...parsePeers(layer, 'codex', CLAUDE).peers]).toEqual(['codex']);
        expect(parsePeers(layer, 'claude', CLAUDE).selfListed).toBe(true);
        expect(() => parsePeers(layer, 'gemini', CLAUDE)).toThrow();
        expect([...parsePeers(layer, undefined, CLAUDE).peers]).toEqual([]);
      });
    });
  }

  it('層を取り違えない（clone の PEERS が manager に効かない）', () => {
    const env = { [CLONE_PEERS_ENV_KEY]: 'codex' };
    expect([...resolvePeers('clone', env, CLAUDE, KNOWN).peers]).toEqual(['codex']);
    expect([...resolvePeers('manager', env, CLAUDE, KNOWN).peers]).toEqual([]);
    const env2 = { [MANAGER_PEERS_ENV_KEY]: 'codex' };
    expect([...resolvePeers('clone', env2, CLAUDE, KNOWN).peers]).toEqual([]);
    expect([...resolvePeers('manager', env2, CLAUDE, KNOWN).peers]).toEqual(['codex']);
  });

  it('isPeerAllowed は自分自身を許さない（集合に紛れても false）', () => {
    expect(isPeerAllowed(CLAUDE, new Set([CLAUDE, CODEX]), CLAUDE)).toBe(false);
    expect(isPeerAllowed(CLAUDE, new Set([CLAUDE, CODEX]), CODEX)).toBe(true);
  });
});
