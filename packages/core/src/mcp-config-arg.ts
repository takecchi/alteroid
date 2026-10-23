const FLAG = '--mcp-config';
const FLAG_EQUALS = `${FLAG}=`;

// 先頭が `{` のものだけを JSON と見なす: それ以外は CLI が既にファイルのパスとして読むもので、書き出し直す理由が無い
function isInlineJson(value: string): boolean {
  return value.trimStart().startsWith('{');
}

/**
 * CLI の引数列の `--mcp-config <JSON>` / `--mcp-config=<JSON>` を、`writeJson` が返すパスへ差し替えた新しい列を返す。
 * 引数列は同じ器のどのプロセスからも読める（`ps`）が、ファイルは持ち主と mode で守れる: MCP の `env`・`headers` の資格を argv に載せないため。
 * `writeJson` が投げたら握り潰さずそのまま投げる: 元の引数のまま起こすと資格が argv へ戻るため。
 */
export function relocateMcpConfigArgs(
  args: readonly string[],
  writeJson: (json: string) => string,
): string[] {
  const out: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string;
    if (arg === FLAG && index + 1 < args.length) {
      const value = args[index + 1] as string;
      out.push(arg, isInlineJson(value) ? writeJson(value) : value);
      index += 1;
    } else if (arg.startsWith(FLAG_EQUALS)) {
      const value = arg.slice(FLAG_EQUALS.length);
      out.push(isInlineJson(value) ? `${FLAG_EQUALS}${writeJson(value)}` : arg);
    } else {
      out.push(arg);
    }
  }
  return out;
}
