// 規則ではなく、テストが始まる前に環境そのものから外す: テストが製品のコードの `spawn(..., { env: process.env })` をモックして assertion を落とすと、vitest がモックの引数を丸ごと出力し、本物の値が出力やログへ出るため。「`env: {}` を渡せ」という規則は、製品のコードが自分で `process.env` を読む経路には当たらず防げない。
// 値ではなく名前で外す: 値の形で秘密を見分けると、短い鍵や未知の形式を取りこぼすため。迷ったら外す側へ倒す（テストが本物の値を要るなら、そのテストが偽の値を自分で置く）。
// 語の単位でも見る: 末尾一致だけだと、語の後ろに何かが付いた名前（`ALTEROID_RUNNER_TOKEN_SHA256`・`PGPASSWORD`）が漏れるため。語の単位なら `GIT_AUTHOR_NAME` の `AUTHOR` のような、秘密の語を部分に含むだけの語は巻き込まない。
export const SECRET_ENV_NAME_PATTERNS: readonly RegExp[] = [
  /^GH_/i,
  /^GITHUB_TOKEN$/i,
  /^CLAUDE_CODE_/i,
  /^ANTHROPIC_/i,
  /(^|_)DATABASE_URL$/i,
  /(^|_)DB_URL$/i,
  // OAuth の client の ID も外す: 単独では秘密ではないが、client secret と組にして子プロセスから隠しているため。
  /_CLIENT_ID$/i,
];

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

export const SECRET_ENV_NAME_WORD_SUFFIXES: readonly string[] = ['PASSWORD', 'TOKEN', 'SECRET'];

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

export function scrubSecretEnv(env: NodeJS.ProcessEnv): string[] {
  const removed: string[] = [];
  for (const name of Object.keys(env)) {
    if (!isSecretEnvName(name)) continue;
    delete env[name];
    removed.push(name);
  }
  return removed;
}
