#!/usr/bin/env node
import { stdout } from 'node:process';

import { resolveDaemonOrigin, startWebServer } from './server.js';

/**
 * `alteroid-web` — 画面だけを単体で起こす入口。
 *
 * デーモンは起こさない（起こす責務は CLI にある）。コンテナ構成のように
 * デーモンが別の器で既に走っている場面のための口である。手元では
 * `alteroid web` のほうが早い（居なければデーモンごと起こす）。
 */
const daemonOrigin = resolveDaemonOrigin();
const server = await startWebServer({ daemonOrigin });
stdout.write(`alteroid-web: ${server.url}（デーモン: ${daemonOrigin}）\n`);
