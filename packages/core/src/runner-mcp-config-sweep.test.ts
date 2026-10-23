import { existsSync, mkdirSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { makeTempDirSync } from '../../../vitest.tmpdir.js';
import {
  RUNNER_MCP_CONFIG_DIR_PREFIX,
  RUNNER_MCP_CONFIG_SWEEP_MIN_AGE_MS,
  sweepRunnerMcpConfigDirs,
} from './runner-mcp-config-sweep.js';

const NOW = Date.now();
const OLD = new Date(NOW - 2 * RUNNER_MCP_CONFIG_SWEEP_MIN_AGE_MS);

function plant(root: string, name: string, mtime: Date): string {
  const dir = path.join(root, name);
  mkdirSync(dir);
  writeFileSync(path.join(dir, 'mcp-config-1.json'), '{}');
  utimesSync(dir, mtime, mtime);
  return dir;
}

describe('runner の MCP 設定の残骸の掃き', () => {
  it('古い残骸は消し、走っている委譲・若いもの・別の接頭辞（CLI の alteroid-mcp-）は残す', async () => {
    const root = makeTempDirSync('alteroid-mcp-sweep-');
    const stale = plant(root, `${RUNNER_MCP_CONFIG_DIR_PREFIX}stale`, OLD);
    const live = plant(root, `${RUNNER_MCP_CONFIG_DIR_PREFIX}live`, OLD);
    const young = plant(root, `${RUNNER_MCP_CONFIG_DIR_PREFIX}young`, new Date(NOW));
    const cli = plant(root, 'alteroid-mcp-cli', OLD);

    const result = await sweepRunnerMcpConfigDirs({
      tmpRoot: root,
      liveDirs: new Set([live]),
      now: NOW,
    });

    expect(result).toEqual({ removed: [path.basename(stale)], failed: [] });
    expect(existsSync(stale)).toBe(false);
    for (const kept of [live, young, cli]) expect(existsSync(kept)).toBe(true);
  });

  it('symlink は辿らず消さない', async () => {
    const root = makeTempDirSync('alteroid-mcp-sweep-link-');
    const target = plant(root, 'elsewhere', OLD);
    symlinkSync(target, path.join(root, `${RUNNER_MCP_CONFIG_DIR_PREFIX}link`));

    const result = await sweepRunnerMcpConfigDirs({
      tmpRoot: root,
      liveDirs: new Set(),
      now: NOW,
    });

    expect(result.removed).toEqual([]);
    expect(existsSync(path.join(target, 'mcp-config-1.json'))).toBe(true);
  });

  it('消せなかったものは失敗として返し、残りの掃きは続ける', async () => {
    const root = makeTempDirSync('alteroid-mcp-sweep-fail-');
    const bad = plant(root, `${RUNNER_MCP_CONFIG_DIR_PREFIX}bad`, OLD);
    const good = plant(root, `${RUNNER_MCP_CONFIG_DIR_PREFIX}good`, OLD);

    const result = await sweepRunnerMcpConfigDirs({
      tmpRoot: root,
      liveDirs: new Set(),
      now: NOW,
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
    const root = makeTempDirSync('alteroid-mcp-sweep-missing-');
    const result = await sweepRunnerMcpConfigDirs({
      tmpRoot: path.join(root, 'no-such-dir'),
      liveDirs: new Set(),
      now: NOW,
    });
    expect(result.removed).toEqual([]);
    expect(result.scanError).toContain('を読めなかった');
  });
});
