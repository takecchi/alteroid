import { CREDENTIAL_NAME, type CredentialEntry } from './credentials.js';
import { assertNoNul } from './nul-guard.js';

// 例外の文に名前を載せない: 名前が秘密を含みうるため。pg の DB エラーに任せない: 3実装で同じ例外にそろえるため
export class InvalidCredentialNameError extends Error {
  constructor() {
    super('資格の名前が環境変数の名前の形（CREDENTIAL_NAME）に合わないので、受け付けない');
    this.name = 'InvalidCredentialNameError';
  }
}

// 書く前に全件検査する: 途中まで書いて落とさないため
export function assertValidCredentialEntries(entries: readonly CredentialEntry[]): void {
  for (const entry of entries) {
    assertNoNul('credential.name', entry.name);
    if (!CREDENTIAL_NAME.test(entry.name)) throw new InvalidCredentialNameError();
    assertNoNul('credential.value', entry.value);
  }
}
