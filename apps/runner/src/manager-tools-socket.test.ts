import { statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { makeTempDirSync } from '../../../vitest.tmpdir.js';
import { openManagerToolsSocket } from './manager-tools-socket.js';

describe('openManagerToolsSocket（#2987）', () => {
  it('資格を待たずに開き、置き場所は 0711・ソケットは 0600 になる', async () => {
    const dir = join(makeTempDirSync('alteroid-manager-tools-socket-'), 'manager');
    const host = await openManagerToolsSocket(undefined, dir);
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
    const lines: string[] = [];
    const host = await openManagerToolsSocket(undefined, join(blocker, 'manager'), (line) =>
      lines.push(line),
    );
    expect(host).toBeUndefined();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('alteroid-manager');
    expect(lines[0]).toContain('output_record を出さない');
  });
});
