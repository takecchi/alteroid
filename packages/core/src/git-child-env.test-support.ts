import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * `write-canon.test.ts` が本物の `git` を子として起こすときに渡す共通の env
 * （#1854。`scripts/mutate-cli-child-env.ts` の `mutateCliChildEnv()` と同じ
 * 作法 —— 親の `process.env` を丸ごと継承させず、必要な鍵だけを渡す）。
 *
 * 対象の呼び出し（`init` / `config user.email` / `config user.name` /
 * `add` / `commit`）は、identity を commit の前にそのリポジトリのローカルの
 * `git config` で明示的に設定する作法を採っている（`grep -Fn -- 'config',
 * 'user.email'` で当たる箇所を参照）ので、`GIT_AUTHOR_*` のような env 側の
 * identity は要らない——渡さなければ、そもそも上書きの心配自体が無い。
 *
 * `HOME` は本物を渡さない——本物の `~/.gitconfig` や credential helper が
 * 効く経路を断つ。対象のテストはローカルの一時リポジトリしか触らず、`HOME`
 * が空の一時ディレクトリでも壊れない。渡すのは `PATH`（`git` 自身を解決
 * するため）とこの偽の `HOME` の2つだけ。
 *
 * ## なぜ `.test-support.ts`（`test-support` の接尾辞）か
 *
 * `journal-scan.test-support.ts` と同じ命名——テスト専用の補助で、
 * `tsup.config.ts` の `entry` には載せず、公開 API（`package.json` の
 * `exports`）にも出さない。
 */
let fakeHome: string | undefined;

function getFakeHome(): string {
  fakeHome ??= mkdtempSync(join(tmpdir(), 'alteroid-git-child-env-'));
  return fakeHome;
}

export function gitChildEnv(): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH ?? '', HOME: getFakeHome() };
}
