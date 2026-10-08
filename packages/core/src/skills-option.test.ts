import type {
  CanUseTool,
  McpServerConfig,
  Options,
  SessionStore,
} from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import type {
  AgentContextHook,
  AgentPermissionDeniedHook,
  AgentPreCompactRecord,
  AgentPreToolHook,
  AgentStopRecord,
  AgentSubagentStopRecord,
  AgentToolAuditFailureRecord,
  AgentToolAuditRecord,
  AgentUserPromptSubmitRecord,
} from './agent-hooks.js';
import {
  buildCloneDistillOptions,
  buildCloneSessionOptions,
  buildManagerSessionOptions,
} from './claude-provider.js';
import { DEFAULT_PERMISSION_MODE } from './permission-mode.js';
import { WORKER_AGENT_NAME } from './runner.js';

const noopAuditHook: (record: AgentToolAuditRecord) => void = () => undefined;
const noopAuditFailureHook: (record: AgentToolAuditFailureRecord) => void = () => undefined;
const noopPreCompactHook: (record: AgentPreCompactRecord) => void = () => undefined;
const noopUserPromptSubmitHook: (record: AgentUserPromptSubmitRecord) => void = () => undefined;
const noopStopHook: (record: AgentStopRecord) => void = () => undefined;
const noopSubagentStopObservationHook: (record: AgentSubagentStopRecord) => void = () => undefined;
const noopPreToolHook: AgentPreToolHook = () => ({ kind: 'continue' });
const noopPermissionDeniedHook: AgentPermissionDeniedHook = async () => ({ kind: 'no-retry' });
const noopContextHook: AgentContextHook<unknown> = () => ({ kind: 'continue' });
const mcpServer = { type: 'sdk', name: 'test', instance: {} } as unknown as McpServerConfig;
const sessionStore = {} as unknown as SessionStore;
const canUseTool = (async () => ({ behavior: 'allow', updatedInput: {} })) as unknown as CanUseTool;

function cloneOptions(): Options {
  return buildCloneSessionOptions({
    model: 'fable',
    permissionMode: DEFAULT_PERMISSION_MODE,
    mcpServer,
    systemPrompt: 'システムプロンプト',
    env: {},
    resume: null,
    onPreCompact: noopPreCompactHook,
    onPostToolUse: noopAuditHook,
    onPostToolUseFailure: noopAuditFailureHook,
    onPreToolUse: noopPreToolHook,
    onSubagentStop: noopSubagentStopObservationHook,
  });
}

function managerOptions(): Options {
  return buildManagerSessionOptions({
    model: 'opus',
    permissionMode: DEFAULT_PERMISSION_MODE,
    systemPromptAppend: '追記',
    workerAgentName: WORKER_AGENT_NAME,
    workerPrompt: '作業者のプロンプト',
    workerModel: 'sonnet',
    cwd: '/work',
    env: {},
    sessionStore,
    canUseTool,
    onPostToolUse: noopContextHook,
    onPostToolUseFailure: noopAuditFailureHook,
    onPreCompact: noopPreCompactHook,
    onUserPromptSubmit: noopUserPromptSubmitHook,
    onSubagentStop: noopContextHook,
    onStop: noopStopHook,
    onPreToolUse: noopPreToolHook,
    onPermissionDenied: noopPermissionDeniedHook,
    managerAutoMemoryEnabled: false,
  });
}

describe("skills: 'all' の字義（Options を組み立てる3つの口）", () => {
  it('クローンの本セッションに載る', () => {
    expect(cloneOptions().skills).toBe('all');
  });

  it('蒸留のターンにも載る（本セッションと道具を揃えてある）', () => {
    const options = buildCloneDistillOptions({
      model: 'fable',
      permissionMode: DEFAULT_PERMISSION_MODE,
      mcpServer,
      systemPrompt: 'システムプロンプト',
      env: {},
      onPostToolUse: noopAuditHook,
      onPostToolUseFailure: noopAuditFailureHook,
    });

    expect(options.skills).toBe('all');
  });

  it('マネージャーに載る', () => {
    expect(managerOptions().skills).toBe('all');
  });

  it('作業者（agents）側には skills キーを置かない', () => {
    const worker = managerOptions().agents?.[WORKER_AGENT_NAME];

    expect(worker).toBeDefined();
    expect(worker !== undefined && 'skills' in worker).toBe(false);
  });
});
