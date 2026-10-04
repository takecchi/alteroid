import { mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { buildCoreDistForTesting } from './clone-tool-relay-child-build.test-support.js';

/**
 * 束ねた後の `@alteroid/core`（`dist/index.js` と同じ build）の、モジュール評価順の歯（#2732）。
 *
 * `runner.ts` が `agent-provider-selection.js` を import しただけで、束ねた後の評価順が変わり、
 * provider の表（`AGENT_PROVIDERS`）が未初期化のまま読まれて runner が
 * `TypeError: Cannot read properties of undefined (reading 'id')` で起動できなくなった。
 * vitest は `src` を直接読むので、この種の回帰は**束ねる工程を通さないと再現しない**。
 */
describe('束ねた core の初期化', () => {
  it('provider の表が引ける（起動時に agentProviderOf が undefined を返さない）', async () => {
    const outDir = await buildCoreDistForTesting('core-bundle-init-');
    // 一時ディレクトリから、本物の依存（外部 import）を解決できるようにする。
    const coreDir = fileURLToPath(new URL('..', import.meta.url));
    mkdirSync(outDir, { recursive: true });
    symlinkSync(join(coreDir, 'node_modules'), join(outDir, 'node_modules'), 'dir');

    const core = (await import(join(outDir, 'index.js'))) as {
      agentProviderOf: (id: string) => { id: string } | undefined;
    };
    expect(core.agentProviderOf('claude')?.id).toBe('claude');
    expect(core.agentProviderOf('codex')?.id).toBe('codex');
  }, 120_000);
});
