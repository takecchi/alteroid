import { stdout } from 'node:process';

import { startWebServer } from '@alteroid/web';

import { baseUrl, ensureRunning } from './daemon.js';

export interface WebCommandOptions {
  port?: number;
  bind?: string;
}

/**
 * `alteroid web` — ブラウザから使う口。
 *
 * chat と同じく、デーモンが居なければ起こす。画面はデーモンの API をそのまま
 * 前へ通すだけなので、ここで増えるのは器であって機能ではない。
 */
export async function webCommand(options: WebCommandOptions): Promise<void> {
  const info = await ensureRunning();
  const server = await startWebServer({
    daemonOrigin: baseUrl(info),
    ...(options.port === undefined ? {} : { port: options.port }),
    ...(options.bind === undefined ? {} : { hostname: options.bind }),
  });
  stdout.write(`alteroid web: ${server.url}\n終了は Ctrl-C\n`);
}
