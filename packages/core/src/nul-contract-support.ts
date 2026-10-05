import { NulNotAllowedError } from './nul-guard.js';

/**
 * NUL の契約（issue #2927）が共有する小道具。vitest に依存しない。
 * `fn` が `NulNotAllowedError` を投げたことを確かめ、文に `secret`（値・名前の一部）が
 * 載っていないことも確かめる。違えば `fail` で落とす。
 */
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
