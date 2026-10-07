import { describe, expect, it } from 'vitest';

import {
  NO_CAPABILITIES,
  REQUIREMENT_BEARING_CAPABILITIES,
  missingRequirementCapabilities,
  type AgentCapabilities,
} from './agent-ports.js';
import { CLAUDE_PROVIDER } from './claude-provider.js';
import { buildActivityDigest } from './digest.js';
import { DEFAULT_LAYER_PROVIDERS } from './layer-providers.js';
import { describeProviderGaps } from './provider-gaps.js';
import { buildSelfKnowledge, describeCloneRuntime } from './self.js';
import type { CloneRuntimeFacts, SelfFacts } from './self.js';
import { createMemoryStores } from './testing.js';

const ALL_CLAUDE = {
  clone: CLAUDE_PROVIDER,
  manager: CLAUDE_PROVIDER,
  worker: CLAUDE_PROVIDER,
};
const FAKE = { displayName: '偽', capabilities: { ...CLAUDE_PROVIDER.capabilities, usage: false } };

const SELF: SelfFacts = {
  storage: 's',
  local: 'l',
  workspace: 'w',
  cwd: 'c',
  runner: 'r',
  entrypoint: 'e',
  auth: 'a',
  models: { clone: 'opus' },
};

function runtimeFacts(): CloneRuntimeFacts {
  return {
    revision: { commit: null, source: null },
    buildTime: { builtAt: null },
    declaredModel: 'opus',
    modelOverridden: false,
    modelEnvKey: 'K',
    sdkModel: null,
    effort: null,
    requestedEffort: null,
    claudeCodeVersion: null,
    apiKeySource: null,
    permissionMode: null,
    requestedPermissionMode: 'default',
    mcpServers: null,
    sessionId: null,
    resumedFrom: null,
    injectedMemoryChars: 0,
    systemPromptChars: 0,
    lastContextUsage: null,
  } as unknown as CloneRuntimeFacts;
}

const WINDOW = { since: new Date('2026-01-01T00:00:00Z'), until: new Date('2026-01-02T00:00:00Z') };

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

describe('欠落を載せる3面', () => {
  it('[] と欄なしで、3面とも1バイトも変わらない', async () => {
    expect(buildSelfKnowledge({ ...SELF, providerGaps: [] })).toBe(buildSelfKnowledge(SELF));
    expect(describeCloneRuntime({ ...runtimeFacts(), providerGaps: [] })).toBe(
      describeCloneRuntime(runtimeFacts()),
    );
    const stores = createMemoryStores();
    const bare = await buildActivityDigest(stores, WINDOW);
    const empty = await buildActivityDigest(stores, WINDOW, undefined, undefined, []);
    expect(empty).toBe(bare);
  });

  it('偽 provider の欠落が3面に同じ文言で出る', async () => {
    const gaps = describeProviderGaps({ ...ALL_CLAUDE, clone: FAKE });
    expect(gaps).toHaveLength(1);
    const line = gaps[0] as string;
    expect(buildSelfKnowledge({ ...SELF, providerGaps: gaps })).toContain(line);
    expect(describeCloneRuntime({ ...runtimeFacts(), providerGaps: gaps })).toContain(line);
    const digest = await buildActivityDigest(
      createMemoryStores(),
      WINDOW,
      undefined,
      undefined,
      gaps,
    );
    expect(digest).toContain(line);
  });

  it('self_status の項目行（"- " 始まり）は欠落の行で増えない', () => {
    const gaps = describeProviderGaps({
      ...ALL_CLAUDE,
      clone: { displayName: '無', capabilities: NO_CAPABILITIES },
    });
    const items = (s: string) => s.split('\n').filter((l) => l.startsWith('- '));
    expect(items(describeCloneRuntime({ ...runtimeFacts(), providerGaps: gaps }))).toEqual(
      items(describeCloneRuntime(runtimeFacts())),
    );
  });
});
