import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  AGENT_PROVIDER_IDS,
  NO_CAPABILITIES,
  REQUIREMENT_BEARING_CAPABILITIES,
  missingRequirementCapabilities,
  type AgentCapabilities,
} from './agent-ports.js';

describe('missingRequirementCapabilities', () => {
  it('要件担当の capability が全部 true なら空配列を返す', () => {
    const all: AgentCapabilities = { ...NO_CAPABILITIES };
    for (const key of REQUIREMENT_BEARING_CAPABILITIES) all[key] = true;

    expect(missingRequirementCapabilities(all)).toEqual([]);
  });

  it('いくつか false なら、該当するキーを REQUIREMENT_BEARING_CAPABILITIES の順で返す', () => {
    const capabilities: AgentCapabilities = {
      ...NO_CAPABILITIES,
      permissions: true,
      toolAudit: true,
      compactionHook: true,
      resume: true,
      sessionLog: false,
      subagents: true,
      mcpServers: false,
      childUser: true,
      usage: false,
      partialMessages: true,
    };

    expect(missingRequirementCapabilities(capabilities)).toEqual([
      'sessionLog',
      'mcpServers',
      'usage',
    ]);
  });

  it('partialMessages だけが false でも空配列のまま（要件ではないから）', () => {
    const capabilities: AgentCapabilities = {
      ...NO_CAPABILITIES,
      permissions: true,
      toolAudit: true,
      compactionHook: true,
      resume: true,
      sessionLog: true,
      subagents: true,
      mcpServers: true,
      childUser: true,
      usage: true,
      partialMessages: false,
    };

    expect(missingRequirementCapabilities(capabilities)).toEqual([]);
  });

  it('AGENT_PROVIDER_IDS は claude と codex を持つ（出所はここ1つ）', () => {
    expect(AGENT_PROVIDER_IDS).toEqual(['claude', 'codex']);
  });
});

describe('agent-ports.ts の中立性（番人テスト）', () => {
  it('@anthropic-ai/claude-agent-sdk を import していない', () => {
    const path = fileURLToPath(new URL('./agent-ports.ts', import.meta.url));
    const source = readFileSync(path, 'utf8');

    expect(source).not.toContain('@anthropic-ai/claude-agent-sdk');
  });
});
