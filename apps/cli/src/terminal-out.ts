import { sanitizeForTerminal } from './redact.js';

interface Out {
  write(text: string): boolean;
  writeRaw(text: string | Uint8Array): boolean;
  readonly isTTY: boolean;
}

// 書く先を呼び出しのたびに引く: テストの spy が効くように
function out(stream: () => NodeJS.WriteStream): Out {
  return {
    write: (text) => stream().write(sanitizeForTerminal(text)),
    writeRaw: (text) => stream().write(text),
    get isTTY() {
      return stream().isTTY;
    },
  };
}

export const stdout: Out = out(() => process.stdout);
export const stderr: Out = out(() => process.stderr);

// パイプ・リダイレクトでは掃除しない: 本文を別の道具へ流す使い方があり、変えると中身が壊れるため
export function writeShownBody(target: Out, body: string): void {
  if (target.isTTY === true) target.write(body);
  else target.writeRaw(body);
}
