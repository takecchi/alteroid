import type {
  CanUseTool,
  HookCallback,
  McpServerConfig,
  Options,
  SessionStore,
} from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

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

const noopHook: HookCallback = async () => ({});
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
    onPreCompact: noopHook,
    onPostToolUse: noopHook,
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
    onPostToolUse: noopHook,
    onPreCompact: noopHook,
    onUserPromptSubmit: noopHook,
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
      onPostToolUse: noopHook,
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
