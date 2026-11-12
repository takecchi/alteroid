import { retiredEnvWarnings } from '@alteroid/core';

// `index.ts` は import すると起動してしまうので、起動のときの警告をここへ切り出した（試験で出力を確かめるため）。

/**
 * 外した環境変数が置かれていれば、変数ごとに1行を `write` へ渡す（`alteroid-runner: ` の接頭辞と改行を付ける）。
 * 名前だけで、値は載せない。一覧は daemon と共有し、全部を言う（別プロセスなので二重に言ってよい。
 * runner だけに Service 変数を置く構成でも、共有の変数（Shared Variables）経由でも、置いた先で必ず拾えるため）。
 */
export function warnRetiredEnv(env: NodeJS.ProcessEnv, write: (line: string) => void): void {
  for (const line of retiredEnvWarnings(env)) write(`alteroid-runner: ${line}\n`);
}
