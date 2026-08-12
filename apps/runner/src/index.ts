#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { createRunnerHost } from '@alteroid/core';
import { serve } from '@hono/node-server';

import { createRunnerApp, Outbox } from './app.js';

export { createRunnerApp, Outbox, type RunnerAppDeps, type RunnerAppType } from './app.js';

/**
 * alteroid-runner — マネージャーと作業者を隔離して走らせる常駐プロセス。
 *
 * ここには**記憶ストアへ到達する鍵が無い**。それがこのプロセスを分けた理由で
 * あり、M4 の受け入れ基準3（マネージャーから記憶ストアへの認証経路が存在しない）は
 * この分離で初めて構造的に成立する。
 *
 * **ここに DB 接続や人格データの読み書きを足さないこと。** 足した瞬間、マネージャーが
 * `/proc/1/environ` から鍵を取れる状態に戻る。
 */
export function runnerIdOf(env: NodeJS.ProcessEnv = process.env): string {
  const given = env.ALTEROID_RUNNER_ID;
  if (given !== undefined && given.length > 0) return given;
  // 既定は固定名。M4 は1台構成であり、器を作り直しても同じ宛先として戻る
  // （台帳に残った runner_id と突き合わせられる）。
  return 'runner-primary';
}

export async function main(): Promise<void> {
  const runnerId = runnerIdOf();
  const workspacePath = process.env.ALTEROID_WORKSPACE || process.cwd();
  const port = Number(process.env.ALTEROID_RUNNER_PORT ?? '4518');
  // 既定は 127.0.0.1。compose では `0.0.0.0` にしてデーモンから届かせるが、
  // ポートは公開しない（境界はネットワークで引く）。
  const hostname = process.env.ALTEROID_RUNNER_BIND || '127.0.0.1';

  const outbox = new Outbox();
  const host = createRunnerHost({
    runnerId,
    workspacePath,
    emit: (event) => outbox.push(event),
  });

  const app = createRunnerApp({ host, outbox });
  const server = serve({ fetch: app.fetch, port, hostname });

  server.on('error', (error: unknown) => {
    process.stderr.write(
      `alteroid-runner: 待ち受けに失敗しました (port ${port}): ${String(error)}\n`,
    );
    process.exit(1);
  });

  let stopping = false;
  const shutdown = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    server.close();
    // 走行中のマネージャーは畳む。生ログはこの中でデーモンへ渡される
    // （渡さずに消えると、manager_id から生ログへ降りる経路が切れる）。
    const forced = setTimeout(() => process.exit(0), 30_000);
    forced.unref();
    await host.shutdown().catch(() => undefined);
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());

  process.stdout.write(
    `alteroid-runner: http://${hostname}:${port} （runner_id: ${runnerId} / 作業: ${workspacePath}）\n`,
  );
}

/** 直接起動されたときだけ main を走らせる。 */
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
    process.stderr.write(`alteroid-runner: 起動に失敗しました: ${String(error)}\n`);
    process.exit(1);
  });
}
