// Railway は `RUN --mount` を受け付けない（#2678 → #2683。ビルドが約13秒で落ちる）。image（buildx）では通るので、字面で止める。
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { makeTempDirSync } from '../vitest.tmpdir.js';

import {
  listGitScannableFiles,
  // @ts-expect-error -- 素の .mjs
} from './git-scannable-files-core.mjs';

const ROOT = join(import.meta.dirname, '..');

// 追跡している Dockerfile と、railway/*.json の build.dockerfilePath が指すファイルのうち、`RUN --mount` を持つもの。
function filesWithRunMount(root: string, tracked: string[]): string[] {
  const targets = new Set(tracked.filter((p) => /(^|\/)Dockerfile(\..+)?$|\.Dockerfile$/i.test(p)));
  for (const p of tracked.filter((q) => /^railway\/.*\.json$/.test(q))) {
    const dockerfilePath = JSON.parse(readFileSync(join(root, p), 'utf8'))?.build?.dockerfilePath;
    if (typeof dockerfilePath === 'string') targets.add(dockerfilePath.replace(/^\.\//, ''));
  }
  return [...targets].filter((p) => {
    // コメント行を落とし、`\` 改行を1行へつないでから、`RUN` の直後のフラグ列に `--mount` があるかを見る。
    const text = readFileSync(join(root, p), 'utf8')
      .replace(/^\s*#.*$/gm, '')
      .replace(/\\\r?\n/g, ' ');
    return /^\s*(ONBUILD\s+)?RUN\s+(--\S+\s+)*--mount\b/im.test(text);
  });
}

function fixture(files: Record<string, string>): { root: string; tracked: string[] } {
  const root = makeTempDirSync('dockerfile-no-run-mount-');
  for (const [p, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), content);
  }
  return { root, tracked: Object.keys(files) };
}

describe('Dockerfile に RUN --mount が無い', () => {
  it('追跡している Dockerfile と railway json が指す Dockerfile に無い', () => {
    const tracked: string[] = listGitScannableFiles({ cwd: ROOT });
    expect(tracked).toContain('Dockerfile');
    expect(filesWithRunMount(ROOT, tracked)).toEqual([]);
  });

  // 陽性の対照: 検査が何も捕まえない形に壊れても、上の試験が黙って緑にならないため。
  it.each([
    ['RUN --mount', 'FROM x\nRUN --mount=type=bind,source=a,target=b ls\n'],
    ['RUN \\ の次の行の --mount', 'FROM x\nRUN \\\n  --mount=type=cache,target=/c \\\n  ls\n'],
    ['ONBUILD RUN --mount', 'FROM x\nONBUILD RUN --network=none --mount=type=cache,target=/c ls\n'],
  ])('%s を捕まえる', (_name, content) => {
    const { root, tracked } = fixture({ Dockerfile: content });
    expect(filesWithRunMount(root, tracked)).toEqual(['Dockerfile']);
  });

  it('railway json が別の Dockerfile を指していても捕まえる', () => {
    const { root, tracked } = fixture({
      Dockerfile: 'FROM x\n',
      'railway/a.json': '{"build":{"dockerfilePath":"deploy/build.txt"}}',
      'deploy/build.txt': 'FROM x\nRUN --mount=type=cache,target=/c ls\n',
    });
    expect(filesWithRunMount(root, tracked)).toEqual(['deploy/build.txt']);
  });

  it('コメントの中の RUN --mount は捕まえない', () => {
    const { root, tracked } = fixture({
      Dockerfile: '# RUN --mount=type=bind は使わない\nFROM x\n',
    });
    expect(filesWithRunMount(root, tracked)).toEqual([]);
  });
});
