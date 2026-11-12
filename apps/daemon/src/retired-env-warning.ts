import { retiredEnvWarnings } from '@alteroid/core';

// `index.ts` は import すると起動してしまうので、起動のときの警告をここへ切り出した（試験で出力を確かめるため）。

/**
 * 外した環境変数が置かれていれば、変数ごとに1行を `write` へ渡す（`alteroidd: ` の接頭辞と改行を付ける）。
 * 名前だけで、値は載せない。
 */
export function warnRetiredEnv(env: NodeJS.ProcessEnv, write: (line: string) => void): void {
  for (const line of retiredEnvWarnings(env)) write(`alteroidd: ${line}\n`);
}
