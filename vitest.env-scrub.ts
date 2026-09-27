/**
 * **テストの中から、器の本物の秘密が見えないようにする。**
 *
 * テストは、器の環境変数をそのまま引き継いだ vitest の worker の中で走る。
 * そこには本物の `GH_TOKEN` や `CLAUDE_CODE_*` の値が入っている。製品のコードには
 * `process.env` をそのまま子プロセスへ渡すものがあり（`apps/cli/src/daemon.ts` の
 * `start()` の `spawn(..., { env: process.env })` など）、テストがその `spawn` を
 * モックして assertion を落とすと、vitest はモックの呼び出しの引数を丸ごと出力する。
 * **本物の値が、そのまま出力やログのファイルへ出る。** 2026-09-27 に2回起きた
 * （作業者のテストの出力に `GH_TOKEN` が1回、ログのファイルに `GH_TOKEN` と
 * `CLAUDE_CODE_MESSAGING_TOKEN` が1回）。
 *
 * 「テストでは `env: {}` を渡せ」という規則では防げなかった。`env` を引数に取る
 * 関数の話であって、製品のコードが自分で `process.env` を読む経路には当たらない
 * からである。**だから規則ではなく、テストが始まる前に環境そのものから外す。**
 *
 * `vitest.setup.ts` の先頭がこれを呼ぶ。setupFiles は、各テストファイルが読み込まれる
 * 前に worker の中で走るので、テストの中の `process.env` にも、テストが起こす
 * 子プロセスにも、値は渡らない。テストが自分で偽の値（`GH_TOKEN=fake-…` など）を
 * 置くのは、この後なので妨げない。
 *
 * **名前で外す。値は見ない。** 値の形で秘密を見分けるのは取りこぼす（短い鍵・未知の
 * 形式）。名前の規則から漏れた秘密は外れないので、規則を広げるときはここへ足すこと。
 */

/**
 * 外す名前の規則。**迷ったら外す側へ倒す** — テストが本物の値を要ることは無い
 * （要るなら、そのテストが偽の値を自分で置くべきである）。
 */
export const SECRET_ENV_NAME_PATTERNS: readonly RegExp[] = [
  /_TOKEN$/i,
  /_KEY$/i,
  /_SECRET$/i,
  /_PASSWORD$/i,
  /_PASS$/i,
  /_CREDENTIALS?$/i,
  /^GH_/i,
  /^GITHUB_TOKEN$/i,
  /^CLAUDE_CODE_/i,
  /^ANTHROPIC_/i,
  /^DATABASE_URL$/i,
];

/** その名前の環境変数を、テストの前に外すか。 */
export function isSecretEnvName(name: string): boolean {
  return SECRET_ENV_NAME_PATTERNS.some((pattern) => pattern.test(name));
}

/**
 * `env` から、秘密の名前を持つ欄を消す。**消した名前だけを返す（値は返さない）。**
 */
export function scrubSecretEnv(env: NodeJS.ProcessEnv): string[] {
  const removed: string[] = [];
  for (const name of Object.keys(env)) {
    if (!isSecretEnvName(name)) continue;
    delete env[name];
    removed.push(name);
  }
  return removed;
}
