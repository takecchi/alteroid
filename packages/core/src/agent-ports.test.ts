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
      sessionLog: false, // false
      subagents: true,
      mcpServers: false, // false
      childUser: true,
      usage: false, // false
      partialMessages: true,
    };

    // REQUIREMENT_BEARING_CAPABILITIES の並び順（permissions, toolAudit,
    // compactionHook, resume, sessionLog, subagents, mcpServers, childUser,
    // usage）どおりに、false のものだけが返る。
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

  it('AGENT_PROVIDER_IDS はいまのところ claude だけを持つ', () => {
    expect(AGENT_PROVIDER_IDS).toEqual(['claude']);
  });
});

/**
 * 番人テスト: `agent-ports.ts` に `@anthropic-ai/claude-agent-sdk` の文字列が
 * 混ざっていないことを、ソースを直接読んで確かめる。
 *
 * **中立の語彙を置く場所である `agent-ports.ts` に SDK の型・定数が1つでも
 * import されると、次の provider を足すときに「Claude の形に似せて作る」以外の
 * 選択肢が無くなる。** `import type` であっても型注釈として漏れれば同じことが
 * 起きるので、コンパイル結果ではなくソーステキストそのものを検査する
 * （`.js` へコンパイルすれば型 import は消えて見えなくなるため、
 * `.ts` を直接読む必要がある）。先例は codiva の
 * `src/utils/child-env.spec.ts` にある同じ形の番人テスト（読めないので
 * ここでは形だけを真似ている）。
 */
describe('agent-ports.ts の中立性（番人テスト）', () => {
  it('@anthropic-ai/claude-agent-sdk を import していない', () => {
    const path = fileURLToPath(new URL('./agent-ports.ts', import.meta.url));
    const source = readFileSync(path, 'utf8');

    expect(source).not.toContain('@anthropic-ai/claude-agent-sdk');
  });
});
