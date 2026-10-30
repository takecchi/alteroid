import { existsSync, statSync } from 'node:fs';
import { createConnection } from 'node:net';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeTempDirSync } from '../../../vitest.tmpdir.js';
import { agentProviderOf, PEER_SOCKET_FILENAME, type PeerSocketHost } from '@alteroid/core';
import { planPeerSocket } from './peer-socket.js';

// 名指しの既定の一覧は provider の記述子が持つ（本番の `planPeerSocket` と同じ出所）
function peerDefaultModelsOf(provider: 'codex'): readonly string[] | undefined {
  return agentProviderOf(provider).defaultPeerModels;
}

// 置き場所は本番と同じ口（core の既定の置き場所）から読む。試験ではその定数だけを、1本ごとの一時ディレクトリへ差し替える。
// 値ではなく getter で返す: 既定値は呼ぶたびに読まれるので、1本ごとに別の置き場所へ向けられる。
const socketDir = vi.hoisted(() => ({ current: '' }));
vi.mock('@alteroid/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@alteroid/core')>();
  return {
    ...actual,
    get DEFAULT_PEER_SOCKET_DIR() {
      return socketDir.current;
    },
  };
});

describe('planPeerSocket（マネージャーの peer 専用ソケット。開く条件は Codex の資格。#4118）', () => {
  let opened: PeerSocketHost | undefined;
  beforeEach(() => {
    socketDir.current = join(makeTempDirSync('peer-sock-'), 'peer');
  });
  afterEach(() => {
    opened?.close();
    opened = undefined;
  });

  it('起動時にはソケットを作らない（資格が届いて Host が開くまで）', () => {
    const plan = planPeerSocket({}, undefined);
    expect(plan.models).toEqual({ codex: [...peerDefaultModelsOf('codex')!] });
    expect(existsSync(socketDir.current)).toBe(false);
  });

  it('旧い ALTEROID_MANAGER_PEERS は読まない（置かれていてもソケットを作らない）', () => {
    planPeerSocket({ ALTEROID_MANAGER_PEERS: 'codex' }, undefined);
    expect(existsSync(socketDir.current)).toBe(false);
  });

  it('開く口を呼ぶと、0711 のディレクトリに 0600 のソケットを作る', async () => {
    opened = await planPeerSocket({}, undefined).openSocket();
    const path = join(socketDir.current, PEER_SOCKET_FILENAME);
    expect(opened.socketPath).toBe(path);
    expect(statSync(socketDir.current).mode & 0o777).toBe(0o711);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('資格で開くことと、開けたモデルの一覧を起動時に1行で言う（#3934）', () => {
    const plan = planPeerSocket(
      { ALTEROID_MANAGER_PEER_CODEX_MODELS: 'gpt-5.5,gpt-5.5-codex' },
      undefined,
    );
    expect(plan.models).toEqual({ codex: ['gpt-5.5', 'gpt-5.5-codex'] });
    expect(plan.notices).toHaveLength(1);
    expect(plan.notices[0]).toContain('資格');
    expect(plan.notices[0]).toContain(
      '名指しできるモデル: gpt-5.5, gpt-5.5-codex（ALTEROID_MANAGER_PEER_CODEX_MODELS）',
    );
    const defaults = peerDefaultModelsOf('codex')!;
    expect(defaults).toEqual(expect.arrayContaining(['gpt-6-astra', 'gpt-6.1-sol']));
    const byDefault = planPeerSocket({}, undefined);
    expect(byDefault.models).toEqual({ codex: [...defaults] });
    expect(byDefault.notices[0]).toContain(
      `名指しできるモデル: ${defaults.join(', ')}（既定の一覧。ALTEROID_MANAGER_PEER_CODEX_MODELS で置き換えられる）`,
    );
  });

  it('モデルの一覧の綴りが不正なら、起動時に例外で止める', () => {
    expect(() =>
      planPeerSocket({ ALTEROID_MANAGER_PEER_CODEX_MODELS: 'gpt-5.5,,' }, undefined),
    ).toThrow(/空の要素/);
    expect(existsSync(socketDir.current)).toBe(false);
  });

  it('token が一致しない接続は即切断する（使い捨て token だけが通る）', async () => {
    opened = await planPeerSocket({}, undefined).openSocket();
    const socket = createConnection({ path: join(socketDir.current, PEER_SOCKET_FILENAME) });
    await new Promise<void>((resolve) => socket.once('connect', resolve));
    socket.write('wrong-token\n');
    await new Promise<void>((resolve) => socket.once('close', resolve));
  });
});
