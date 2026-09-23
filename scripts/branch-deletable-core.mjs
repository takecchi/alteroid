/**
 * `branch-deletable.mjs`（`pnpm branch:deletable -- <枝名> [<枝名> ...]`）の
 * 判定だけを切り出したもの（`check-no-attribution-trailers-core.mjs` と同じ
 * 分け方——ネットワーク（`git grep` / `gh`）は呼び出し側に置き、ここは
 * 合成データだけで判定を撃てるようにする）。
 *
 * ## 何のために在るか
 *
 * 2026-09-20 に枝26本が一括削除された。そのうち9本には「この枝は残す／
 * 消さないこと」という明示の言明が、削除より前から在った——6本は close
 * コメント（`.claude/skills/branch-cleanup/SKILL.md`「0段目」）、3本は Issue
 * のコメントか、`main` のソースがその枝名を出典として指す形（
 * `packages/core/src/archive-prune.ts` が `investigate/698-*` を
 * `git show origin/<枝>:<path>` の形で参照していた）。
 *
 * 削除リストを承認する側に、この9本の印が見えていれば判断材料になった。
 * いまは `branch-cleanup/SKILL.md` の0段目に prose の手順があるだけで、
 * 機械で集める道具が無い。この道具は**判定を下さない**——「消してよい」
 * とは出力しない。**消す前に必ず見るべきものを集めて出すだけ**である。
 *
 * ## 検査は2本
 *
 * - **検査A**: その枝の名前が `main` の追跡ファイルに現れるか
 *   （`git grep -n -F -- '<枝名>' origin/main` の生出力を解釈する）
 * - **検査B**: その枝を head とする PR（state を問わない）のコメントか本文に、
 *   保持の言明が在るか
 *
 * ## 検査Bの判定は「同じ文の中に『枝』と保持語」であって、定型句の一致ではない
 *
 * ⚠️ **狭いパターンだと静かに取りこぼす（実測）。** 「枝は残る」という
 * 完全一致だけで26本の削除枝を測ると、`fix/1130-pr-body-diff-claim-measurement`
 * （逐語は「枝（`fix/1130-...`）は残る」——枝名が「枝」と「は残る」のあいだに
 * 挟まる）と `ci/1171-railway-typecheck` が窓から落ち、8本のはずの当たりが
 * 6本に減った。`AGENTS.md`「静かに失敗する道具」と同じ形——**エラーは出ず、
 * 小さい数が返るだけ**である。
 *
 * ⟹ だからこの道具は定型句を探さない。**同じテキスト（1件のコメント・
 * 1件の PR 本文）の中に、保持語（`RETENTION_WORDS`）のどれかと、枝を指す語
 * （`BRANCH_WORDS`）のどちらかが両方在るか**だけを見る。近接や語順は見ない。
 *
 * ⚠️ **この判定は誤検出を生む。それは仕様である。** 「枝」と保持語が同じ
 * コメントに在っても、文意が逆（「この枝は残す理由が無い。削除してよい」）
 * のことがある。実測（2026-09-20 に削除された26本）: 検査Bは8本に当たるが、
 * そのうち `chore/dependabot-config` と `test/1041-toctou-stage0` の2本は
 * 誤検出——本物の保持の約束は残り6本である。**判定するのは人間で、この道具
 * は「読むべき箇所」を集めるだけ**なので、誤検出を減らそうとして語の組を
 * 狭めると、上のとおり本物を取りこぼす側へ倒れる。狭めないこと。
 *
 * ## 「判定できない」という3つ目の状態は持たない
 *
 * 検査A・検査Bはどちらも「0件」を答えられる（該当が無いことは正常な結果で
 * ある）。ただし呼び出し側（`git grep` / `gh` 呼び出し）が失敗した場合は
 * `unreadable` 的な扱いをせず、**そのエラーをそのまま出力に出す**——この道具
 * は判定を下さないので、fail-closed の「赤」という概念自体が無い。読めな
 * かったことも「読め」の材料の一部として見せる。
 */

/** 枝を指す語。どちらかが在れば「枝の話をしている」とみなす。 */
export const BRANCH_WORDS = ['枝', 'ブランチ'];

/**
 * 保持の言明を示す語（依頼者が2026-09-20 の削除26本から実測で決めた一覧）。
 * ⚠️ **狭めないこと。** 上のdocの実測がこの一覧の広さの理由である。
 */
export const RETENTION_WORDS = [
  '残す',
  '残る',
  '残しま',
  '残して',
  '消しません',
  '消さない',
  '消していない',
  '削除してはいけない',
  '削除候補ではない',
];

/** `text` の中に枝を指す語が在るか。 */
export function hasBranchWord(text) {
  if (typeof text !== 'string' || text.length === 0) return false;
  return BRANCH_WORDS.some((w) => text.includes(w));
}

/**
 * `text` の中に在る保持語を、最初に出てきた位置つきで集める
 * （1語につき最初の出現だけ。同じ語が複数回出てもfindingsは1件）。
 */
export function findRetentionWordHits(text) {
  if (typeof text !== 'string' || text.length === 0) return [];
  const hits = [];
  for (const word of RETENTION_WORDS) {
    const index = text.indexOf(word);
    if (index !== -1) hits.push({ word, index });
  }
  return hits;
}

/**
 * `index`（`matchLength` 文字ぶん）を中心に、前後 `radius` 文字ほどを切り出す。
 * 判定ではなく「現物を見せる」ための抜粋なので、境界は文字単位でよい
 * （形態素・書記素の境界は見ない）。
 */
