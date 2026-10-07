import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { makeTempDirSync } from '../vitest.tmpdir.js';

import { gitChildEnv } from './git-child-env.js';
import { collectRepoFiles } from './repo-scan-files.js';

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, env: gitChildEnv(), stdio: 'ignore' });
}

function write(root: string, rel: string, text = 'x\n'): void {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
}

describe('collectRepoFiles（#2111）', () => {
  it('.gitignore 済みの .scratch/ の中は拾わず、追跡済み・未追跡は拾い、excludeDirs と消えたファイルは外す', () => {
    const root = makeTempDirSync('repo-scan-files-');
    git(root, ['init', '-q']);
    git(root, ['config', 'user.email', 'test@example.com']);
    git(root, ['config', 'user.name', 'test']);
    write(root, '.gitignore', '.scratch/\n');
    write(root, 'src/tracked.ts');
    write(root, 'src/deleted.ts');
    write(root, 'apps/web/.vite/cache.ts');
    git(root, ['add', '-A']);
    git(root, ['commit', '-q', '-m', 'init']);
    fs.rmSync(path.join(root, 'src/deleted.ts'));
    write(root, 'src/untracked.ts');
    write(root, '.scratch/split/copy.ts');

    const files = collectRepoFiles(root, new Set(['node_modules', '.vite']));

    expect(files).not.toContain('.scratch/split/copy.ts');
    expect(files.some((f) => f.startsWith('.scratch/'))).toBe(false);
    expect(files).toContain('src/tracked.ts');
    expect(files).toContain('src/untracked.ts');
    expect(files).not.toContain('apps/web/.vite/cache.ts');
    expect(files).not.toContain('src/deleted.ts');
  });
});
