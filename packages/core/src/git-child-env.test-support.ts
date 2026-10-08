import { makeTempDirSync } from '../../../vitest.tmpdir.js';

// 本物の HOME を渡さない: 本物の `~/.gitconfig` や credential helper が効く経路を断つため
let fakeHome: string | undefined;

function getFakeHome(): string {
  fakeHome ??= makeTempDirSync('alteroid-git-child-env-');
  return fakeHome;
}

export function gitChildEnv(): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH ?? '', HOME: getFakeHome() };
}
