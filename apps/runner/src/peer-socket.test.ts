import { existsSync, statSync } from 'node:fs';
import { createConnection } from 'node:net';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { makeTempDirSync } from '../../../vitest.tmpdir.js';
import { PEER_SOCKET_FILENAME, type PeerSocketHost } from '@alteroid/core';
import { planPeerSocket } from './peer-socket.js';

describe('planPeerSocket（マネージャーの peer 専用ソケット。開く条件は Codex の資格。#4118）', () => {
  let opened: PeerSocketHost | undefined;
  afterEach(() => {
    opened?.close();
    opened = undefined;
  });

  it('起動時にはソケットを作らない（資格が届いて Host が開くまで）', () => {
    const dir = join(makeTempDirSync('peer-sock-'), 'peer');
    const plan = planPeerSocket({}, undefined, dir);
    expect(plan.models).toEqual({});
    expect(existsSync(dir)).toBe(false);
  });

  it('旧い ALTEROID_MANAGER_PEERS は読まない（置かれていてもソケットを作らない）', () => {
    const dir = join(makeTempDirSync('peer-sock-'), 'peer');
    planPeerSocket({ ALTEROID_MANAGER_PEERS: 'codex' }, undefined, dir);
    expect(existsSync(dir)).toBe(false);
  });

  it('開く口を呼ぶと、0711 のディレクトリに 0600 のソケットを作る', async () => {
    const dir = join(makeTempDirSync('peer-sock-'), 'peer');
    opened = await planPeerSocket({}, undefined, dir).openSocket();
    const path = join(dir, PEER_SOCKET_FILENAME);
    expect(opened.socketPath).toBe(path);
    expect(statSync(dir).mode & 0o777).toBe(0o711);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('資格で開くことと、開けたモデルの一覧を起動時に1行で言う（#3934）', () => {
    const plan = planPeerSocket(
      { ALTEROID_MANAGER_PEER_CODEX_MODELS: 'gpt-5.5,gpt-5.5-codex' },
      undefined,
      '/nonexistent',
    );
    expect(plan.models).toEqual({ codex: ['gpt-5.5', 'gpt-5.5-codex'] });
    expect(plan.notices).toHaveLength(1);
    expect(plan.notices[0]).toContain('資格');
    expect(plan.notices[0]).toContain('名指しできるモデル: gpt-5.5, gpt-5.5-codex');
    expect(planPeerSocket({}, undefined, '/nonexistent').notices[0]).toContain(
      '名指しできるモデル: 無し',
    );
  });

  it('モデルの一覧の綴りが不正なら、起動時に例外で止める', () => {
    const dir = join(makeTempDirSync('peer-sock-'), 'peer');
    expect(() =>
      planPeerSocket({ ALTEROID_MANAGER_PEER_CODEX_MODELS: 'gpt-5.5,,' }, undefined, dir),
    ).toThrow(/空の要素/);
    expect(existsSync(dir)).toBe(false);
  });

  it('token が一致しない接続は即切断する（使い捨て token だけが通る）', async () => {
    const dir = join(makeTempDirSync('peer-sock-'), 'peer');
    opened = await planPeerSocket({}, undefined, dir).openSocket();
    const socket = createConnection({ path: join(dir, PEER_SOCKET_FILENAME) });
    await new Promise<void>((resolve) => socket.once('connect', resolve));
    socket.write('wrong-token\n');
    await new Promise<void>((resolve) => socket.once('close', resolve));
  });
});
