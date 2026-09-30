import { makeTempDirSync } from '../../vitest.tmpdir.js';

/**
 * `.github/scripts/*.test.ts` が本物の `git` を子として起こすときに渡す共通の
 * env（#1854。`scripts/mutate-cli-child-env.ts` の `mutateCliChildEnv()` と
 * 同じ作法 —— 親の `process.env` を丸ごと継承させず、必要な鍵だけを渡す）。
 *
 * ## なぜ identity（`GIT_AUTHOR_*` / `-c user.*`）をここで足さないか
 *
 * この束の対象ファイル（`reflect-release-prod.test.ts` /
 * `verify-for-sdk-pr.test.ts`）は、commit する author/committer を呼び出し側
 * の `GIT_IDENTITY`（`-c user.email=… -c user.name=…` の引数）で明示的に
 * 渡す作法を既に採っている。**この関数が `{ ...process.env }` を経由せず
 * 一から env を組み立てるので**、仮に器に `GIT_AUTHOR_EMAIL` 等が乗っていても
 * そもそも子へ渡る env にその鍵が無く、`-c user.*` を上書きする経路が
 * 生まれない（`update-claude-sdk.test.ts` の `GIT_IDENTITY_ENV_KEYS` の doc が
 * 書いている問題を、渡さないことで回避する形——あちらは `{ ...process.env }`
 * から4つの鍵だけを削るが、こちらは最初からその4つを含む鍵を1つも持たない）。
 *
 * ## なぜ本物の `HOME` を渡さないか
 *
 * 本物の `~/.gitconfig` や、そこに設定されているかもしれない credential
 * helper が効く経路を断つ。対象のテストはローカルの bare/非bare リポジトリ
 * しか触らず（ネットワーク越しの認証を必要とする remote は無い）、`HOME` に
 * `.gitconfig` が無くても git の操作そのものは壊れない —— 空の一時
 * ディレクトリを充てる。
 *
 * 渡すのは `PATH`（`git` 自身を解決するため）とこの偽の `HOME` の2つだけ。
 *
 * ## `HOME` を使い回す理由
 *
 * 呼び出しのたびに新しい一時ディレクトリを作ると、1テストファイルで何十回も
 * `git` を起こす箇所（`reflect-release-prod.test.ts` 等）で無駄にディレクトリ
 * が積み上がる。中身を書き込まない（`.gitconfig` を置かない）空のディレクトリ
 * なので、同じファイル内の呼び出しどうしで使い回しても副作用は無い。
 *
 * ## 後片付け（#2419）
 *
 * 偽の `HOME` は `vitest.tmpdir.ts` の `makeTempDirSync` で作る。そのテスト
 * ファイルの最後に `vitest.setup.ts` の `afterAll` が消す（`.github/scripts/`
 * のテストも root の `vitest.config.ts` の `include` に入っており、`setupFiles`
 * を通る）。
 */
let fakeHome: string | undefined;

function getFakeHome(): string {
  fakeHome ??= makeTempDirSync('alteroid-git-child-env-');
  return fakeHome;
}

export function gitChildEnv(): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH ?? '', HOME: getFakeHome() };
}
