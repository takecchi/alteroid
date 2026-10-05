import { CREDENTIAL_NAME, type CredentialEntry } from './credentials.js';
import { assertNoNul } from './nul-guard.js';

/**
 * `CredentialVaultStore.put` が受け付けない名前（`CREDENTIAL_NAME` に合わない。空文字を
 * 含む）を、入口で3実装とも同じ例外で断る（issue #2927 の項目4）。
 *
 * 以前は fs だけが不正な名前の行を戻り値に含め（`list()` は同じ行を読み飛ばす）、
 * pg は戻り値から除いていた。断れば差そのものが消える。pg の DB エラーに任せない。
 * **例外の文に名前を載せない**（{@link import('./nul-guard.js').NulNotAllowedError} と同じ理由）。
 */
export class InvalidCredentialNameError extends Error {
  constructor() {
    super('資格の名前が環境変数の名前の形（CREDENTIAL_NAME）に合わないので、受け付けない');
    this.name = 'InvalidCredentialNameError';
  }
}

/**
 * `put` の入力を、書く前に全件検査する（途中まで書いて落とさない）。
 * 名前の NUL・不正な名前・値の NUL のいずれかで投げる。値が空文字（「外す」）でも
 * 名前は検査する。
 */
export function assertValidCredentialEntries(entries: readonly CredentialEntry[]): void {
  for (const entry of entries) {
    assertNoNul('credential.name', entry.name);
    if (!CREDENTIAL_NAME.test(entry.name)) throw new InvalidCredentialNameError();
    assertNoNul('credential.value', entry.value);
  }
}
