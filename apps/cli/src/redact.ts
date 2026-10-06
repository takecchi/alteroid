/**
 * 入口（CLI・TUI）が画面へ出す文字列に掛ける伏せ字の口（issue #2600）。
 *
 * デーモンは会話・委譲の生ログ・承認待ち・日誌を素のまま返す。だから出す側で通す。
 * 2つに分ける理由は `@alteroid/core/redact` の doc のとおり:
 * - 本文（人や agent が書いた自由文）: {@link redactBody}。sha・UUID・枝名を化かさない狭い網
 * - error の文（API の `error`・例外の message）: {@link redactError}。取りこぼしより誤伏せを選ぶ
 *
 * id・時刻・URL の欄には掛けない。
 *
 * **env は渡さない（Web と同じく字面の規則だけ）。** core の環境変数の値の網は、名前に
 * `AUTH` などを部分に含む変数（`GIT_AUTHOR_NAME` など）の値まで伏せるので、本文や error に
 * 出るオーナー名・repo 名が化ける。名前の規則は #1834 と一緒に決める（判断待ち）。
 */
import { redactErrorText, redactSecretsInBody } from '@alteroid/core/redact';

/**
 * 端末へ書く文字列から、端末が解釈してしまう制御文字を落とす（#3414 #3448 #3455）。
 *
 * 外から来た文字列（クローンの返答・ツール出力・取得した Web の中身・上流 API の文言）に
 * `ESC [2J`（画面消去）・`ESC ] 0 ; … BEL`（タイトル書き換え）・OSC 52（クリップボード）が
 * 入っていると、使う人の端末がそれを実行する。CLI の `stdout.write` は落とさない。
 * **TUI も Ink には頼らない**（#3498）。Ink 7.1.1 は SGR と OSC を残し、BEL・BS・NUL・`\r`・C1 の OSC（U+009D）・
 * U+009B に SGR が続く列を素通しにする。TUI は描く文字列を、組み立てたあとにこの関数へ通す。
 *
 * **落とすもの（SGR＝色も含めて全部）:**
 * - ESC で始まる列: CSI（`ESC [ … 終端`）・OSC / DCS / SOS / PM / APC（`ESC ] … BEL|ST` など。中身ごと）・
 *   その他の 2 文字以上の ESC 列（`ESC ( B` など）・単独の ESC
 * - 8 ビット形の C1（U+0080〜U+009F）。CSI（U+009B）・OSC（U+009D）の列は中身ごと、残りは1字ずつ
 * - C0（U+0000〜U+001F）のうち `\n`（U+000A）と `\t`（U+0009）以外。`\r`・BEL・BS・FF・VT・NUL を含む
 * - DEL（U+007F）
 *
 * **`\r` は落とす。** 行頭へ戻る文字なので、同じ行の前の文字を上書きして偽の表示を作れる。
 * CRLF の `\r\n` は `\n` になり、見た目は変わらない（この CLI は自分では `\r` を書かない）。
 *
 * **秘密の伏せ字との順序は「掃除が先、伏せ字が後」**（{@link redactBody}・{@link redactError}）。
 * 伏せ字が先だと、秘密の途中へ制御文字を挟まれたとき（`ghp_aaaa` `ESC[0m` `bbbb…`）、規則に合わずに
 * 伏せ字をすり抜け、掃除のあとで1つの秘密に繋がって端末へ出る。先に掃除すれば、伏せ字の網は
 * 端末へ出るのと同じ文字列を見る。
 *
 * 冪等である（掃除済みの文字列に掛け直しても変わらない）。
 */
// 長い列から順に並べる。OSC / DCS 系は終端（BEL・ESC \・U+009C）まで。終端が無いものは、
// 下の「ESC + 1 字」の規則が ESC と次の1字を落とす（残る本文は見えるだけで、実行されない）。
const TERMINAL_CONTROL_SEQUENCES =
  // eslint-disable-next-line no-control-regex -- 制御文字の検出そのものが目的
  /\u001b[\]PX^_][^\u0007\u001b\u009c]*(?:\u0007|\u001b\\|\u009c)|\u001b\[[0-?]*[ -/]*[@-~]|\u009b[0-?]*[ -/]*[@-~]|\u009d[^\u0007\u001b\u009c]*(?:\u0007|\u001b\\|\u009c)|\u001b[ -/]*[0-~]|[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

export function sanitizeForTerminal(text: string): string {
  return text.replace(TERMINAL_CONTROL_SEQUENCES, '');
}

/** 本文（会話・委譲・承認待ち・日誌の自由文）。端末向けの掃除を先に通す。 */
export function redactBody(text: string): string {
  return redactSecretsInBody(sanitizeForTerminal(text), undefined);
}

/** error の文。端末向けの掃除を先に通す。 */
export function redactError(text: string): string {
  return redactErrorText(sanitizeForTerminal(text), undefined);
}

/** `unknown` の例外・値を error の文にして伏せる（`Error` なら message）。 */
export function redactedErrorMessage(error: unknown): string {
  return redactError(error instanceof Error ? error.message : String(error));
}
