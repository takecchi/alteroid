import type { HookCallback, McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// 印そのものだけを差し替える: 見張りの本体は使わない
const phases = vi.hoisted(() => [] as string[]);
vi.mock('./loop-stall.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./loop-stall.js')>()),
  notePhase: (label: string) => {
    phases.push(label);
  },
}));

const { buildCloneSessionOptions } = await import('./claude-provider.js');
const { DEFAULT_PERMISSION_MODE } = await import('./permission-mode.js');
const { withToolPhases } = await import('./tools.js');

const mcpServer = { type: 'sdk', name: 'test', instance: {} } as unknown as McpServerConfig;

type ToolHandler = (args: never, extra: unknown) => Promise<unknown>;

async function invokeHook(hook: HookCallback | undefined, input: unknown): Promise<unknown> {
  if (hook === undefined) throw new Error('hook が登録されていない');
  return hook(input as never, 'tool-use-id', { signal: new AbortController().signal });
}

function cloneOptions(onPostToolUse: () => Promise<void> | void = () => {}) {
  return buildCloneSessionOptions({
    model: 'fable',
    permissionMode: DEFAULT_PERMISSION_MODE,
    mcpServer,
    systemPrompt: 'システムプロンプト',
    env: {},
    resume: null,
    onPreCompact: () => {},
    onPostToolUse,
    onPostToolUseFailure: () => {},
    onPreToolUse: () => ({ kind: 'continue' }),
    onSubagentStop: () => {},
  });
}

beforeEach(() => {
  phases.length = 0;
});

// 2026-10-12T00:31Z の `loop-stall` は「直前の印: clone:rate_limit」の後、クローンの Bash の PostToolUse まで印が無く、
// 止めていたのがフックに届く前か、フックの中かを分けられなかった（#4485）。
describe('ループの停止の見張りの印（#4485）', () => {
  it('PostToolUse は入口（道具名と出力の文字数）と出口の印を打ち、フックの処理はその間に入る', async () => {
    const options = cloneOptions(() => {
      phases.push('inside');
    });
    await invokeHook(options.hooks?.PostToolUse?.[0]?.hooks[0], {
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'gh pr view 936' },
      tool_response: { stdout: 'x'.repeat(1200), stderr: 'yy', interrupted: false },
    });
    expect(phases).toEqual([
      'sdk-hook:PostToolUse:Bash:1202ch',
      'inside',
      'sdk-hook-done:PostToolUse',
    ]);
  });

  it('フックが投げても出口の印を打つ', async () => {
    const options = cloneOptions(() => {
      throw new Error('boom');
    });
    await expect(
      invokeHook(options.hooks?.PostToolUse?.[0]?.hooks[0], { tool_name: 'Read' }),
    ).rejects.toThrow('boom');
    expect(phases).toEqual(['sdk-hook:PostToolUse:Read', 'sdk-hook-done:PostToolUse']);
  });

  it('PreToolUse も入口と出口の印を打つ', async () => {
    const options = cloneOptions();
    await invokeHook(options.hooks?.PreToolUse?.[0]?.hooks[0], {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
    });
    expect(phases).toEqual(['sdk-hook:PreToolUse:Bash', 'sdk-hook-done:PreToolUse']);
  });

  it('自作ツールは入口と出口の印を打ち、結果はそのまま返す。投げても出口の印を打つ', async () => {
    // 型は SDK の道具の形（args・extra を受ける）に揃える
    const [ok, ng] = withToolPhases<{ name: string; handler: ToolHandler }>([
      {
        name: 'manager_list',
        handler: async () => {
          phases.push('inside');
          return { content: [] };
        },
      },
      {
        name: 'journal_search',
        handler: async () => {
          throw new Error('boom');
        },
      },
    ]);
    await expect(ok!.handler(undefined as never, undefined)).resolves.toEqual({ content: [] });
    await expect(ng!.handler(undefined as never, undefined)).rejects.toThrow('boom');
    expect(phases).toEqual([
      'clone-tool:manager_list',
      'inside',
      'clone-tool-done:manager_list',
      'clone-tool:journal_search',
      'clone-tool-done:journal_search',
    ]);
  });
});
