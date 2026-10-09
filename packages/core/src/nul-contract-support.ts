import { NulNotAllowedError } from './nul-guard.js';

// vitest に依存しない: 失敗の出し方は `fail` で受ける。
export async function expectNulRejected(
  fail: (message: string) => never,
  label: string,
  fn: () => Promise<unknown>,
  secret: string,
): Promise<void> {
  let thrown: unknown;
  try {
    await fn();
  } catch (error) {
    thrown = error;
  }
  if (!(thrown instanceof NulNotAllowedError)) {
    fail(
      `${label}は NulNotAllowedError で断る（実際: ${thrown === undefined ? '投げなかった' : String(thrown)}）`,
    );
  }
  if (secret.length > 0 && thrown.message.includes(secret)) {
    fail(`${label}の例外の文に値を載せない`);
  }
}
