import { chmod, lstat, mkdir, readdir, rename, stat, symlink } from 'node:fs/promises';
import { join } from 'node:path';

import type { Options, Query, SDKMessage, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';
import { computePluginContentSha256 } from './plugins.js';
import {
  createRunnerHost,
  RunnerPluginExtractError,
  WORKER_AGENT_NAME,
  type RunnerHost,
} from './runner.js';

/**
 * runner が受けた plugin を展開し、マネージャーの `Options.plugins` へつなぐ（Host の受け取り）。
 *
 * 固定すること: 展開されること・メモリには指紋と path と skipMcpDiscovery だけが残ること・
 * 展開の失敗で前の状態が残ること・外れたものはメモリから消えるが、ディスクの旧版は走行中の
 * セッションがあるあいだ消さないこと・作業者の定義に plugin が混ざらないこと。値はすべて偽物である。
 */

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const encoder = new TextEncoder();

function wire(name: string, sourceSha = SHA_A, extra: { enableMcp?: boolean } = {}) {
  const files = [
    {
      path: '.claude-plugin/plugin.json',
      executable: false,
      content: encoder.encode(JSON.stringify({ name, description: 'dummy-content' })),
    },
    {
      path: 'skills/one/SKILL.md',
      executable: false,
      content: encoder.encode('---\nname: one\ndescription: dummy-content\n---\n# body\n'),
    },
  ];
  return {
    name,
    sourceSha,
    scope: 'all',
    enableHooks: false,
    enableMcp: extra.enableMcp ?? false,
    contentSha256: computePluginContentSha256(files),
    files,
  };
}

interface Started {
  options: Options;
}

function fakeSdk(): { fn: typeof sdkQuery; started: Started[] } {
  const started: Started[] = [];
  const fn = ((input: { options: Options }) => {
    started.push({ options: input.options });
    let finish: (() => void) | undefined;
    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: `sess-${started.length}`,
        uuid: `uuid-${started.length}`,
      } as unknown as SDKMessage;
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    }
    return Object.assign(generate(), {
      close: () => finish?.(),
      interrupt: async () => undefined,
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;
  return { fn, started };
}

async function makeWritable(dir: string): Promise<void> {
  const info = await lstat(dir).catch(() => null);
  if (info === null || !info.isDirectory()) return;
  await chmod(dir, 0o700);
  for (const name of await readdir(dir)) await makeWritable(join(dir, name));
}

describe('Host の plugin の受け取り（展開）', () => {
  let base: string;
  let pluginsRoot: string;
  let workspace: string;
  let host: RunnerHost | undefined;

  beforeEach(async () => {
    base = await makeTempDir('alteroid-runner-plugins-extract-');
    pluginsRoot = join(base, 'alteroid-plugins');
    workspace = join(base, 'workspace');
    await mkdir(workspace);
  });

  afterEach(async () => {
    await host?.shutdown().catch(() => undefined);
    host = undefined;
    await makeWritable(base);
  });

  function makeHost() {
    const sdk = fakeSdk();
    host = createRunnerHost({
      runnerId: 'runner-primary',
      workspacePath: workspace,
      emit: () => undefined,
      queryFn: sdk.fn,
      env: {},
      pluginsRoot,
    });
    return { host, started: sdk.started };
  }

  const dirOf = (name: string, sha = SHA_A) => join(pluginsRoot, 'plugins', `${name}@${sha}`);
  const exists = (path: string) =>
    stat(path).then(
      () => true,
      () => false,
    );

  it('展開し、runner 用のモードで置く。指紋の形は変わらない', async () => {
    const { host } = makeHost();
    const body = wire('p-one');
    const placed = await host.setPlugin('p-one', body);

    expect(placed).toEqual({ name: 'p-one', sha: SHA_A, contentSha256: body.contentSha256 });
    expect(await exists(join(dirOf('p-one'), 'skills/one/SKILL.md'))).toBe(true);
    expect((await stat(pluginsRoot)).mode & 0o777).toBe(0o755);
    expect((await stat(join(pluginsRoot, 'plugins'))).mode & 0o777).toBe(0o755);
    expect((await stat(dirOf('p-one'))).mode & 0o777).toBe(0o555);

    const fingerprint = host.plugins();
    expect(fingerprint?.plugins).toEqual([
      { name: 'p-one', sha: SHA_A, contentSha256: body.contentSha256 },
    ]);
    expect(Object.keys(fingerprint ?? {}).sort()).toEqual(['plugins', 'sha256', 'updatedAt']);
  });

  it('メモリに残るのは指紋と path と skipMcpDiscovery だけで、files のバイトは session へも出ない', async () => {
    const { host, started } = makeHost();
    await host.setPlugin('p-one', wire('p-one'));
    await host.setPlugin('p-two', wire('p-two', SHA_A, { enableMcp: true }));
    const serialized = JSON.stringify(host.plugins());
    expect(serialized).not.toContain('dummy-content');
    expect(serialized).not.toContain(Buffer.from('dummy-content').toString('base64'));

    await host.start({ managerId: 'mgr-1', request: '走る', cwd: workspace });
    const options = (started[0] as Started).options;
    expect(options.plugins).toEqual([
      { type: 'local', path: dirOf('p-one'), skipMcpDiscovery: true },
      { type: 'local', path: dirOf('p-two'), skipMcpDiscovery: false },
    ]);
    const optionsText = JSON.stringify(options.plugins);
    expect(optionsText).not.toContain('dummy-content');
    expect(Object.keys((options.plugins ?? [])[0] ?? {}).sort()).toEqual([
      'path',
      'skipMcpDiscovery',
      'type',
    ]);
  });

  it('plugin が無ければ options.plugins の欄ごと無く、作業者の定義には plugin も skills も混ざらない', async () => {
    const { host, started } = makeHost();
    await host.start({ managerId: 'mgr-1', request: '走る', cwd: workspace });
    expect(Object.hasOwn((started[0] as Started).options, 'plugins')).toBe(false);

    await host.setPlugin('p-one', wire('p-one'));
    await host.start({ managerId: 'mgr-2', request: '走る', cwd: workspace });
    const options = (started[1] as Started).options;
    expect(options.plugins).toHaveLength(1);
    const worker = (options.agents ?? {})[WORKER_AGENT_NAME] as Record<string, unknown>;
    expect(Object.hasOwn(worker, 'skills')).toBe(false);
    expect(Object.hasOwn(worker, 'plugins')).toBe(false);
    expect(JSON.stringify(options.agents)).not.toContain('p-one');
  });

  it('検査で落ちたら投げ、前の状態が残る', async () => {
    const { host } = makeHost();
    const before = await host.setPlugin('p-one', wire('p-one'));
    await expect(
      host.setPlugin('p-one', { ...wire('p-one', SHA_B), contentSha256: 'x' }),
    ).rejects.toThrow();
    await expect(host.setPlugin('p-other', wire('p-one'))).rejects.toThrow();
    expect(host.plugins()?.plugins).toEqual([before]);
    expect(await exists(dirOf('p-one', SHA_B))).toBe(false);
  });

  it('展開が失敗したら RunnerPluginExtractError を投げ、前の状態が残る', async () => {
    const { host } = makeHost();
    const before = await host.setPlugin('p-one', wire('p-one'));
    // 置き場を symlink に差し替えられた状況（展開器は辿らずに拒む）。
    const plugins = join(pluginsRoot, 'plugins');
    await rename(plugins, join(base, 'moved'));
    await symlink(join(base, 'moved'), plugins);

    await expect(host.setPlugin('p-one', wire('p-one', SHA_B))).rejects.toBeInstanceOf(
      RunnerPluginExtractError,
    );
    expect(host.plugins()?.plugins).toEqual([before]);
  });

  it('retain で外れたものはメモリから消える', async () => {
    const { host } = makeHost();
    await host.setPlugin('p-one', wire('p-one'));
    const two = await host.setPlugin('p-two', wire('p-two'));
    const left = host.retainPlugins(['p-two']);
    expect(left?.plugins).toEqual([two]);
    expect(host.retainPlugins([])).toBeUndefined();
    expect(host.plugins()).toBeUndefined();
  });

  it('走行中のセッションがあるあいだは旧版（sha 違い・外したもの）のディスクを消さず、1つも無くなったら消す', async () => {
    const { host } = makeHost();
    await host.setPlugin('p-one', wire('p-one', SHA_A));
    await host.setPlugin('p-gone', wire('p-gone', SHA_A));
    await host.start({ managerId: 'mgr-1', request: '走る', cwd: workspace });

    await host.setPlugin('p-one', wire('p-one', SHA_B));
    host.retainPlugins(['p-one']);
    // 走行中なので、旧版も外したものも残っている（読んでいるかもしれない）。
    expect(await exists(dirOf('p-one', SHA_A))).toBe(true);
    expect(await exists(dirOf('p-gone', SHA_A))).toBe(true);
    expect(await exists(dirOf('p-one', SHA_B))).toBe(true);

    await host.stop('mgr-1');
    await expect.poll(() => exists(dirOf('p-one', SHA_A)), { timeout: 3000 }).toBe(false);
    expect(await exists(dirOf('p-gone', SHA_A))).toBe(false);
    // 残すものは消えない。
    expect(await exists(dirOf('p-one', SHA_B))).toBe(true);
  });

  it('走行中のセッションが無ければ、置いた直後に旧版を消す', async () => {
    const { host } = makeHost();
    await host.setPlugin('p-one', wire('p-one', SHA_A));
    await host.setPlugin('p-one', wire('p-one', SHA_B));
    expect(await exists(dirOf('p-one', SHA_A))).toBe(false);
    expect(await exists(dirOf('p-one', SHA_B))).toBe(true);
    expect(
      (await readdir(join(pluginsRoot, 'plugins'))).filter((n) => n.startsWith('.tmp-')),
    ).toEqual([]);
  });
});
