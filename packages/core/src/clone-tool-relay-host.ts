import { randomBytes } from 'node:crypto';
import { chmodSync, chownSync, mkdirSync, rmSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { dirname } from 'node:path';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { noteBackgroundFailure } from './dropped-record.js';

export interface CloneToolRelayHost {
  readonly socketPath: string;
  // McpServer をファクトリで受ける: 子が実際に繋いでくるまで、道具と ToolContext を含む重い構築をしないため
  register(mcpServer: () => McpServer, options?: { timeoutMs?: number }): string;
  close(): void;
}

export const DEFAULT_REGISTRATION_TIMEOUT_MS = 30_000;

interface PendingRegistration {
  mcpServer: () => McpServer;
  timer: NodeJS.Timeout;
}

export async function createCloneToolRelayHost(options: {
  socketPath: string;
  dirMode?: number;
  socketOwner?: { uid: number; gid: number };
}): Promise<CloneToolRelayHost> {
  const { socketPath } = options;
  const dirMode = options.dirMode ?? 0o700;
  const pending = new Map<string, PendingRegistration>();

  const dir = dirname(socketPath);
  mkdirSync(dir, { recursive: true, mode: dirMode });
  // chmodSync も呼ぶ: mkdirSync の mode は新規作成のときにしか効かないため
  chmodSync(dir, dirMode);

  rmSync(socketPath, { force: true });

  const server: Server = createServer((socket) => {
    handleConnection(socket).catch((error: unknown) => {
      noteBackgroundFailure('clone-tool-relay の接続', '', error);
      socket.destroy();
    });
  });

  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  if (options.socketOwner !== undefined) {
    chownSync(socketPath, options.socketOwner.uid, options.socketOwner.gid);
  }
  chmodSync(socketPath, 0o600);

  async function handleConnection(socket: Socket): Promise<void> {
    const token = await readToken(socket);
    if (token === undefined) return;
    const found = pending.get(token);
    if (found === undefined) {
      socket.destroy();
      return;
    }
    pending.delete(token);
    clearTimeout(found.timer);
    const instance = found.mcpServer();
    await instance.connect(new StdioServerTransport(socket, socket));
    // connect の後で resume() する: readToken が pause したまま渡してくるので、StdioServerTransport が data リスナーを張った後に再開しないと、unshift で押し戻した分が二度と流れないため
    socket.resume();
  }

  return {
    socketPath,
    register(mcpServer, registerOptions) {
      const token = randomBytes(32).toString('hex');
      const timeoutMs = registerOptions?.timeoutMs ?? DEFAULT_REGISTRATION_TIMEOUT_MS;
      const timer = setTimeout(() => {
        pending.delete(token);
      }, timeoutMs);
      timer.unref();
      pending.set(token, { mcpServer, timer });
      return token;
    },
    close() {
      for (const { timer } of pending.values()) clearTimeout(timer);
      pending.clear();
      server.close();
      rmSync(socketPath, { force: true });
    },
  };
}

function readToken(socket: Socket): Promise<string | undefined> {
  return new Promise((resolve) => {
    let buffer = Buffer.alloc(0);
    const cleanup = (): void => {
      socket.off('data', onData);
      socket.off('close', onEnd);
      socket.off('error', onEnd);
      // pause() する: listener が0本のまま flowing だと、新しい消費者が繋がるまでの隙でバイトが消えるため
      socket.pause();
    };
    const onData = (chunk: Buffer): void => {
      buffer = Buffer.concat([buffer, chunk]);
      const index = buffer.indexOf('\n');
      if (index === -1) return;
      const line = buffer.toString('utf8', 0, index).replace(/\r$/, '');
      const rest = buffer.subarray(index + 1);
      cleanup();
      if (rest.length > 0) socket.unshift(rest);
      resolve(line);
    };
    const onEnd = (): void => {
      cleanup();
      resolve(undefined);
    };
    socket.on('data', onData);
    socket.on('close', onEnd);
    socket.on('error', onEnd);
  });
}
