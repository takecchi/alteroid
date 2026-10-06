/**
 * CLI が端末へ書く口（#3414 #3448 #3455）。**書く文字列から、端末が解釈する制御文字
 * （{@link sanitizeForTerminal}）を落としてから書く。**
 *
 * `process.stdout.write` を直に呼ぶと、外から来た文字列（クローンの返答・記憶の本文・上流の
 * error など）の ESC 列が使う人の端末で実行される。この CLI は自分では ESC を書かない
 * （画面消去の `topology --watch` だけは `writeRaw` を使う）ので、
 * 口の側で一律に掃除する。個々の欄で掃除を忘れても、ここで落ちる。
 *
 * - 書く先は呼び出しのたびに `process.stdout` / `process.stderr` から引く（テストの spy が効く）
 * - **機械が読む出力（`--json`）と、パイプへ渡す本文（`memory show` / `practice show`）は
 *   `writeRaw`** で書く。掃除すると中身が変わる
 * - readline の `output` には、これではなく本物の `process.stdout` を渡す
 */
import { sanitizeForTerminal } from './redact.js';

interface Out {
  /** 制御文字を落として書く。 */
  write(text: string): boolean;
  /** 掃除せずに書く。JSON・添付のバイト列・パイプへ渡す本文・自前の画面制御だけ。 */
  writeRaw(text: string | Uint8Array): boolean;
  readonly isTTY: boolean;
}

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

/**
 * `memory show` / `practice show` の本文を書く。**端末へ出すときだけ掃除する**（#3455）。
 * パイプ・リダイレクトのときは本文をそのまま渡す（本文を別の道具へ流す使い方があり、
 * 勝手に変えると中身が壊れる）。端末に出さないので、端末が解釈する心配も無い。
 */
export function writeShownBody(target: Out, body: string): void {
  if (target.isTTY === true) target.write(body);
  else target.writeRaw(body);
}
