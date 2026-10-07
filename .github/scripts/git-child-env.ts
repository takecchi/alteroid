import { makeTempDirSync } from '../../vitest.tmpdir.js';

// 親の `process.env` を丸ごと継承させず、`PATH` と偽の `HOME` だけを渡す: identity（`GIT_AUTHOR_*`）をここで足すと、器に `GIT_AUTHOR_EMAIL` 等が在るとき呼び出し側の `-c user.*` を上書きする経路が生まれるため。
// 本物の `HOME` を渡さず空の一時ディレクトリを充てる: 本物の `~/.gitconfig` や credential helper が効く経路を断つため。
// `HOME` は呼び出しごとに作らず使い回す: 1テストファイルで何十回も `git` を起こすと、一時ディレクトリが積み上がるため。
let fakeHome: string | undefined;

function getFakeHome(): string {
  fakeHome ??= makeTempDirSync('alteroid-git-child-env-');
  return fakeHome;
}

export function gitChildEnv(): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH ?? '', HOME: getFakeHome() };
}
