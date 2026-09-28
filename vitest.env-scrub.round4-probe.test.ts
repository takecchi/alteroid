import { describe, expect, it } from 'vitest';

import { isSecretEnvName } from './vitest.env-scrub';

/**
 * 領域D 4周目点検・確かめ用（コミットしない）。#1834 の範囲（語の規則に
 * 当たらない名前・URL に入った資格）は対象外として数えない。
 *
 * 疑い: `SECRET_ENV_NAME_WORDS` には `KEY`/`CREDENTIAL`/`PASS`/`PASSPHRASE`/
 * `PAT`/`COOKIE`/`DSN` 等が「完全一致の語」として載っているが、
 * `SECRET_ENV_NAME_WORD_SUFFIXES`（区切り無しの連結形を拾う側）には
 * `PASSWORD`/`TOKEN`/`SECRET` の3つしか無い。⟹ 区切り（`_`）を挟まずに
 * `KEY` 等で終わる名前（`FAKE_ROUND4_ACCESSKEY` のような、`_` の代わりに
 * 連結してある実在しそうな命名）は、単語分割でも完全一致にならず、
 * suffix 側にも `KEY` が無いので外れないのではないか。
 *
 * すべて偽の名前・偽の値のみを使う（本物の環境変数名は書かない）。
 */
describe('round4-probe: isSecretEnvName の語の規則の抜け（疑い）', () => {
  it('連結形で KEY 終わり（アンダースコア無し）: 期待は true（外れるべき）', () => {
    expect(isSecretEnvName('FAKE_ROUND4_ACCESSKEY')).toBe(true);
  });

  it('連結形で SECRETKEY 終わり: 期待は true（外れるべき）', () => {
    expect(isSecretEnvName('FAKE_ROUND4_SERVICESECRETKEY')).toBe(true);
  });

  it('連結形で CREDENTIAL 終わり（アンダースコア無し）: 期待は true（外れるべき）', () => {
    expect(isSecretEnvName('FAKE_ROUND4_AUTHCREDENTIAL')).toBe(true);
  });

  it('連結形で PASS 終わり（アンダースコア無し、PASSWORD ではない）: 期待は true（外れるべき）', () => {
    expect(isSecretEnvName('FAKE_ROUND4_DBPASS')).toBe(true);
  });

  // 対照: アンダースコアで区切られていれば単語一致で拾えるはず（既存の設計どおり）
  it('対照: アンダースコア区切りの _KEY は拾える', () => {
    expect(isSecretEnvName('FAKE_ROUND4_ACCESS_KEY')).toBe(true);
  });

  it('対照: アンダースコア区切りの _PASS は拾える', () => {
    expect(isSecretEnvName('FAKE_ROUND4_DB_PASS')).toBe(true);
  });

  // 対照: 大文字小文字違い・接頭辞規則（既存設計が既にケースを吸収しているはず）
  it('対照: 大小文字混在の GH_ 接頭辞は拾える', () => {
    expect(isSecretEnvName('gH_faKe_Token')).toBe(true);
  });
});
