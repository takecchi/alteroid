import { fileURLToPath } from 'node:url';

import { serve } from '@hono/node-server';

import { createWebApp } from './app.js';

export { createWebApp, type WebAppOptions } from './app.js';

/** デーモンと同じ既定。開けるなら手前に境界を置くのが先（AGENTS.md「動かす」）。 */
const DEFAULT_BIND = '127.0.0.1';
const DEFAULT_PORT = 4518;

export interface StartWebServerOptions {
  /** デーモンの接続先。CLI は `state/daemon.json` から解決して渡す。 */
  daemonOrigin: string;
  port?: number;
  hostname?: string;
}

export interface WebServer {
  url: string;
  close(): Promise<void>;
}

/**
 * デーモンの接続先を環境変数から決める（CLI を経由せず単体で起こすとき用）。
 * CLI から起こすときは `state/daemon.json` の実際のポートが渡ってくるので、
 * ここは通らない。
 */
export function resolveDaemonOrigin(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.ALTEROID_DAEMON_URL;
  if (explicit && explicit.length > 0) return explicit.replace(/\/$/, '');
  return `http://127.0.0.1:${env.ALTEROID_PORT ?? '4517'}`;
}

/** 画面の静的ファイルは束ねた成果物の隣に置いてある（dist/public）。 */
export function defaultAssetsDir(): string {
  return fileURLToPath(new URL('./public', import.meta.url));
}

export async function startWebServer(options: StartWebServerOptions): Promise<WebServer> {
  const port = options.port ?? Number(process.env.ALTEROID_WEB_PORT ?? String(DEFAULT_PORT));
  const hostname = options.hostname ?? process.env.ALTEROID_WEB_BIND ?? DEFAULT_BIND;

  const app = createWebApp({
    daemonOrigin: options.daemonOrigin,
    assetsDir: defaultAssetsDir(),
  });

  // 開けたこと自体は方針の変更であって禁止事項ではない。ただし**黙って**外へ
  // 出さない — ここはデーモンの API がそのまま通る口である。
  if (hostname !== DEFAULT_BIND && hostname !== 'localhost' && hostname !== '::1') {
    process.stderr.write(
      `alteroid-web: ${hostname} で待ち受けます。この画面と API に認証はありません。` +
        '手前に境界（リバースプロキシ・トンネル・認証）を置いてください。\n',
    );
  }

  const server = await new Promise<ReturnType<typeof serve>>((resolve, reject) => {
    const created = serve({ fetch: app.fetch, port, hostname }, () => {
      resolve(created);
    });
    created.on('error', (error: unknown) => {
      reject(new Error(`待ち受けに失敗しました (port ${port}): ${String(error)}`));
    });
  });

  return {
    url: `http://${hostname === '0.0.0.0' ? '127.0.0.1' : hostname}:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
}
