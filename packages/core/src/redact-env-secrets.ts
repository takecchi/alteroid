// 単純な文字列置換なので、値が変形されて出てきた場合までは塞げない。塞いだことにしない。
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
