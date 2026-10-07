import { describe, expect, it } from 'vitest';

import {
  NO_CAPABILITIES,
  REQUIREMENT_BEARING_CAPABILITIES,
  missingRequirementCapabilities,
  type AgentCapabilities,
} from './agent-ports.js';
import { CLAUDE_PROVIDER } from './claude-provider.js';
import { DEFAULT_LAYER_PROVIDERS } from './layer-providers.js';
import { describeProviderGaps } from './provider-gaps.js';

const ALL_CLAUDE = {
  clone: CLAUDE_PROVIDER,
  manager: CLAUDE_PROVIDER,
  worker: CLAUDE_PROVIDER,
};
const FAKE = { displayName: '偽', capabilities: { ...CLAUDE_PROVIDER.capabilities, usage: false } };

describe('describeProviderGaps', () => {
  it('Claude は全層で欠落なし', () => {
    expect(describeProviderGaps(ALL_CLAUDE)).toEqual([]);
  });

  it('CLAUDE_PROVIDER.capabilities のキーは AgentCapabilities の全キーと一致する（番人）', () => {
    expect(Object.keys(CLAUDE_PROVIDER.capabilities).sort()).toEqual(
      Object.keys(NO_CAPABILITIES).sort(),
    );
  });

  it('欠けた要件ごとに層・provider 名・能力の1行を、要件の順で返す', () => {
    const lines = describeProviderGaps({ ...ALL_CLAUDE, manager: FAKE });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('マネージャー');
    expect(lines[0]).toContain('偽');
    expect(lines[0]).toContain('usage');
  });

  it('NO_CAPABILITIES は要件の数だけ、REQUIREMENT_BEARING_CAPABILITIES の順で出る', () => {
    const lines = describeProviderGaps({
      ...ALL_CLAUDE,
      clone: { displayName: '無', capabilities: NO_CAPABILITIES },
    });
    expect(lines).toHaveLength(REQUIREMENT_BEARING_CAPABILITIES.length);
    REQUIREMENT_BEARING_CAPABILITIES.forEach((key, i) => expect(lines[i]).toContain(key));
    expect(lines.every((l) => l.includes('クローン'))).toBe(true);
  });

  it('partialMessages の欠落は出さない（要件ではない）', () => {
    const capabilities: AgentCapabilities = {
      ...CLAUDE_PROVIDER.capabilities,
      partialMessages: false,
    };
    expect(
      describeProviderGaps({ ...ALL_CLAUDE, worker: { displayName: 'x', capabilities } }),
    ).toEqual([]);
  });

  it('層ごとの既定 provider は、どれも要件を担う能力を欠かない', () => {
    for (const provider of Object.values(DEFAULT_LAYER_PROVIDERS)) {
      expect(missingRequirementCapabilities(provider.capabilities)).toEqual([]);
    }
    expect(describeProviderGaps(DEFAULT_LAYER_PROVIDERS)).toEqual([]);
  });
});
