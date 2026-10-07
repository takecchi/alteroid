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
