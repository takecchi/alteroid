#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { serve } from '@hono/node-server';

import { createClone } from '@alteroid/core';
import { createFsStores, initWorkspace } from '@alteroid/storage-fs';

import { createApp } from './app.js';
import { clearRuntimeInfo, writeRuntimeInfo } from './runtime.js';

export { createApp, type AppDeps, type AppType } from './app.js';
export { readRuntimeInfo, runtimeFilePath, type DaemonRuntimeInfo } from './runtime.js';

/** 空文字の環境変数を「未指定」として扱う（CLI 側の解釈と揃える）。 */
function envRoot(): string | undefined {
  const value = process.env.ALTEROID_HOME;
  return value !== undefined && value.length > 0 ? value : undefined;
}

/**
 * alteroidd — 常駐デーモン。
 *
 * 常駐は自律の前提であり、後から足す機能ではない（PRD）。M1 の時点で人間が
 * chat を開いていなくてもクローンは生きている。
 */
export async function main(): Promise<void> {
  const root = envRoot();
  const { paths } = await initWorkspace(root);
  const stores = createFsStores(root);

  // クローンのセッションは人格データディレクトリを基準に置く。呼び出し元の
  // カレントディレクトリに依存させると、別の場所から起動した瞬間に resume が
  // 迷子になる（同一性は記憶に宿るとはいえ、無駄に文脈を捨てない）。
  const clone = createClone({ stores, cwd: paths.root });
  const port = Number(process.env.ALTEROID_PORT ?? '4517');

  const app = createApp({ clone, stores, shutdown: () => void shutdown() });
  const server = serve({ fetch: app.fetch, port, hostname: '127.0.0.1' });

  server.on('error', (error: unknown) => {
    process.stderr.write(`alteroidd: 待ち受けに失敗しました (port ${port}): ${String(error)}\n`);
    process.exit(1);
  });

  let stopping = false;
  async function shutdown(): Promise<void> {
    if (stopping) return;
    stopping = true;

    // 先に受け口を閉じて runtime 情報を消す。クローンの後片付け（最後の蒸留）が
    // 長引いても、CLI からは「止まった」と見えるようにする。
    server.close();
    await clearRuntimeInfo(paths.state).catch(() => undefined);

    const forced = setTimeout(() => process.exit(0), 30_000);
    forced.unref();
    try {
      await clone.stop();
    } catch {
      // 片付けに失敗しても落ちる
    }
    process.exit(0);
  }

  await writeRuntimeInfo(paths.state, {
    pid: process.pid,
    port,
    startedAt: new Date().toISOString(),
  });

  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());

  process.stdout.write(`alteroidd: http://127.0.0.1:${port} （記憶: ${paths.root}）\n`);
}

/**
 * 直接起動されたときだけ main を走らせる。
 * `import.meta.url` は realpath 済み・パーセントエンコード済みなので、
 * argv[1] を素の文字列と比べると空白入りパスや symlink で誤判定する。
 */
function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main().catch((error: unknown) => {
    process.stderr.write(`alteroidd: 起動に失敗しました: ${String(error)}\n`);
    process.exit(1);
  });
}
