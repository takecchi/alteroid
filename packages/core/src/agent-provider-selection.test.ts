import { describe, expect, it } from 'vitest';

import { AGENT_PROVIDER_IDS } from './agent-ports.js';
import {
  CLONE_PROVIDER_ENV_KEY,
  DEFAULT_AGENT_PROVIDER_ID,
  MANAGER_PROVIDER_ENV_KEY,
  agentProviderOf,
  placedAgentProvider,
  resolveCloneProviderId,
  resolveManagerProviderId,
} from './agent-provider-selection.js';
import { CLAUDE_PROVIDER } from './claude-provider.js';

describe('層ごとの provider の選択', () => {
  it('環境変数名は固定である', () => {
    expect(CLONE_PROVIDER_ENV_KEY).toBe('ALTEROID_CLONE_PROVIDER');
    expect(MANAGER_PROVIDER_ENV_KEY).toBe('ALTEROID_MANAGER_PROVIDER');
  });

  it('既定は claude', () => {
    expect(DEFAULT_AGENT_PROVIDER_ID).toBe('claude');
  });

  for (const [label, resolve, key] of [
    ['クローン', resolveCloneProviderId, CLONE_PROVIDER_ENV_KEY],
    ['マネージャー', resolveManagerProviderId, MANAGER_PROVIDER_ENV_KEY],
  ] as const) {
    describe(label, () => {
      it('未設定・空・空白は claude', () => {
        expect(resolve({})).toBe('claude');
        expect(resolve({ [key]: '' })).toBe('claude');
        expect(resolve({ [key]: '   ' })).toBe('claude');
      });

      it('claude 明示は claude（前後の空白は落とす）', () => {
        expect(resolve({ [key]: 'claude' })).toBe('claude');
        expect(resolve({ [key]: '  claude ' })).toBe('claude');
      });

      it('未知の値は黙って既定へ倒さず、変数名を名指しして例外にする', () => {
        expect(() => resolve({ [key]: 'codex' })).toThrow(new RegExp(key));
        expect(() => resolve({ [key]: 'Claude' })).toThrow(); // 大文字小文字も緩めない
      });

      it('受け付ける値は AGENT_PROVIDER_IDS が出所（全部通る）', () => {
        for (const id of AGENT_PROVIDER_IDS) expect(resolve({ [key]: id })).toBe(id);
      });
    });
  }

  it('2層は独立に読まれる（片方の変数がもう片方に効かない）', () => {
    expect(resolveCloneProviderId({ [MANAGER_PROVIDER_ENV_KEY]: 'codex' })).toBe('claude');
    expect(resolveManagerProviderId({ [CLONE_PROVIDER_ENV_KEY]: 'codex' })).toBe('claude');
  });

  it('agentProviderOf は id から AgentProvider を引く（いまは CLAUDE_PROVIDER）', () => {
    expect(agentProviderOf('claude')).toBe(CLAUDE_PROVIDER);
    for (const id of AGENT_PROVIDER_IDS) expect(agentProviderOf(id).id).toBe(id);
  });
});

describe('placedAgentProvider', () => {
  it('置かれていなければ null（空・空白も未設定）', () => {
    expect(placedAgentProvider({}, CLONE_PROVIDER_ENV_KEY)).toBeNull();
    expect(
      placedAgentProvider({ [CLONE_PROVIDER_ENV_KEY]: ' ' }, CLONE_PROVIDER_ENV_KEY),
    ).toBeNull();
  });

  it('既定と同じ値を明示した場合も「置かれた」（値の比較ではない）', () => {
    expect(
      placedAgentProvider({ [MANAGER_PROVIDER_ENV_KEY]: 'claude' }, MANAGER_PROVIDER_ENV_KEY),
    ).toBe('claude');
  });
});
