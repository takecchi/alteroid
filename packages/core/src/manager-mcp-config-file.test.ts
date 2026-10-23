import { createSdkMcpServer, query } from '@anthropic-ai/claude-agent-sdk';
import type { CanUseTool, McpServerConfig, SessionStore } from '@anthropic-ai/claude-agent-sdk';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';

import { buildManagerSessionOptions } from './claude-provider.js';
import { stageCloneMcpServers } from './clone-mcp-config-file.js';

const stdio: McpServerConfig = {
  type: 'stdio',
  command: 'x',
  env: { TOKEN: 'dummy-secret-stdio' },
};
const http: McpServerConfig = {
  type: 'http',
  url: 'https://example.invalid/mcp',
  headers: { Authorization: 'dummy-secret-http' },
};
const noop = async (): Promise<{ kind: 'continue' }> => ({ kind: 'continue' });

function managerRequest(
  mcpServers: Record<string, McpServerConfig>,
  mcpConfigPath: string | undefined,
): Parameters<typeof buildManagerSessionOptions>[0] {
  return {
    model: 'opus',
    permissionMode: 'auto',
    systemPromptAppend: '追記',
    workerAgentName: 'worker',
    workerPrompt: '作業者のプロンプト',
    workerModel: 'sonnet',
    cwd: '/work',
    env: {},
    sessionStore: {} as unknown as SessionStore,
    canUseTool: (async () => ({ behavior: 'allow', updatedInput: {} })) as unknown as CanUseTool,
    onPostToolUse: noop,
    onPostToolUseFailure: () => undefined,
    onPreCompact: () => undefined,
    onUserPromptSubmit: () => undefined,
    onSubagentStop: noop,
    onStop: () => undefined,
    onPreToolUse: () => ({ kind: 'continue' }),
    onPermissionDenied: async () => ({ kind: 'no-retry' }),
    managerAutoMemoryEnabled: false,
    mcpServers,
    ...(mcpConfigPath === undefined ? {} : { mcpConfigPath }),
  };
}

describe('buildManagerSessionOptions: mcpConfigPath', () => {
  it('在れば mcpServers はインプロセスだけで、extraArgs の mcp-config がそのパスを指す', () => {
    const real = createSdkMcpServer({ name: 'own', tools: [] });
    const options = buildManagerSessionOptions(
      managerRequest({ own: real, a: stdio, b: http }, '/run/mcp-config.json'),
    );
    expect(Object.keys(options.mcpServers ?? {})).toEqual(['own']);
    expect(options.extraArgs).toEqual({ 'mcp-config': '/run/mcp-config.json' });
  });

  it('インプロセスが無ければ mcpServers の欄ごと省く', () => {
    const options = buildManagerSessionOptions(
      managerRequest({ a: stdio }, '/run/mcp-config.json'),
    );
    expect('mcpServers' in options).toBe(false);
    expect(options.extraArgs).toEqual({ 'mcp-config': '/run/mcp-config.json' });
  });

  it('無ければ今までどおり mcpServers に全部載り、extraArgs は付かない', () => {
    const options = buildManagerSessionOptions(managerRequest({ a: stdio }, undefined));
    expect(Object.keys(options.mcpServers ?? {})).toEqual(['a']);
    expect(options.extraArgs).toBeUndefined();
  });
});

describe('実物の SDK: buildManagerSessionOptions の結果を渡しても資格は argv に載らない', () => {
  it('偽の spawn が受けた args に資格が無く、--mcp-config は1回だけでその次がファイルのパスである', async () => {
    const real = createSdkMcpServer({ name: 'own', tools: [] });
    const staged = stageCloneMcpServers({ own: real, a: stdio, b: http });
    expect(staged.file).toBeDefined();
    const file = staged.file!;
    let captured: string[] | undefined;
    let onSpawned: () => void = () => undefined;
    const spawned = new Promise<void>((resolve) => {
      onSpawned = resolve;
    });
    const options = buildManagerSessionOptions(
      managerRequest({ own: real, a: stdio, b: http }, file.path),
    );
    const q = query({
      prompt: 'x',
      options: {
        ...options,
        pathToClaudeCodeExecutable: '/nonexistent/claude',
        spawnClaudeCodeProcess: (spawnOptions) => {
          captured = spawnOptions.args;
          onSpawned();
          const stdout = new PassThrough();
          queueMicrotask(() => stdout.end());
          return {
            stdin: new PassThrough(),
            stdout,
            killed: false,
            exitCode: null,
            signalCode: null,
            kill: () => true,
            on: () => {},
            once: () => {},
            off: () => {},
          };
        },
      },
    });
    const drained = (async () => {
      try {
        for await (const message of q) void message;
      } catch {
        // 閉じた後の失敗は見たいものではない
      }
    })();
    // 実時間で回して待たない（`wallclock-waits-baseline.json`）: 起こされた瞬間に解ける約束で待つ
    await spawned;
    q.close();
    await drained;
    try {
      expect(captured).toBeDefined();
      const args = captured as string[];
      const joined = args.join('\n');
      for (const secret of ['dummy-secret-stdio', 'dummy-secret-http']) {
        expect(joined).not.toContain(secret);
      }
      const indexes = args.flatMap((arg, i) => (arg === '--mcp-config' ? [i] : []));
      expect(indexes).toHaveLength(1);
      expect(args[indexes[0]! + 1]).toBe(file.path);
      expect(args.some((arg) => arg.startsWith('--mcp-config='))).toBe(false);
    } finally {
      file.remove();
    }
  });
});
