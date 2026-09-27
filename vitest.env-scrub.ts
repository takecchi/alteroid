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
 *
 * 名前の全体に当てる規則（接頭辞・接続文字列）と、`_` で区切った語に当てる規則
 * （`SECRET_ENV_NAME_WORDS`）の2段で見る。**語の単位で見るのは、末尾一致だけだと
 * 語の後ろに何かが付いた名前が漏れるからである**（16回目の横断レビュー:
 * `ALTEROID_RUNNER_TOKEN_SHA256` は `_TOKEN$` に当たらず、`PGPASSWORD` は
 * `_PASSWORD$` に当たらなかった）。語の単位なら `GIT_AUTHOR_NAME` の `AUTHOR` の
 * ような、秘密の語を部分に含むだけの語は巻き込まない。
 */
export const SECRET_ENV_NAME_PATTERNS: readonly RegExp[] = [
  /^GH_/i,
  /^GITHUB_TOKEN$/i,
  /^CLAUDE_CODE_/i,
  /^ANTHROPIC_/i,
  // 接続文字列はユーザー名とパスワードを埋め込む
  // （`postgres://alteroid:<password>@db:5432/alteroid`。`compose.yaml` の
  // `ALTEROID_DATABASE_URL`）。
  /(^|_)DATABASE_URL$/i,
  /(^|_)DB_URL$/i,
];

/**
 * `_` で区切った語のうち、どれか1つがこの語そのもの（大小文字を区別しない）なら外す。
 */
export const SECRET_ENV_NAME_WORDS: readonly string[] = [
  'TOKEN',
  'TOKENS',
  'SECRET',
  'SECRETS',
  'PASSWORD',
  'PASSWD',
  'PASS',
  'PASSPHRASE',
  'CREDENTIAL',
  'CREDENTIALS',
  'KEY',
  'KEYS',
  'APIKEY',
  'PEM',
  'PAT',
  'DSN',
  'COOKIE',
];

/**
 * `_` で区切った語が、この語で**終わる**なら外す。区切りの無い書き方
 * （`PGPASSWORD`、`NPMTOKEN`）を拾うためである。
 */
export const SECRET_ENV_NAME_WORD_SUFFIXES: readonly string[] = ['PASSWORD', 'TOKEN', 'SECRET'];

/** その名前の環境変数を、テストの前に外すか。 */
export function isSecretEnvName(name: string): boolean {
  if (SECRET_ENV_NAME_PATTERNS.some((pattern) => pattern.test(name))) return true;
  const words = name
    .toUpperCase()
    .split(/_+/)
    .filter((word) => word !== '');
  return words.some(
    (word) =>
      SECRET_ENV_NAME_WORDS.includes(word) ||
      SECRET_ENV_NAME_WORD_SUFFIXES.some((suffix) => word.endsWith(suffix)),
  );
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
