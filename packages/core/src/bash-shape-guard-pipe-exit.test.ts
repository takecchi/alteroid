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

  // pipe-masks-exit としては止めない。最後の段が head・tail のものは pipe-trim（#5017）、`;` で繋ぐものは chain が別に止める（null は何も止めない）
  it.each([
    ['git log | head', 'pipe-trim'],
    ['git diff | tail', 'pipe-trim'],
    ['git stash list | head', 'pipe-trim'],
    ['git stash show | head', 'pipe-trim'],
    ['cat f | tail', 'pipe-trim'],
    ['git merge x', null],
    ['ls | git commit -F -', null],
    ['git merge x || tail f', null],
    ['git merge x && tail f', null],
    ['git merge x; tail f', 'chain'],
    ['git merge x & tail f', null],
    ['echo "git merge x | tail"', null],
    ["echo 'git merge x | tail'", null],
    ['echo a # git merge x | tail', null],
    ['grep -n foo a.ts | tail', 'pipe-trim'],
    // 各段の終了コードを自分で拾う形は、止めも知らせもしない（`;` の繋ぎだけは chain が止める）
    ['set -o pipefail; git merge x | tail', 'chain'],
    ['pnpm test | grep -E "Tests |FAIL"; echo "EXIT:${PIPESTATUS[0]}"', 'chain'],
    ['set -o pipefail\ngit merge x | tail', null],
  ])('%j は pipe-masks-exit として止めない（ほかの形: %s）', (command, form) => {
    expect(inspectPipeExitMasking(command)).toBeUndefined();
    const verdict = inspectBashShape(command);
    expect(verdict.blocked ? verdict.form : null).toBe(form);
  });
});

// #5017 で、最後の段が head・tail の管は pipe-trim で止める。checker としての読みは、知らせ（pipeExitNotice）が使うので残る
describe('管の最後でない段の検査のコマンドは checker として返す（#4990）。最後が head・tail なら pipe-trim で止める（#5017）', () => {
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
    const verdict = inspectBashShape(command);
    expect(verdict.blocked && verdict.form).toBe('pipe-trim');
  });

  it('最後が head・tail でない検査の管は、止めずに checker のまま通す', () => {
    expect(inspectPipeExitMasking('pnpm test | grep FAIL')).toEqual({
      kind: 'checker',
      name: 'pnpm test',
      last: 'grep',
    });
    expect(inspectBashShape('pnpm test | grep FAIL')).toEqual({ blocked: false });
    expect(pipeExitNotice('Bash', 'pnpm test | grep FAIL')).toContain(
      '管の最後の `grep` の終了コード',
    );
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