export function excerptAround(text, index, matchLength, radius = 150) {
  const start = Math.max(0, index - radius);
  const end = Math.min(text.length, index + matchLength + radius);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < text.length ? '…' : '';
  return prefix + text.slice(start, end) + suffix;
}

/**
 * 1件のテキスト（1件のコメント・1件の PR 本文）を検査Bの判定に掛ける。
 *
 * 「枝」または「ブランチ」が在り、かつ保持語のどれかが在るときだけ
 * `promising: true` とし、当たった保持語ごとに前後150文字の抜粋を返す。
 * ⚠️ 判定ではない——`promising` は「読むべき」の印であって「保持される」の
 * 断定ではない（上のdocのとおり誤検出を含む）。
 */
export function evaluateRetentionPromise(text) {
  if (typeof text !== 'string' || text.length === 0) {
    return { promising: false, hits: [] };
  }
  if (!hasBranchWord(text)) {
    return { promising: false, hits: [] };
  }
  const retentionHits = findRetentionWordHits(text);
  if (retentionHits.length === 0) {
    return { promising: false, hits: [] };
  }
  const hits = retentionHits.map(({ word, index }) => ({
    word,
    excerpt: excerptAround(text, index, word.length),
  }));
  return { promising: true, hits };
}

/**
 * 検査Bの1つの枝ぶんの材料（複数の PR、それぞれの本文とコメント）を評価し、
 * 当たった箇所を1本のフラットな配列にする。
 *
 * @param {{ prNumber: number|string, source: string, text: string }[]} sources
 *   `source` は「本文」「コメント(id 123)」のような、人が読んで場所が分かる印。
 * @returns {{ prNumber: number|string, source: string, word: string, excerpt: string }[]}
 */
export function evaluateRetentionSources(sources) {
  const hits = [];
  for (const src of sources ?? []) {
    const result = evaluateRetentionPromise(src?.text);
    if (!result.promising) continue;
    for (const h of result.hits) {
      hits.push({ prNumber: src.prNumber, source: src.source, word: h.word, excerpt: h.excerpt });
    }
  }
  return hits;
}

/**
 * `git grep -n -F -- '<枝名>' <rev>` の生出力を構造化する。
 *
 * 出力の各行は `<rev>:<path>:<lineno>:<content>` の形（実測、`origin/main`
 * を指定した場合）。`content` 自体にコロンが含まれうるので、先頭の
 * `<rev>:` を1回だけ剥がし、残りを最初の2つのコロンで区切る
 * （`path` にコロンが含まれないことを前提にする——通常のファイルパスは
 * コロンを含まない）。
 *
 * 空文字・空行だけの出力は0件として扱う（該当なしは正常な結果であって
 * 読めなかったことではない）。
 */
export function parseGitGrepMatches(rawOutput, revPrefix) {
  if (typeof rawOutput !== 'string' || rawOutput.trim().length === 0) return [];
  const prefix = `${revPrefix}:`;
  const matches = [];
  for (const rawLine of rawOutput.split('\n')) {
    const line = rawLine.trimEnd();
    if (line.length === 0) continue;
    const withoutRev = line.startsWith(prefix) ? line.slice(prefix.length) : line;
    const firstColon = withoutRev.indexOf(':');
    const secondColon = firstColon === -1 ? -1 : withoutRev.indexOf(':', firstColon + 1);
    if (firstColon === -1 || secondColon === -1) {
      // 想定した形に分解できなかった行。落とさず、そのまま見せる
      // （静かに1件消えるより、読み手が形の崩れに気づける方を採る）。
      matches.push({ path: null, line: null, content: withoutRev });
      continue;
    }
    matches.push({
      path: withoutRev.slice(0, firstColon),
      line: withoutRev.slice(firstColon + 1, secondColon),
      content: withoutRev.slice(secondColon + 1),
    });
  }
  return matches;
}

const DISCLAIMER =
  'これは「消すな」ではなく「読め」である。誤検出が在る' +
  '（検査Bは「枝」または「ブランチ」＋保持語の同居だけを見る。文意までは判定しない）。';

/** 1本の枝ぶんの、検査A・検査Bの結果を人が読む形へ組み立てる。 */
export function formatBranchSection(branchName, checkAMatches, checkBHits) {
  const lines = [`## ${branchName}`, '', `A: ${checkAMatches.length}件`];
  for (const m of checkAMatches) {
    lines.push(`  ${m.path ?? '(解釈できない行)'}:${m.line ?? '?'}: ${m.content}`);
  }
  lines.push('', `B: ${checkBHits.length}件`);
  for (const h of checkBHits) {
    lines.push(`  PR #${h.prNumber} ${h.source} — 保持語「${h.word}」: ${h.excerpt}`);
  }
  return lines.join('\n');
}

/**
 * 全枝ぶんの結果を1本のレポートへ組み立てる。
 *
 * @param {{ branch: string, checkAMatches: object[], checkBHits: object[], errors?: string[] }[]} branchResults
 * @returns {{ text: string, exitCode: 0|1 }}
 */
export function buildReport(branchResults) {
  const sections = [];
  let anyHit = false;
  for (const r of branchResults) {
    if (r.checkAMatches.length > 0 || r.checkBHits.length > 0) anyHit = true;
    const section = [formatBranchSection(r.branch, r.checkAMatches, r.checkBHits)];
    if (r.errors && r.errors.length > 0) {
      section.push('', '⚠ 収集中のエラー:', ...r.errors.map((e) => `  ${e}`));
    }
    sections.push(section.join('\n'));
  }
  const text = [`⚠ ${DISCLAIMER}`, '', ...sections, '', `⚠ ${DISCLAIMER}`].join('\n');
  return { text, exitCode: anyHit ? 1 : 0 };
}
