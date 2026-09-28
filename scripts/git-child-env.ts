import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * `scripts/*.test.ts` が本物の `git` を子として起こすときに渡す共通の env
 * （#1854。`scripts/mutate-cli-child-env.ts` の `mutateCliChildEnv()` と同じ
 * 作法 —— 親の `process.env` を丸ごと継承させず、必要な鍵だけを渡す）。
 *
 * ## なぜ identity（`GIT_AUTHOR_*`）をここで足さないか
 *
 * この束の対象ファイルは、commit の前にそのリポジトリの**ローカル**の
 * `git config user.email` / `git config user.name` を明示的に設定してから
 * 使う作法を採っている（`grep -Fn -- "'config', 'user.email'"` で当たる
 * 箇所を参照）。ローカル設定はグローバル設定より優先されるので、`HOME` に
 * 何も無くても、`GIT_AUTHOR_*` のような env 側の identity が無くても
 * commit の author/committer は決まる。**この関数が `{ ...process.env }` を
 * 経由せず一から env を組み立てるので**、仮に器に `GIT_AUTHOR_*` が乗って
 * いても、そもそも子へ渡る env にその鍵が無く、ローカル設定を上書きする
 * 経路も生まれない（`GIT_AUTHOR_*` はローカルの `user.*` より優先順位が
 * 高いので、渡さないことが唯一の対策になる）。
 *
 * ## なぜ本物の `HOME` を渡さないか
 *
 * 本物の `~/.gitconfig` や、そこに設定されているかもしれない credential
 * helper が効く経路を断つ。対象のテストはローカルの一時リポジトリしか
 * 触らず（ネットワーク越しの認証を必要とする remote は無い）、`HOME` に
 * `.gitconfig` が無くても git の操作そのものは壊れない —— 空の一時
 * ディレクトリを充てる。
 *
 * 渡すのは `PATH`（`git` 自身を解決するため）とこの偽の `HOME` の2つだけ。
 *
 * ## `HOME` を使い回す理由
 *
 * 呼び出しのたびに新しい一時ディレクトリを作ると、1テストファイルで何十回も
 * `git` を起こす箇所（`scripts/verify-core.test.ts` 等）で無駄にディレクトリ
 * が積み上がる。中身を書き込まない（`.gitconfig` を置かない）空のディレクトリ
 * なので、同じファイル内の呼び出しどうしで使い回しても副作用は無い。
 */
let fakeHome: string | undefined;

function getFakeHome(): string {
  fakeHome ??= mkdtempSync(join(tmpdir(), 'alteroid-git-child-env-'));
  return fakeHome;
}

export function gitChildEnv(): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH ?? '', HOME: getFakeHome() };
}
