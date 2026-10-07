import { redactErrorText, redactSecretsInBody } from '@alteroid/core/redact';

// TUI でも Ink の掃除に頼らない: Ink は SGR と OSC を残し、BEL・BS・NUL・`\r`・C1 の OSC を素通しにするため
// `\r` も落とす: 同じ行の前の文字を上書きして偽の表示を作れるため
const TERMINAL_CONTROL_SEQUENCES =
  // eslint-disable-next-line no-control-regex -- 制御文字の検出そのものが目的
  /\u001b[\]PX^_][^\u0007\u001b\u009c]*(?:\u0007|\u001b\\|\u009c)|\u001b\[[0-?]*[ -/]*[@-~]|\u009b[0-?]*[ -/]*[@-~]|\u009d[^\u0007\u001b\u009c]*(?:\u0007|\u001b\\|\u009c)|\u001b[ -/]*[0-~]|[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

export function sanitizeForTerminal(text: string): string {
  return text.replace(TERMINAL_CONTROL_SEQUENCES, '');
}

// env を渡さない: 環境変数の値の網は `GIT_AUTHOR_NAME` など名前に `AUTH` を含む変数の値まで伏せ、本文や error のオーナー名・repo 名が化けるため
// 掃除を先、伏せ字を後にする: 逆だと秘密の途中へ挟まれた制御文字で伏せ字をすり抜け、掃除のあとで1つの秘密に繋がるため
export function redactBody(text: string): string {
  return redactSecretsInBody(sanitizeForTerminal(text), undefined);
}

export function redactError(text: string): string {
  return redactErrorText(sanitizeForTerminal(text), undefined);
}

export function redactedErrorMessage(error: unknown): string {
  return redactError(error instanceof Error ? error.message : String(error));
}
