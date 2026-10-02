/**
 * `UsageProbeOptions.env` に渡した値（候補トークンなど）を、文字列から取り除く。
 *
 * **理由の文字列は、呼び出し元が保存したり画面に出したりしうる。** `env` の doc に
 * 書いたとおり「ここへ渡す値は資格そのものになりうる」ので、SDK やその配下が
 * 例外メッセージへ値をそのまま含めて返してきても、`reason` へ漏らさないための
 * 最後の網である。**単純な文字列置換なので、値が変形されて出てきた場合までは
 * 塞げない**（これは「塞げないと分かっていることを塞いだことにしない」ため、
 * ここに明記する）。
 */
export function redactEnvSecrets(text: string, env: NodeJS.ProcessEnv | undefined): string {
  if (env === undefined) return text;
  let result = text;
  for (const value of Object.values(env)) {
    if (typeof value === 'string' && value.length > 0) {
      result = result.split(value).join('[REDACTED]');
    }
  }
  return result;
}
