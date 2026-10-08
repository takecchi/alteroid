import { mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { buildCoreDistForTesting } from './clone-tool-relay-child-build.test-support.js';

describe('束ねた core の初期化', () => {
  it('provider の表が引ける（起動時に agentProviderOf が undefined を返さない）', async () => {
    const outDir = await buildCoreDistForTesting('core-bundle-init-');
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
