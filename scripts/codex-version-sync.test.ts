import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * Codex（Issue #486 M7）の版は3か所に現れる。器に入る版（`Dockerfile` の
 * `ARG CODEX_VERSION`）、alteroid が型を突き合わせる版（`pnpm-workspace.yaml` の catalog
 * の `@openai/codex`）、コミット済みの生成スキーマのディレクトリ（`packages/core/codex-schema/<版>/`）。
 * **器の版と型の版がずれると、app-server のプロトコルが黙って食い違う**ので、ここで揃える。
 * 上げるときは3か所を同じコミットで動かす（スキーマは `pnpm --filter @alteroid/core codex:schema`）。
 */
function readDockerfileVersion(): string[] {
  const text = readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');
  // CI の `image` job が `sed -n 's/^ARG CODEX_VERSION=\(.*\)$/\1/p'` で読むのと同じ形。
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
    // `^` や `~` で幅を持たせると、器の版と型の版が黙ってずれうる。
    expect(versions[0]).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('器の版と catalog の版と生成スキーマの版が一致する', () => {
    const [docker] = readDockerfileVersion();
    expect(readCatalogVersion()).toEqual([docker]);
    expect(readSchemaVersions()).toEqual([docker]);
  });
});
