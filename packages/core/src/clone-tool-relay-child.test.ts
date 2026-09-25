import { createServer, type Server, type Socket } from 'node:net';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { afterEach, describe, expect, it } from 'vitest';

import { makeTempDirSync } from '../../../vitest.tmpdir.js';
import {
  CLONE_TOOL_RELAY_SOCKET_ENV,
  CLONE_TOOL_RELAY_TOKEN_ENV,
  runCloneToolRelayChild,
} from './clone-tool-relay-child.js';

/**
 * ここで固定するのは「中継の子プロセスは MCP を1バイトも解釈せず、
 * ただ流すだけである」こと。**実ソケットを使う**——`clone-tool-relay-host.ts`
 * が実際に相手取るのと同じ `net.Socket` を、この側は「デーモン役」として
 * 自前で listen して観測する（本物のホスト実装は使わない。ホスト側の
 * 振る舞いは `clone-tool-relay-host.test.ts` が別に固定する）。
 *
 * **一時ディレクトリは `vitest.tmpdir.ts` の `makeTempDirSync` を使う**
 * （`mkdtempSync` を直接呼ばない。`scripts/no-direct-mkdtemp.test.ts` の歯）。
 * 掃除はこのテストファイルの `afterAll` がまとめて行うので、ソケットの
 * listen を止める（`server.close()`）だけをここで行う。
 */
describe('clone-tool-relay-child（中継の子プロセスの入口）', () => {
  let server: Server | undefined;

  afterEach(() => {
    server?.close();
    server = undefined;
  });

  async function listenOnce(): Promise<{ socketPath: string; accept: Promise<Socket> }> {
    const dir = makeTempDirSync('clone-tool-relay-child-');
    const socketPath = join(dir, 's.sock');
    const accept = new Promise<Socket>((resolve) => {
      server = createServer((socket) => resolve(socket));
    });
    await new Promise<void>((resolve) => server?.listen(socketPath, resolve));
    return { socketPath, accept };
  }

  it(`${CLONE_TOOL_RELAY_SOCKET_ENV} が無ければ投げる`, async () => {
    await expect(
      runCloneToolRelayChild({ [CLONE_TOOL_RELAY_TOKEN_ENV]: 't' }, io()),
    ).rejects.toThrow(CLONE_TOOL_RELAY_SOCKET_ENV);
  });

  it(`${CLONE_TOOL_RELAY_TOKEN_ENV} が無ければ投げる`, async () => {
    await expect(
      runCloneToolRelayChild({ [CLONE_TOOL_RELAY_SOCKET_ENV]: '/tmp/x.sock' }, io()),
    ).rejects.toThrow(CLONE_TOOL_RELAY_TOKEN_ENV);
  });

  it('接続直後に token を1行、改行付きで送る', async () => {
    const { socketPath, accept } = await listenOnce();
    const done = runCloneToolRelayChild(
      { [CLONE_TOOL_RELAY_SOCKET_ENV]: socketPath, [CLONE_TOOL_RELAY_TOKEN_ENV]: 'secret-token' },
      io(),
    );

    const daemonSide = await accept;
    const firstLine = await new Promise<string>((resolve) => {
      daemonSide.once('data', (chunk: Buffer) => resolve(chunk.toString('utf8')));
    });
    expect(firstLine).toBe('secret-token\n');

    daemonSide.destroy();
    await done;
  });

  it('token の後は双方向にそのまま流す（stdin→ソケット・ソケット→stdout）', async () => {
    const { socketPath, accept } = await listenOnce();
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const done = runCloneToolRelayChild(
      { [CLONE_TOOL_RELAY_SOCKET_ENV]: socketPath, [CLONE_TOOL_RELAY_TOKEN_ENV]: 'tok' },
      { stdin, stdout },
    );

    const daemonSide = await accept;
    // 最初の1行（token）を読み捨ててから、両方向を確かめる。
    await new Promise<void>((resolve) => daemonSide.once('data', () => resolve()));

    const fromChild = new Promise<string>((resolve) => {
      daemonSide.on('data', (chunk: Buffer) => resolve(chunk.toString('utf8')));
    });
    stdin.write('hello-from-daemon-caller\n');
    expect(await fromChild).toBe('hello-from-daemon-caller\n');

    const fromDaemon = new Promise<string>((resolve) => {
      stdout.on('data', (chunk: Buffer) => resolve(chunk.toString('utf8')));
    });
    daemonSide.write('hello-from-daemon-side\n');
    expect(await fromDaemon).toBe('hello-from-daemon-side\n');

    daemonSide.destroy();
    await done;
  });
});

function io(): { stdin: PassThrough; stdout: PassThrough } {
  return { stdin: new PassThrough(), stdout: new PassThrough() };
}
