// 道具の中継（runner がマネージャーの peer と alteroid-manager の道具に使う）を、**本物の Claude Code CLI**
// （SDK 同梱の実行体）に繋がせて確かめる検査。モデルは呼ばない（`claude mcp list` の health check だけを使う）。
// 中継の向こうには、手元で組めるクローンの道具の MCP サーバを置く（中継はバイトを流すだけなので、向こうの中身は問わない）。
//
// 使い方: node clone-tool-relay-probe.mjs <@alteroid/core の dist/index.js> <claude 実行体>
// 成功なら exit 0。CLI が中継越しの MCP サーバを「Connected」と言わなければ exit 1。
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const [coreEntry, claudeBin] = process.argv.slice(2);
if (!coreEntry || !claudeBin) {
  process.stderr.write('usage: clone-tool-relay-probe.mjs <core dist/index.js> <claude>\n');
  process.exit(2);
}

const core = await import(pathToFileURL(coreEntry).href);
const socketDir = mkdtempSync(join(tmpdir(), 'relay-probe-sock-'));
const host = await core.createCloneToolRelayHost({ socketPath: join(socketDir, 'probe.sock') });
const context = {
  stores: core.createMemoryStores(),
  emit: () => {},
  conversationId: () => undefined,
  memoryCause: () => 'clone',
};
const token = host.register(() => core.createCloneMcpServer(context).instance);

const home = mkdtempSync(join(tmpdir(), 'relay-probe-home-'));
const config = {
  type: 'stdio',
  command: process.execPath,
  args: [core.resolveCloneToolRelayChildEntry(pathToFileURL(coreEntry).href)],
  env: {
    [core.CLONE_TOOL_RELAY_SOCKET_ENV]: host.socketPath,
    [core.CLONE_TOOL_RELAY_TOKEN_ENV]: token,
  },
};
const env = { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: join(home, '.claude') };
// 同期の spawn を使わない: 中継の待ち受けはこのプロセスの中に在り、イベントループを塞ぐと子の接続を受けられず必ず時間切れになるため。
const execFileAsync = promisify(execFile);
const run = async (args) => {
  try {
    const { stdout, stderr } = await execFileAsync(claudeBin, args, {
      env,
      cwd: home,
      timeout: 90_000,
    });
    return { status: 0, stdout, stderr };
  } catch (error) {
    return {
      status: error.code ?? 1,
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? String(error),
    };
  }
};

try {
  const added = await run([
    'mcp',
    'add-json',
    '--scope',
    'user',
    'alteroid',
    JSON.stringify(config),
  ]);
  process.stdout.write(added.stdout ?? '');
  process.stderr.write(added.stderr ?? '');
  if (added.status !== 0) throw new Error(`mcp add-json が失敗した: status=${added.status}`);

  const listed = await run(['mcp', 'list']);
  process.stdout.write(listed.stdout ?? '');
  process.stderr.write(listed.stderr ?? '');
  const line = (listed.stdout ?? '').split('\n').find((l) => l.startsWith('alteroid'));
  if (line === undefined || !/Connected/.test(line)) {
    throw new Error(`CLI が中継越しの MCP サーバへ繋がなかった: ${line ?? '(行が無い)'}`);
  }
  process.stdout.write('clone-tool-relay-probe: OK\n');
} catch (error) {
  process.stderr.write(`clone-tool-relay-probe: ${String(error)}\n`);
  process.exitCode = 1;
} finally {
  host.close();
  rmSync(home, { recursive: true, force: true });
  rmSync(socketDir, { recursive: true, force: true });
}
