import type {
  CanUseTool,
  McpServerConfig,
  Options,
  SessionStore,
} from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import type {
  AgentContextHook,
  AgentPreCompactRecord,
  AgentPreToolHook,
  AgentStopRecord,
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

/**
 * `skills: 'all'` の**字義**を、Options を組み立てる3つの口すべてで固定する。
 *
 * ここで確かめたいのは「SDK へ渡す `Options` に `skills: 'all'` が載っている
 * こと」だけである。**SDK が実際にそれをどう解釈し、どのスキルを引けるかは
 * 実機の話で、ここの対象ではない**（この層のテストでは固定できない）。
 *
 * `agent-session-options.test.ts` は「リファクタしても1文字も変わらないこと」を
 * 目標に据えた特性試験なので、そちらへ足さずにここへ置く。
 */

// **観測専用フックへ渡す中立の noop。** `onPostToolUse` / `onPostToolUseFailure` /
// `onPreCompact` / `onUserPromptSubmit` / `onStop` のうち中立の型
// （`AgentObservationHook`）へ移した欄はこちらを渡す（`onSubagentStop` と
// `ManagerSessionOptionsRequest.onPostToolUse` は文脈を返しうるので
// `AgentContextHook` の `noopContextHook` を渡す。#486 中立の口の4本目）。
const noopAuditHook: (record: AgentToolAuditRecord) => void = () => undefined;
const noopAuditFailureHook: (record: AgentToolAuditFailureRecord) => void = () => undefined;
const noopPreCompactHook: (record: AgentPreCompactRecord) => void = () => undefined;
const noopUserPromptSubmitHook: (record: AgentUserPromptSubmitRecord) => void = () => undefined;
const noopStopHook: (record: AgentStopRecord) => void = () => undefined;
// `onPreToolUse` は判断を返す中立の型（`AgentPreToolHook`）へ移した
// （#486 中立の口の3本目）——`AgentObservationHook` ではないので上の並びとは
// 別に持つ。
const noopPreToolHook: AgentPreToolHook = () => ({ kind: 'continue' });
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
    // `AgentDefinition.skills` は `'all'` を受けず名前の配列しか取れない。書けば
    // 「明示リストで絞る」（AGENTS.md 地雷1）になり、スキルが増えても追いつかない。
    // しかもあちらは *preload* なので、書いた分だけ作業者の文脈へ先に載る
    // ＝ 畳んだ意味が消える。だから**キー自体が無い**ことを見る
    // （`undefined` を明示的に持つのでもなく、無い）。
    expect(worker !== undefined && 'skills' in worker).toBe(false);
  });
});
