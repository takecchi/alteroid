import { describe, expect, it } from 'vitest';

import {
  CLONE_ALLOWED_PERMISSION_RULES,
  RELEASE_PUBLISH_REPOS,
  releasePublishRule,
} from './permission-rules.js';

/**
 * **許可の広さそのものに歯を当てる。**
 *
 * ここで守っているのは「動くこと」ではなく「**広すぎないこと**」である。許可の規則は
 * 広げても何も落ちない —— 広げた瞬間に赤くなる歯が無ければ、広がったことは
 * どこにも現れない。だから**規則の文字列そのもの**を書き写して固定する。
 *
 * **⚠️ 期待値を「実装が返す値」から作らないこと。** `releasePublishRule` を呼んで
 * 突き合わせると、関数を広げる変異がそのまま期待値も広げるので**何も測らなくなる。**
 * 下の `it` はどれもリテラルを直接書いてある。
 */
describe('恒久的な許可の規則', () => {
  it('通すのは2本だけで、文字列はこの形である', () => {
    expect(CLONE_ALLOWED_PERMISSION_RULES).toEqual([
      'Bash(gh release edit --repo virchamate/virchamate-backend --draft=false:*)',
      'Bash(gh release edit --repo virchamate/virchamate-frontend --draft=false:*)',
    ]);
  });

  it('名指しする repo は2つだけで、ワイルドカードを含まない', () => {
    expect(RELEASE_PUBLISH_REPOS).toEqual([
      'virchamate/virchamate-backend',
      'virchamate/virchamate-frontend',
    ]);
    for (const repo of RELEASE_PUBLISH_REPOS) {
      expect(repo).not.toContain('*');
    }
  });

  /**
   * **`--draft=false` が規則に焼き込まれていること。**
   *
   * 落とすと `--draft=true`（公開の取り消し）まで同じ規則で通る。**広げる向きの
   * 変異がここで赤くなる**のが、この歯を置いた唯一の理由である。
   */
  it('どの規則も --draft=false を含む（公開の取り消しは通らない）', () => {
    for (const rule of CLONE_ALLOWED_PERMISSION_RULES) {
      expect(rule).toContain('--draft=false');
    }
  });

  /**
   * **`gh release` で始まる広い形になっていないこと。**
   *
   * `Bash(gh release:*)` まで広げると `gh release delete` が通る。規則が
   * `gh release edit --repo <repo> --draft=false` まで書かれていることを、
   * 開いている部分（`:*`）の位置で測る。
   */
  it('開いているのは末尾の tag だけである', () => {
    for (const rule of CLONE_ALLOWED_PERMISSION_RULES) {
      // `Bash(` と `)` を剥いだ中身。
      expect(rule.startsWith('Bash(')).toBe(true);
      expect(rule.endsWith(')')).toBe(true);
      const content = rule.slice('Bash('.length, -1);

      // `:*` は末尾に1つだけ（SDK の規則検査が要求する位置）。
      expect(content.endsWith(':*')).toBe(true);
      expect(content.slice(0, -2)).not.toContain(':*');

      // `*` は末尾の `:*` 以外に1つも無い ＝ コマンドの途中は開いていない。
      expect(content.slice(0, -2)).not.toContain('*');
    }
  });

  /**
   * 🔴 **規則の文字列にコンマを入れない。**
   *
   * SDK は `Options.allowedTools` の配列を `,` で繋いで `--allowedTools` の
   * **1引数**にする。⟹ コンマを含む規則はその位置で**2本の別々の規則として割れる。**
   * 割れた片方が何に当たるかは誰も宣言していないので、**書いた人が意図していない
   * 広さが静かに通る。**
   *
   * **⚠️ これは「いまの2本にコンマが無い」を確かめる歯ではない。**
   * {@link CLONE_ALLOWED_PERMISSION_RULES} に**将来足される規則**を含めて測るために、
   * 配列の全要素を回している。3本目を足した人がコンマを含めたら、ここで赤くなる。
   */
  it('どの規則にもコンマが含まれない（SDK が , で繋いで1引数にするため）', () => {
    for (const rule of CLONE_ALLOWED_PERMISSION_RULES) {
      expect(
        rule.includes(','),
        `許可の規則にコンマが含まれている: ${rule}\n` +
          'SDK は allowedTools を "," で繋いで --allowedTools の1引数にする。' +
          'コンマを含む規則はその位置で2本に割れ、割れた片方が何に当たるかは誰も宣言していない ' +
          '＝ 書いた人が意図していない広さが静かに通る。コンマを使わない形で書き直すこと。',
      ).toBe(false);
    }
  });

  /**
   * **`releasePublishRule` は `--draft=false` を引数に取らない。**
   *
   * 取れる形にすると「`--draft=true` も同じ関数で書ける」ので、広げるほうの変更が
   * 「引数を1つ変えるだけ」に見える。**引数は repo 名1つだけである**ことを、
   * 関数の arity で固定する。
   */
  it('規則を作る関数は repo 名しか受け取らない', () => {
    expect(releasePublishRule.length).toBe(1);
    expect(releasePublishRule('owner/name')).toBe(
      'Bash(gh release edit --repo owner/name --draft=false:*)',
    );
  });
});
