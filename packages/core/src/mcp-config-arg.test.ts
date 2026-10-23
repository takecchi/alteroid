import { query } from '@anthropic-ai/claude-agent-sdk';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';

import { relocateMcpConfigArgs } from './mcp-config-arg.js';

describe('実物の SDK: mcpServers は CLI の --mcp-config の引数として渡る', () => {
  // SDK が資格を載せる口を別の形（環境変数・stdin）へ変えたら、差し替えが空振りしていることに気づくための歯
  it('spawnClaudeCodeProcess の args に JSON の --mcp-config が現れ、差し替えると資格が消える', async () => {
    let captured: string[] | undefined;
    let onSpawned: () => void = () => undefined;
    const spawned = new Promise<void>((resolve) => {
      onSpawned = resolve;
    });
    const q = query({
      prompt: 'x',
      options: {
        pathToClaudeCodeExecutable: '/nonexistent/claude',
        mcpServers: {
          probe: { command: 'x', env: { TOKEN: 'dummy-secret-sdk-tooth' } },
        },
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
    // 偽の子は初期化に応えない: 読み切るのを待たず、起動時の引数が取れたところで閉じる
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
    expect(captured).toBeDefined();
    const args = captured as string[];
    expect(args.join('\n')).toContain('dummy-secret-sdk-tooth');

    const written: string[] = [];
    const relocated = relocateMcpConfigArgs(args, (json) => {
      written.push(json);
      return '/run/mcp.json';
    });
    expect(written).toHaveLength(1);
    expect(written[0]).toContain('dummy-secret-sdk-tooth');
    expect(relocated.join('\n')).not.toContain('dummy-secret-sdk-tooth');
  });
});

const SECRET_JSON = '{"mcpServers":{"x":{"env":{"TOKEN":"dummy-secret-aaa"}}}}';

function recorder(): { written: string[]; write: (json: string) => string } {
  const written: string[] = [];
  return {
    written,
    write: (json) => {
      written.push(json);
      return `/run/mcp-${String(written.length)}.json`;
    },
  };
}

describe('relocateMcpConfigArgs: --mcp-config の JSON を argv から外す', () => {
  it('2引数の形を、書き手が返したパスへ差し替える', () => {
    const r = recorder();
    const out = relocateMcpConfigArgs(
      ['--print', '--mcp-config', SECRET_JSON, '--verbose'],
      r.write,
    );
    expect(out).toEqual(['--print', '--mcp-config', '/run/mcp-1.json', '--verbose']);
    expect(r.written).toEqual([SECRET_JSON]);
    expect(out.join('\n')).not.toContain('dummy-secret-aaa');
  });

  it('`--mcp-config=` の1引数の形も差し替える', () => {
    const r = recorder();
    const out = relocateMcpConfigArgs(['a', `--mcp-config=${SECRET_JSON}`, 'b'], r.write);
    expect(out).toEqual(['a', '--mcp-config=/run/mcp-1.json', 'b']);
    expect(r.written).toEqual([SECRET_JSON]);
    expect(out.join('\n')).not.toContain('dummy-secret-aaa');
  });

  it('--mcp-config が無ければ配列をそのままの中身で返し、何も書かない', () => {
    const r = recorder();
    const args = ['--print', '--model', 'x'];
    expect(relocateMcpConfigArgs(args, r.write)).toEqual(args);
    expect(r.written).toEqual([]);
  });

  it('既にパスのものは触らない（2つの形とも）', () => {
    const r = recorder();
    const args = ['--mcp-config', '/etc/mcp.json', '--mcp-config=/etc/other.json'];
    expect(relocateMcpConfigArgs(args, r.write)).toEqual(args);
    expect(r.written).toEqual([]);
  });

  it('複数あれば全部を処理し、他の引数の順序と値は変えない', () => {
    const r = recorder();
    const second = '{"mcpServers":{"y":{"headers":{"Authorization":"dummy-secret-bbb"}}}}';
    const args = [
      '-p',
      '--mcp-config',
      SECRET_JSON,
      '--x',
      '--mcp-config',
      '/p.json',
      `--mcp-config=${second}`,
      'z',
    ];
    const out = relocateMcpConfigArgs(args, r.write);
    expect(out).toEqual([
      '-p',
      '--mcp-config',
      '/run/mcp-1.json',
      '--x',
      '--mcp-config',
      '/p.json',
      '--mcp-config=/run/mcp-2.json',
      'z',
    ]);
    expect(r.written).toEqual([SECRET_JSON, second]);
    expect(out.join('\n')).not.toContain('dummy-secret');
  });

  it('末尾の値の無い --mcp-config はそのまま残す', () => {
    const r = recorder();
    expect(relocateMcpConfigArgs(['--mcp-config'], r.write)).toEqual(['--mcp-config']);
  });

  it('書き手が投げたら握り潰さず投げる', () => {
    expect(() =>
      relocateMcpConfigArgs(['--mcp-config', SECRET_JSON], () => {
        throw new Error('disk full');
      }),
    ).toThrow('disk full');
  });
});
