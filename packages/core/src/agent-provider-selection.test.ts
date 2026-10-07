import { describe, expect, it } from 'vitest';

import { AGENT_PROVIDER_IDS } from './agent-ports.js';
import {
  CLONE_PROVIDER_ENV_KEY,
  CLONE_PROVIDER_IDS,
  DEFAULT_AGENT_PROVIDER_ID,
  MANAGER_PROVIDER_ENV_KEY,
  MANAGER_PROVIDER_IDS,
  agentProviderOf,
  placedAgentProvider,
  resolveCloneProviderId,
  CLONE_PROVIDER_RECOMMENDATION,
  CODEX_DEFAULT_MODEL_LABEL,
  cloneLayerProviderOf,
  layerModelLabel,
  resolveManagerProviderId,
} from './agent-provider-selection.js';
import { CLAUDE_PROVIDER } from './claude-provider.js';
import { CODEX_CLONE_PROVIDER, CODEX_PROVIDER } from './codex-provider.js';

describe('層ごとの provider の選択', () => {
  it('環境変数名は固定である', () => {
    expect(CLONE_PROVIDER_ENV_KEY).toBe('ALTEROID_CLONE_PROVIDER');
    expect(MANAGER_PROVIDER_ENV_KEY).toBe('ALTEROID_MANAGER_PROVIDER');
  });

  it('既定は claude', () => {
    expect(DEFAULT_AGENT_PROVIDER_ID).toBe('claude');
  });

  for (const [label, resolve, key, accepted] of [
    ['クローン', resolveCloneProviderId, CLONE_PROVIDER_ENV_KEY, CLONE_PROVIDER_IDS],
    ['マネージャー', resolveManagerProviderId, MANAGER_PROVIDER_ENV_KEY, MANAGER_PROVIDER_IDS],
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
        expect(() => resolve({ [key]: 'cladue' })).toThrow(new RegExp(key));
        expect(() => resolve({ [key]: 'Claude' })).toThrow();
      });

      it('受け付ける値は、その層に駆動役が在る provider（AGENT_PROVIDER_IDS の部分集合）', () => {
        for (const id of accepted) expect(resolve({ [key]: id })).toBe(id);
        for (const id of accepted) expect(AGENT_PROVIDER_IDS).toContain(id);
      });
    });
  }

  it('マネージャー層は codex を受け付ける（駆動役: CodexManagerDriver）', () => {
    expect(resolveManagerProviderId({ [MANAGER_PROVIDER_ENV_KEY]: 'codex' })).toBe('codex');
    expect(MANAGER_PROVIDER_IDS).toEqual(['claude', 'codex']);
  });

  it('クローン層も codex を受け付ける（駆動役: CodexCloneDriver）', () => {
    expect(CLONE_PROVIDER_IDS).toEqual(['claude', 'codex']);
    expect(resolveCloneProviderId({ [CLONE_PROVIDER_ENV_KEY]: 'codex' })).toBe('codex');
    expect(resolveCloneProviderId({})).toBe('claude');
  });

  it('クローン層の不正な値のエラー文に、Claude を推奨すると添える', () => {
    expect(() => resolveCloneProviderId({ [CLONE_PROVIDER_ENV_KEY]: 'cladue' })).toThrow(
      /Claude を推奨/,
    );
    expect(() => resolveManagerProviderId({ [MANAGER_PROVIDER_ENV_KEY]: 'cladue' })).not.toThrow(
      /推奨/,
    );
    expect(CLONE_PROVIDER_RECOMMENDATION).toContain('Claude を推奨');
  });

  it('クローン層の Codex は承認と蒸留（圧縮の割り込み）を持たないと申告する。claude は変わらない', () => {
    expect(cloneLayerProviderOf('codex')).toBe(CODEX_CLONE_PROVIDER);
    expect(cloneLayerProviderOf('claude')).toBe(CLAUDE_PROVIDER);
    expect(agentProviderOf('codex').capabilities.permissions).toBe(true);
  });

  it('2層は独立に読まれる（片方の変数がもう片方に効かない）', () => {
    expect(resolveCloneProviderId({ [MANAGER_PROVIDER_ENV_KEY]: 'codex' })).toBe('claude');
    expect(resolveManagerProviderId({ [CLONE_PROVIDER_ENV_KEY]: 'claude' })).toBe('claude');
  });

  it('自己認識のモデル表記: claude は帯のまま、codex は置かれたモデルか「Codex の既定」（Claude の帯を名乗らない）', () => {
    expect(layerModelLabel('claude', 'opus', null)).toBe('opus');
    expect(layerModelLabel('claude', 'opus', 'sonnet')).toBe('opus');
    expect(layerModelLabel('codex', 'opus', null)).toBe(CODEX_DEFAULT_MODEL_LABEL);
    expect(layerModelLabel('codex', 'opus', 'gpt-5')).toBe('gpt-5');
    expect(CODEX_DEFAULT_MODEL_LABEL).toContain('Codex の既定');
  });

  it('agentProviderOf は id から AgentProvider を引く', () => {
    expect(agentProviderOf('claude')).toBe(CLAUDE_PROVIDER);
    expect(agentProviderOf('codex')).toBe(CODEX_PROVIDER);
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
