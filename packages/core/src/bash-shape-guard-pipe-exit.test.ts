import { describe, expect, it } from 'vitest';

import {
  BASH_SHAPE_CONTINUE_NOTE,
  inspectBashShape,
  inspectPipeExitMasking,
  pipeExitNotice,
} from './bash-shape-guard.js';

describe('管の最後でない段の状態を変えるコマンドは止める（#4990）', () => {
  it.each([
    ['git merge origin/main | tail -n 5', 'git merge'],
    ['git -C /x commit -m a | tail', 'git commit'],
    ['git stash pop | head', 'git stash'],
    ['git stash | head', 'git stash'],
    ['gh pr merge 1 --squash | tail -n 3', 'gh pr merge'],
    ['prettier --write a.ts | tail', 'prettier --write'],
    ['prettier -w a.ts | tail', 'prettier --write'],
    ['pnpm exec eslint --fix . | tail', 'eslint --fix'],
    ['npx prettier --write . | tail', 'prettier --write'],
    ['timeout 60 git pull | tail', 'git pull'],
    ['git push origin x | tail', 'git push'],
    ['cat f | git apply | tail', 'git apply'],
    ['echo a; git merge x | tail', 'git merge'],
  ])('%j は %s で止める', (command, name) => {
    expect(inspectPipeExitMasking(command)).toEqual({ kind: 'mutating', name });
    const verdict = inspectBashShape(command);
    expect(verdict.blocked).toBe(true);
    if (!verdict.blocked) return;
    expect(verdict.form).toBe('pipe-masks-exit');
    expect(verdict.reason).toContain(`\`${name}\` の出力を管`);
    expect(verdict.reason).toContain(`管を外して \`${name} …\` だけを打ち`);
    expect(verdict.reason.endsWith(BASH_SHAPE_CONTINUE_NOTE)).toBe(true);
  });

  it('bash -c の中・二重引用符の中の置換でも止める', () => {
    for (const command of ["bash -c 'git merge x | tail'", 'echo "$(git merge x | tail)"']) {
      const verdict = inspectBashShape(command);
      expect(verdict.blocked && verdict.form).toBe('pipe-masks-exit');
    }
  });

  it.each([
    'git log | head',
    'git diff | tail',
    'git stash list | head',
    'git stash show | head',
    'cat f | tail',
    'git merge x',
    'ls | git commit -F -',
    'git merge x || tail f',
    'git merge x && tail f',
    'git merge x; tail f',
    'git merge x & tail f',
    'echo "git merge x | tail"',
    "echo 'git merge x | tail'",
    'echo a # git merge x | tail',
    'grep -n foo a.ts | tail',
    // 各段の終了コードを自分で拾う形は、止めも知らせもしない
    'set -o pipefail; git merge x | tail',
    'pnpm test | grep -E "Tests |FAIL"; echo "EXIT:${PIPESTATUS[0]}"',
  ])('%j は止めない', (command) => {
    expect(inspectPipeExitMasking(command)).toBeUndefined();
    expect(inspectBashShape(command)).toEqual({ blocked: false });
  });
});

describe('管の最後でない段の検査のコマンドは止めず、checker として返す（#4990）', () => {
  it.each([
    ['pnpm test | tail -n 30', 'pnpm test', 'tail'],
    ['pnpm -C packages/core test | tail', 'pnpm test', 'tail'],
    ['pnpm --filter core run test:unit | tail', 'pnpm test:unit', 'tail'],
    ['pnpm run typecheck | tail', 'pnpm typecheck', 'tail'],
    ['npm run format:check | tail', 'npm format:check', 'tail'],
    ['npx vitest run | tail', 'vitest', 'tail'],
    ['pnpm exec tsc --noEmit | tail', 'tsc', 'tail'],
    ['timeout 530 gh run watch 1 --exit-status | tail -1', 'gh run watch', 'tail'],
    ['gh pr checks 1 | head', 'gh pr checks', 'head'],
    ['tsc --noEmit | head', 'tsc', 'head'],
    ['eslint . | tail', 'eslint', 'tail'],
    ['prettier --check . | tail', 'prettier', 'tail'],
    ['cargo test | tail', 'cargo test', 'tail'],
    ['go vet ./... | tail', 'go vet', 'tail'],
    ['make build | tail', 'make', 'tail'],
    ['pytest -x | tail', 'pytest', 'tail'],
    ['jest | tail', 'jest', 'tail'],
    ['bun run build | tail', 'bun build', 'tail'],
  ])('%j は checker（%s・最後は %s）', (command, name, last) => {
    expect(inspectPipeExitMasking(command)).toEqual({ kind: 'checker', name, last });
    expect(inspectBashShape(command)).toEqual({ blocked: false });
  });

  it('mutating は checker より先に返る', () => {
    expect(inspectPipeExitMasking('pnpm test | tail; git merge x | tail')).toEqual({
      kind: 'mutating',
      name: 'git merge',
    });
  });

  it.each([
    'pnpm test',
    'pnpm install | tail',
    'pnpm add x | tail',
    'cargo run | tail',
    'go run . | tail',
    'cat f | tail',
    'git log | head',
  ])('%j は undefined または checker でない', (command) => {
    expect(inspectPipeExitMasking(command)).toBeUndefined();
  });
});

describe('pipeExitNotice（#4990）', () => {
  it('Bash の checker にだけ、名前と最後の語の入った知らせを返す', () => {
    const text = pipeExitNotice('Bash', 'pnpm test | tail -n 30');
    expect(text).toContain('管の最後の `tail` の終了コード');
    expect(text).toContain('`pnpm test` が通ったことは表さない');
    expect(pipeExitNotice('Bash', 'cat f | tail')).toBeNull();
    expect(pipeExitNotice('Bash', 'pnpm test')).toBeNull();
    expect(pipeExitNotice('Bash', 'git merge x | tail')).toBeNull();
    expect(pipeExitNotice('Read', 'pnpm test | tail')).toBeNull();
    expect(pipeExitNotice('Bash', undefined)).toBeNull();
  });
});
