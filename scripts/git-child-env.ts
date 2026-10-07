import { makeTempDirSync } from '../vitest.tmpdir.js';

// `GIT_AUTHOR_*` を足さない: ローカルの `user.*` より優先順位が高く、渡さないことが唯一の対策のため。
// 本物の `HOME` を渡さず空の一時ディレクトリを充てる: 本物の `~/.gitconfig` や credential helper が効く経路を断つため。
// `HOME` は使い回す: 呼び出しのたびに作ると、何十回も `git` を起こすテストでディレクトリが積み上がるため。
let fakeHome: string | undefined;

function getFakeHome(): string {
  fakeHome ??= makeTempDirSync('alteroid-git-child-env-');
  return fakeHome;
}

export function gitChildEnv(): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH ?? '', HOME: getFakeHome() };
}
