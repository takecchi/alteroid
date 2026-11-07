import { describe, expect, it } from 'vitest';

import {
  coreSourceFiles,
  enclosingDeclaration,
  JOURNAL_SELF_SOURCES,
  readCloneSource,
  readCoreSource,
  splitGroup,
  squash,
} from './clone-source-scan.test-support.js';

// clone.ts で日誌へ `with: 'self'` の1行を書く箇所を、塊ごとに `#journalSelf(role, text)` へ寄せていく（#6333 で最初の塊）。
// 寄せる変更が壊しうるのは、各箇所の `role` と `text` の式だけである（helper の中身は `#journal({ type: 'exchange', with: 'self', role, text })` の1行）。
// そこで、書き込み箇所すべてについて「囲むメソッド・role・text の式」を取り出し、その一覧を固定する。
// 寄せる前（`this.#journal({ type: 'exchange', with: 'self', role, text })`）と寄せた後（`this.#journalSelf(role, text)`）は、同じ1行として取り出される。
// 式の畳み方（コードの空白は畳み、文字列は1文字ずつ比べる）は `clone-source-scan.test-support.ts` の `squash`。

interface SelfSite {
  readonly start: number;
  readonly line: string;
}

/** `with: 'self'` の exchange の書き込み箇所を、出てくる順に「囲むメソッド role text」の1行で返す。 */
function selfSites(text: string): string[] {
  const sites: SelfSite[] = [];
  const literalRe = /\bthis\.#journal\(\{/g;
  let m: RegExpExecArray | null;
  while ((m = literalRe.exec(text)) !== null) {
    const open = m.index + m[0].length - 1;
    const fields = new Map<string, string>();
    for (const raw of splitGroup(text, open)) {
      const part = squash(raw);
      const field = /^([A-Za-z_$][\w$]*)\s*:/.exec(part);
      if (field === null) fields.set(part, part);
      else fields.set(field[1]!, part.slice(field[0].length).trim());
    }
    if (fields.get('type') !== "'exchange'" || fields.get('with') !== "'self'") continue;
    // 欄が4つを超える行（`conversationId` などを持つ）は寄せない。区別のため印を付けて一覧に残す
    const extra = [...fields.keys()].filter(
      (key) => !['type', 'with', 'role', 'text'].includes(key),
    );
    const mark = extra.length === 0 ? '' : ` [+${extra.join(',')}]`;
    sites.push({
      start: m.index,
      line: `${enclosingDeclaration(text, m.index)} ${squash(fields.get('role') ?? '?')} ${squash(fields.get('text') ?? '?')}${mark}`,
    });
  }
  const helperRe = /\bthis\.#journalSelf\(/g;
  while ((m = helperRe.exec(text)) !== null) {
    const open = m.index + m[0].length - 1;
    const [role, textExpression] = splitGroup(text, open);
    sites.push({
      start: m.index,
      line: `${enclosingDeclaration(text, m.index)} ${squash(role ?? '?')} ${squash(textExpression ?? '?')}`,
    });
  }
  return sites.sort((a, b) => a.start - b.start).map((site) => site.line);
}

/**
 * 試験の名前。clone.ts の分は、ファイルを増やす前の名前のまま（スナップショットの名前を変えないため）。
 * スナップショットはファイルごとに別にする: 連結して読むと、箇所の並び（`start` の順）がファイルをまたいで変わるため。
 */
function titleOf(file: string, title: string): string {
  return file === 'clone.ts' ? title : `${file}: ${title}`;
}

describe('clone.ts の、日誌へ with: self の1行を書く箇所の role と text の式を固定する（#journalSelf へ寄せる前後で変わらないことの歯）', () => {
  for (const file of JOURNAL_SELF_SOURCES) {
    it(titleOf(file, '書き込み箇所の一覧（囲むメソッド・role・text の式）が変わらない'), () => {
      expect(selfSites(readCoreSource(file))).toMatchSnapshot();
    });
  }

  it('走査が箇所を見つけられない状態（走査の故障）を通さない', () => {
    // 寄せ終わっても `#journalSelf(` の呼び出しとして数えられるので、0 にはならない
    expect(selfSites(readCloneSource()).length).toBeGreaterThan(50);
    for (const file of JOURNAL_SELF_SOURCES) {
      expect(selfSites(readCoreSource(file)).length, file).toBeGreaterThan(0);
    }
  });

  it('with: self の書き込み箇所を持つソースは、すべて走査の対象に載っている（協力者へ切り出したときの足し漏れを通さない）', () => {
    const listed: readonly string[] = JOURNAL_SELF_SOURCES;
    const unlisted = coreSourceFiles()
      .filter((file) => !listed.includes(file))
      .filter((file) => selfSites(readCoreSource(file)).length > 0);
    expect(unlisted).toEqual([]);
  });
});
