import { existsSync, statSync } from 'node:fs';
import { createConnection } from 'node:net';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { makeTempDirSync } from '../../../vitest.tmpdir.js';
import { PEER_SOCKET_FILENAME } from '@alteroid/core';
import { openPeerSocket, type PeerSocketOpening } from './peer-socket.js';

describe('openPeerSocket（マネージャーの peer 専用ソケット）', () => {
  let opened: PeerSocketOpening | undefined;
  afterEach(() => {
    opened?.host?.close();
    opened = undefined;
  });

  it('PEERS が未設定・空なら、ソケットを作らず何も言わない', async () => {
    for (const env of [{}, { ALTEROID_MANAGER_PEERS: '' }, { ALTEROID_MANAGER_PEERS: '  ' }]) {
      const dir = join(makeTempDirSync('peer-sock-'), 'peer');
      const result = await openPeerSocket(env, undefined, dir);
      expect(result.host).toBeUndefined();
      expect(result.peers).toEqual([]);
      expect(result.notices).toEqual([]);
      expect(existsSync(dir)).toBe(false);
    }
  });

  it('PEERS が開いていれば、0711 のディレクトリに 0600 のソケットを作る', async () => {
    const dir = join(makeTempDirSync('peer-sock-'), 'peer');
    opened = await openPeerSocket({ ALTEROID_MANAGER_PEERS: 'codex' }, undefined, dir);
    expect(opened.peers).toEqual(['codex']);
    const path = join(dir, PEER_SOCKET_FILENAME);
    expect(opened.host?.socketPath).toBe(path);
    expect(statSync(dir).mode & 0o777).toBe(0o711);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('自分の層の provider だけが書かれていたら、閉じたまま理由を言う', async () => {
    const dir = join(makeTempDirSync('peer-sock-'), 'peer');
    const result = await openPeerSocket({ ALTEROID_MANAGER_PEERS: 'claude' }, undefined, dir);
    expect(result.host).toBeUndefined();
    expect(result.notices).toHaveLength(1);
    expect(result.notices[0]).toContain('自分の層');
  });

  it('不正な値は例外で止める', async () => {
    await expect(
      openPeerSocket({ ALTEROID_MANAGER_PEERS: 'gemini' }, undefined, '/nonexistent'),
    ).rejects.toThrow(/不正/);
  });

  it('token が一致しない接続は即切断する（使い捨て token だけが通る）', async () => {
    const dir = join(makeTempDirSync('peer-sock-'), 'peer');
    opened = await openPeerSocket({ ALTEROID_MANAGER_PEERS: 'codex' }, undefined, dir);
    const socket = createConnection({ path: join(dir, PEER_SOCKET_FILENAME) });
    await new Promise<void>((resolve) => socket.once('connect', resolve));
    socket.write('wrong-token\n');
    await new Promise<void>((resolve) => socket.once('close', resolve));
  });
});
