import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('account-list.ts は読むだけで、個人の情報を持ち出さない（#2546。#2645 の判断待ち）', () => {
  const source = readFileSync(new URL('./account-list.ts', import.meta.url), 'utf8');
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/'[^'\n]*'|`[^`]*`/g, '""');

  it('書き手の口（付与・取り消し・owner の宣言・消す口・put 系）に触れない', () => {
    expect(code).not.toMatch(
      /\.(grantAccess|revokeAccess|removeUnreadable\w*|put\w*|create\w*|delete\w*|remove\w*|revoke\w*|grant\w*)\s*\(/,
    );
  });

  it('ストアへ届くのは listAccounts / listUnreadableAccounts の2つだけ', () => {
    const touched = [...code.matchAll(/stores\.auth\.(\w+)/g)].map((m) => m[1]);
    expect(touched.sort()).toEqual(['listAccounts', 'listUnreadableAccounts']);
  });

  it('email・displayName・identity・トークンの欄を読まない', () => {
    expect(code).not.toMatch(/\b(email|displayName|identit\w*|sha256|listAccessTokens)\b/i);
  });
});

describe('tools.ts は stores.auth に直接触れない（account_list の本体は account-list.ts に置く）', () => {
  it('tools.ts のソースに stores.auth の字面が無い', () => {
    const source = readFileSync(new URL('./tools.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/stores\.auth\b/);
  });
});
