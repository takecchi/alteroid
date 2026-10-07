import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

function readDockerfileVersion(): string[] {
  const text = readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');
  return [...text.matchAll(/^ARG CODEX_VERSION=(.*)$/gm)].map((m) => m[1] ?? '');
}

function readCatalogVersion(): string[] {
  const text = readFileSync(path.join(ROOT, 'pnpm-workspace.yaml'), 'utf8');
  return [...text.matchAll(/^\s+'@openai\/codex':\s*(\S+)\s*$/gm)].map((m) => m[1] ?? '');
}

function readSchemaVersions(): string[] {
  return readdirSync(path.join(ROOT, 'packages/core/codex-schema'), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}

describe('Codex の版（Dockerfile / catalog / 生成スキーマ）', () => {
  it('Dockerfile は版を1か所だけ持つ', () => {
    const versions = readDockerfileVersion();
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('catalog は @openai/codex を厳密な版で1か所だけ持つ', () => {
    const versions = readCatalogVersion();
    expect(versions).toHaveLength(1);
    // `^` や `~` で幅を持たせない: 器の版と型の版が黙ってずれうるため。
    expect(versions[0]).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('器の版と catalog の版と生成スキーマの版が一致する', () => {
    const [docker] = readDockerfileVersion();
    expect(readCatalogVersion()).toEqual([docker]);
    expect(readSchemaVersions()).toEqual([docker]);
  });
});
