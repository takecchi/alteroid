import { realpathSync } from 'node:fs';
import { createConnection } from 'node:net';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import {
  CLONE_TOOL_RELAY_SOCKET_ENV,
  CLONE_TOOL_RELAY_TOKEN_ENV,
} from './clone-tool-relay-protocol.js';
import { reasonOf } from './dropped-record.js';

export { CLONE_TOOL_RELAY_SOCKET_ENV, CLONE_TOOL_RELAY_TOKEN_ENV };

export interface CloneToolRelayChildIo {
  stdin: NodeJS.ReadableStream;
  stdout: NodeJS.WritableStream;
}

export async function runCloneToolRelayChild(
  env: NodeJS.ProcessEnv,
  io: CloneToolRelayChildIo,
  connect: (socketPath: string) => NodeJS.ReadWriteStream = (socketPath) =>
    createConnection({ path: socketPath }),
): Promise<void> {
  const socketPath = env[CLONE_TOOL_RELAY_SOCKET_ENV];
  const token = env[CLONE_TOOL_RELAY_TOKEN_ENV];
  if (socketPath === undefined || socketPath === '') {
    throw new Error(`${CLONE_TOOL_RELAY_SOCKET_ENV} が渡っていない`);
  }
  if (token === undefined || token === '') {
    throw new Error(`${CLONE_TOOL_RELAY_TOKEN_ENV} が渡っていない`);
  }

  const socket = connect(socketPath);
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  socket.write(`${token}\n`);

  // 手で on('data') を書かず pipe() に任せる: バックプレッシャの処理を自前で再実装することになるため
  io.stdin.pipe(socket);
  socket.pipe(io.stdout);

  await new Promise<void>((resolve) => {
    socket.once('close', resolve);
    socket.once('error', resolve);
  });
}

function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  runCloneToolRelayChild(process.env, { stdin: process.stdin, stdout: process.stdout }).catch(
    (error: unknown) => {
      process.stderr.write(`alteroid-clone-tool-relay: ${reasonOf(error)}\n`);
      process.exit(1);
    },
  );
}
