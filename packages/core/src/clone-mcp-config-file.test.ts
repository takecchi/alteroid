import { createSdkMcpServer, query } from '@anthropic-ai/claude-agent-sdk';
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';

import { buildCloneSessionOptions } from './claude-provider.js';
import {
  splitInProcessMcpServers,
  stageCloneMcpServers,
  writeCloneMcpConfigFile,
} from './clone-mcp-config-file.js';

const inproc = { type: 'sdk', name: 'alteroid', instance: {} } as unknown as McpServerConfig;
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
const sse: McpServerConfig = {
  type: 'sse',
  url: 'https://example.invalid/sse',
  headers: { Authorization: 'dummy-secret-sse' },
};

describe('splitInProcessMcpServers', () => {
  it('sdk かつ instance を持つものだけがインプロセスに残り、stdio・http・sse は外へ出る', () => {
    const { inProcess, external } = splitInProcessMcpServers({
      own: inproc,
      a: stdio,
      b: http,
      c: sse,
    });
    expect(Object.keys(inProcess)).toEqual(['own']);
    expect(Object.keys(external)).toEqual(['a', 'b', 'c']);
  });

  it('instance を持たない sdk 形は外へ出る', () => {
    const bare = { type: 'sdk', name: 'n' } as unknown as McpServerConfig;
    const { inProcess, external } = splitInProcessMcpServers({ bare });
    expect(inProcess).toEqual({});
    expect(Object.keys(external)).toEqual(['bare']);
  });
});

describe('writeCloneMcpConfigFile', () => {
  it('{ mcpServers } の JSON を 0600 のファイルへ、0700 のディレクトリの中に書き、remove はディレクトリごと消して冪等', () => {
    const file = writeCloneMcpConfigFile({ a: stdio, b: http });
    expect(file).toBeDefined();
    const { path, remove } = file!;
    try {
      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ mcpServers: { a: stdio, b: http } });
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
    } finally {
      remove();
    }
    expect(existsSync(dirname(path))).toBe(false);
    expect(() => remove()).not.toThrow();
  });

  it('外へ出すものが無ければファイルを作らない', () => {
    expect(writeCloneMcpConfigFile({})).toBeUndefined();
    expect(stageCloneMcpServers({ own: inproc }).file).toBeUndefined();
  });
});

describe('実物の SDK: buildCloneSessionOptions の結果を渡しても資格は argv に載らない', () => {
  it('偽の spawn が受けた args に資格が無く、--mcp-config は1回だけでその次がファイルのパスである', async () => {
    // 偽の instance では SDK が connect を呼んで落ちる: 実物のインプロセスサーバを使う
    const real = createSdkMcpServer({ name: 'alteroid', tools: [] });
    const staged = stageCloneMcpServers({ alteroid: real, a: stdio, b: http, c: sse });
    expect(staged.file).toBeDefined();
    const file = staged.file!;
    let captured: string[] | undefined;
    let onSpawned: () => void = () => undefined;
    const spawned = new Promise<void>((resolve) => {
      onSpawned = resolve;
    });
    const noop = async () => ({ continue: true }) as never;
    const options = buildCloneSessionOptions({
      model: 'opus',
      permissionMode: 'auto',
      mcpServer: real,
      externalMcpServers: { a: stdio, b: http, c: sse },
      mcpConfigPath: file.path,
      systemPrompt: 'sp',
      env: {},
      resume: null,
      onPreToolUse: noop,
      onPreCompact: async () => undefined,
      onPostToolUse: async () => undefined,
      onPostToolUseFailure: async () => undefined,
      onSubagentStop: async () => undefined,
    });
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
      for (const secret of ['dummy-secret-stdio', 'dummy-secret-http', 'dummy-secret-sse']) {
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
