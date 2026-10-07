import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build as tsupBuild, type Options as TsupOptions } from 'tsup';

import { makeTempDirSync } from '../../../vitest.tmpdir.js';

export async function buildCloneToolRelayChildDistForTesting(
  tempDirPrefix: string,
): Promise<string> {
  return join(await buildCoreDistForTesting(tempDirPrefix), 'clone-tool-relay-child.js');
}

export async function buildCoreDistForTesting(tempDirPrefix: string): Promise<string> {
  const coreDir = fileURLToPath(new URL('..', import.meta.url));
  const configModule = (await import(new URL('../tsup.config.ts', import.meta.url).href)) as {
    default: TsupOptions & { entry: readonly string[] };
  };
  const config = configModule.default;

  const outDir = makeTempDirSync(tempDirPrefix);

  await tsupBuild({
    ...config,
    config: false,
    // entry を削らない: 一部だけだと共有チャンクへの括り出しが再現されないため。絶対パスにする: process.cwd() に依存させないため
    entry: config.entry.map((entry) => join(coreDir, entry)),
    tsconfig: join(coreDir, 'tsconfig.json'),
    outDir,
    dts: false,
    silent: true,
  });

  return outDir;
}
