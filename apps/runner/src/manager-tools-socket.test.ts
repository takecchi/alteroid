import { statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { captureStderr } from '@alteroid/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeTempDirSync } from '../../../vitest.tmpdir.js';
import { openManagerToolsSocket } from './manager-tools-socket.js';

// 置き場所は本番と同じ口（core の既定の置き場所）から読む。試験ではその定数だけを、1本ごとの置き場所へ差し替える。
// 値ではなく getter で返す: 既定値は呼ぶたびに読まれるので、1本ごとに別の置き場所へ向けられる。
const socketDir = vi.hoisted(() => ({ current: '' }));
vi.mock('@alteroid/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@alteroid/core')>();
  return {
    ...actual,
    get DEFAULT_MANAGER_TOOLS_SOCKET_DIR() {
      return socketDir.current;
    },
  };
});

describe('openManagerToolsSocket（#2987）', () => {
  beforeEach(() => {
    socketDir.current = join(makeTempDirSync('alteroid-manager-tools-socket-'), 'manager');
  });

  it('資格を待たずに開き、置き場所は 0711・ソケットは 0600 になる', async () => {
    const dir = socketDir.current;
    const host = await openManagerToolsSocket(undefined);
    try {
      expect(host?.socketPath).toBe(join(dir, 'manager.sock'));
      expect(statSync(dir).mode & 0o777).toBe(0o711);
      expect(statSync(join(dir, 'manager.sock')).mode & 0o777).toBe(0o600);
    } finally {
      host?.close();
    }
  });

  it('開けなければ runner を止めず、道具を出さない理由を1行書いて undefined を返す', async () => {
    const root = makeTempDirSync('alteroid-manager-tools-socket-');
    // 置き場所の親がファイルなので mkdir が落ちる
    const blocker = join(root, 'not-a-dir');
    writeFileSync(blocker, '');
    socketDir.current = join(blocker, 'manager');
    let host: Awaited<ReturnType<typeof openManagerToolsSocket>>;
    const lines = await captureStderr(async () => {
      host = await openManagerToolsSocket(undefined);
    });
    expect(host).toBeUndefined();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('alteroid-manager');
    expect(lines[0]).toContain('output_record を出さない');
  });
});
