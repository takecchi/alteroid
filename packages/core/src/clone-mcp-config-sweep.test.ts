import { existsSync, mkdirSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { makeTempDirSync } from '../../../vitest.tmpdir.js';
import { CLONE_MCP_CONFIG_DIR_PREFIX } from './clone-mcp-config-file.js';
import {
  CLONE_MCP_CONFIG_SWEEP_MIN_AGE_MS,
  isPidAliveBySignal,
  sweepCloneMcpConfigDirs,
} from './clone-mcp-config-sweep.js';
import { RUNNER_MCP_CONFIG_DIR_PREFIX } from './runner-mcp-config-sweep.js';

const NOW = Date.now();
const OLD = new Date(NOW - 2 * CLONE_MCP_CONFIG_SWEEP_MIN_AGE_MS);
const OWN_PID = 4242;
const OTHER_PID = 4343;

function plant(root: string, name: string, mtime: Date): string {
  const dir = path.join(root, name);
  mkdirSync(dir);
  writeFileSync(path.join(dir, 'mcp-config.json'), '{}');
  utimesSync(dir, mtime, mtime);
  return dir;
}

const named = (pid: number, suffix: string): string =>
  `${CLONE_MCP_CONFIG_DIR_PREFIX}${String(pid)}-${suffix}`;

describe('デーモンのクローンの MCP 設定の残骸の掃き', () => {
  it('古い・自分の pid・live は残す', async () => {
    const root = makeTempDirSync('alteroid-clone-sweep-live-');
    const live = plant(root, named(OWN_PID, 'live'), OLD);
    const result = await sweepCloneMcpConfigDirs({
      tmpRoot: root,
      liveDirs: new Set([live]),
      now: NOW,
      ownPid: OWN_PID,
      isPidAlive: () => false,
    });
    expect(result).toEqual({ removed: [], failed: [] });
    expect(existsSync(live)).toBe(true);
  });

  it('古い・自分の pid・live でないものは消す（pid の生死は見ない）', async () => {
    const root = makeTempDirSync('alteroid-clone-sweep-own-');
    const stale = plant(root, named(OWN_PID, 'stale'), OLD);
    const result = await sweepCloneMcpConfigDirs({
      tmpRoot: root,
      liveDirs: new Set(),
      now: NOW,
      ownPid: OWN_PID,
      isPidAlive: () => true,
    });
    expect(result).toEqual({ removed: [path.basename(stale)], failed: [] });
    expect(existsSync(stale)).toBe(false);
  });

  it('古い・他の pid・生きているものは残す', async () => {
    const root = makeTempDirSync('alteroid-clone-sweep-alive-');
    const other = plant(root, named(OTHER_PID, 'alive'), OLD);
    const asked: number[] = [];
    const result = await sweepCloneMcpConfigDirs({
      tmpRoot: root,
      liveDirs: new Set(),
      now: NOW,
      ownPid: OWN_PID,
      isPidAlive: (pid) => {
        asked.push(pid);
        return true;
      },
    });
    expect(result).toEqual({ removed: [], failed: [] });
    expect(asked).toEqual([OTHER_PID]);
    expect(existsSync(other)).toBe(true);
  });

  it('古い・他の pid・居ないものは消す', async () => {
    const root = makeTempDirSync('alteroid-clone-sweep-dead-');
    const dead = plant(root, named(OTHER_PID, 'dead'), OLD);
    const result = await sweepCloneMcpConfigDirs({
      tmpRoot: root,
      liveDirs: new Set(),
      now: NOW,
      ownPid: OWN_PID,
      isPidAlive: () => false,
    });
    expect(result).toEqual({ removed: [path.basename(dead)], failed: [] });
    expect(existsSync(dead)).toBe(false);
  });

  it('古い・pid の無い名前（旧版）は持ち主が分からないので消す', async () => {
    const root = makeTempDirSync('alteroid-clone-sweep-legacy-');
    const legacy = plant(root, `${CLONE_MCP_CONFIG_DIR_PREFIX}AbC123`, OLD);
    // 乱数部が数字だけでも pid と読まない（数字の直後に `-` が無い）
    const digits = plant(root, `${CLONE_MCP_CONFIG_DIR_PREFIX}123456`, OLD);
    const result = await sweepCloneMcpConfigDirs({
      tmpRoot: root,
      liveDirs: new Set(),
      now: NOW,
      ownPid: OWN_PID,
      // 生死を聞かれたら残してしまう: 聞かれないことも確かめる
      isPidAlive: () => true,
    });
    expect(result.removed.sort()).toEqual([path.basename(digits), path.basename(legacy)].sort());
    expect(existsSync(legacy)).toBe(false);
    expect(existsSync(digits)).toBe(false);
  });

  it('若いものは、pid が居なくても自分の live でなくても残す', async () => {
    const root = makeTempDirSync('alteroid-clone-sweep-young-');
    const youngDead = plant(root, named(OTHER_PID, 'young'), new Date(NOW));
    const youngOwn = plant(root, named(OWN_PID, 'young'), new Date(NOW));
    const youngLegacy = plant(root, `${CLONE_MCP_CONFIG_DIR_PREFIX}young1`, new Date(NOW));
    const result = await sweepCloneMcpConfigDirs({
      tmpRoot: root,
      liveDirs: new Set(),
      now: NOW,
      ownPid: OWN_PID,
      isPidAlive: () => false,
    });
    expect(result).toEqual({ removed: [], failed: [] });
    for (const kept of [youngDead, youngOwn, youngLegacy]) expect(existsSync(kept)).toBe(true);
  });

  it('symlink は辿らず消さない', async () => {
    const root = makeTempDirSync('alteroid-clone-sweep-link-');
    const target = plant(root, 'elsewhere', OLD);
    symlinkSync(target, path.join(root, named(OTHER_PID, 'link')));
    const result = await sweepCloneMcpConfigDirs({
      tmpRoot: root,
      liveDirs: new Set(),
      now: NOW,
      ownPid: OWN_PID,
      isPidAlive: () => false,
    });
    expect(result.removed).toEqual([]);
    expect(existsSync(path.join(target, 'mcp-config.json'))).toBe(true);
  });

  it('接頭辞の違う CLI（alteroid-mcp-）と runner（alteroid-runner-mcp-config-）は触らない', async () => {
    const root = makeTempDirSync('alteroid-clone-sweep-prefix-');
    const cli = plant(root, 'alteroid-mcp-x', OLD);
    const runner = plant(root, `${RUNNER_MCP_CONFIG_DIR_PREFIX}x`, OLD);
    const stale = plant(root, named(OTHER_PID, 'stale'), OLD);
    const result = await sweepCloneMcpConfigDirs({
      tmpRoot: root,
      liveDirs: new Set(),
      now: NOW,
      ownPid: OWN_PID,
      isPidAlive: () => false,
    });
    expect(result).toEqual({ removed: [path.basename(stale)], failed: [] });
    for (const kept of [cli, runner]) expect(existsSync(kept)).toBe(true);
  });

  it('消せなかったものは失敗として返し、残りの掃きは続ける', async () => {
    const root = makeTempDirSync('alteroid-clone-sweep-fail-');
    const bad = plant(root, named(OTHER_PID, 'bad'), OLD);
    const good = plant(root, named(OTHER_PID, 'good'), OLD);
    const result = await sweepCloneMcpConfigDirs({
      tmpRoot: root,
      liveDirs: new Set(),
      now: NOW,
      ownPid: OWN_PID,
      isPidAlive: () => false,
      rmFn: async (target) => {
        if (target === bad) throw new Error('EPERM（テストの偽物）');
        await rm(target, { recursive: true, force: true });
      },
    });
    expect(result.removed).toEqual([path.basename(good)]);
    expect(result.failed).toEqual([
      { name: path.basename(bad), reason: expect.stringContaining('EPERM（テストの偽物）') },
    ]);
    expect(existsSync(bad)).toBe(true);
  });

  it('親を読めなければ scanError として返す', async () => {
    const root = makeTempDirSync('alteroid-clone-sweep-missing-');
    const result = await sweepCloneMcpConfigDirs({
      tmpRoot: path.join(root, 'no-such-dir'),
      liveDirs: new Set(),
      now: NOW,
      ownPid: OWN_PID,
    });
    expect(result.removed).toEqual([]);
    expect(result.scanError).toContain('を読めなかった');
  });
});

describe('isPidAliveBySignal', () => {
  it('自分は生きていて、居ない pid は居ないと言う', () => {
    expect(isPidAliveBySignal(process.pid)).toBe(true);
    // pid の上限（2^22）より大きい値は Linux で ESRCH になる
    expect(isPidAliveBySignal(2 ** 31 - 2)).toBe(false);
  });
});
