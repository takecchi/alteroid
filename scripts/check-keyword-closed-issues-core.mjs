/**
 * `check-keyword-closed-issues.mjs` の判定だけを切り出したもの（Issue #1128）。
 *
 * ## 何のために在るか
 *
 * `pr-closing-keywords`（#1109、`check-pr-closing-keywords-core.mjs`）はマージ**前**に
 * 止める門である。**既に閉じてしまった分には何も言わない。** そして閉じたことは
 * PR の側に1文字も出ない（CI は緑、マージは成功、警告も出ない）ので、気づく契機は
 * 「後で Issue を開いた人が閉じているのを見る」しかなかった（#1128）。
 *
 * この道具は、その「後から気づく」を機械にやらせる。**ただし判定は機械の仕事では
 * ない。** GitHub の「閉じるキーワードで意図して閉じた」（例: #1041 → PR #1112）と
 * 「閉じるキーワードが事故で閉じた」（例: #910 → PR #912）は、**timeline のデータ
 * だけからは区別できない**（#1128 の逐語: 「これは判定できない」と出力自身が
 * 名乗ること）。⟹ **この道具が言えるのは「一覧」までで、意図か事故かの判定は一切
 * 出力に書かない。** 一覧に出た後、意図どおりか事故かを決めるのは人である。
 *
 * ⛔ **門にはしない。** required contexts にも入れない。赤くする基準（＝閾値の
 * 妥当性）を確定させる機構が無いためである（`pr-closing-keywords` が required に
 * 入っていないのと同じ理由。あちらの doc を見よ）。
 *
 * ## PR 本文を読むようになった経緯（#1128 コメント 2026-09-23、実測で見つかった誤り）
 *
 * 2026-09-23 の実測（`main` = `7799819a`。147件の候補）で、既存の実装（PR 本文を
 * 一切読まず、closed イベントを「直前の最寄りのマージ」とだけ突き合わせる）が
 * **結びつけそのものを誤る**ことが分かった。
 *
 * - **Issue #1195 / #1198 は、実際には PR #1199 の本文の `Alteroid-Issue-Done:
 *   1195, 1198` trailer で閉じた**（`issue-done-trailer.yml` が読む。閉じたのは
 *   マージの24秒後・26秒後、actor は両方とも `github-actions[bot]`）。ところが
 *   PR #1247（本文の trailer は無関係な `#1123` だけを名乗る）のマージが
 *   #1195 のクローズの**10秒前**（#1198 のクローズの12秒前）というだけの理由で、
 *   旧実装はこれを「#1247 が閉じるキーワードで閉じた候補」として一覧に出していた。
 *   **これは「意図か事故か分からない」以前の問題——結びつけ先の PR 自体が違う。**
 * - この道具は元々 `Alteroid-Issue-Done` trailer の存在を知らなかった
 *   （`grep -ncE 'Alteroid-Issue-Done|issue-done-trailer|issue_done'` が core と
 *   CLI の両方で0件だったことを #1128 が自ら記録している）。**この道具の役割
 *   （閉じるキーワードの疑いを一覧する）そのものが、意図された自動 close の経路
 *   を「疑い」として誤カウントしていた。**
 *
 * ⟹ **(a) trailer で閉じたと判定できる分は候補から外す。(b) 結びつけは「最寄りの
 * マージ」ではなく、その Issue 番号を trailer か閉じるキーワードで名乗った PR を
 * 優先する**（名乗る PR が無いときだけ、従来どおり最寄りのマージへ落とす）。
 *
 * ## trailer で閉じたと判定する条件（実測で決めた。勘ではない）
 *
 * `issue-done-trailer.yml` は `GH_TOKEN: ${{ github.token }}` で `gh issue close`
 * を呼ぶ（`scripts/issue-done-trailer.mjs`）——**この repo で `issues: write` を
 * 持ち `gh issue close` / `gh issue create` / `gh issue comment` を呼ぶ workflow は
 * 3本あるが（`grep -rl 'issue close\|issues: write' .github/workflows/`）、
 * `gh issue close` を呼ぶのはこの1本だけである**（`release-prod.yml` と
 * `main-ci-alarm.yml` は `issue create` / `issue comment` のみ）。⟹ **この repo で
 * Issue を close するとき actor が `github-actions[bot]` になる経路は、
 * 現状この trailer workflow 以外に無い。**
 *
 * **実測（2026-09-23T11:46Z 観測）**: `gh api repos/takecchi/alteroid/issues/events
 * --paginate` から `actor=github-actions[bot]` かつ Issue（PR を除く）の `closed`
 * イベントを全件取ると **25件**、**全件 `commit_id` が `null`**。この25件それぞれに
 * ついて、`gh pr list --state merged --json number,mergedAt,mergeCommit,body` で
 * 得た全マージ済み PR の本文へ `evaluateIssueDoneTrailer`（#1134）を通し、
 * 「その Issue 番号を `close` として名乗る PR」を探したところ、**25件全件が
 * 1つの trailer 命名 PR と対応し**、マージ〜close の遅延は次の分布だった:
 *
 * ```
 * 最小 19秒 / 最大 47秒（25件、2026-09-23観測）
 * ```
 *
 * **一方、この道具が以前から知っている「閉じるキーワードの偽陽性」の実測3件**
 * （#1128 の既存 doc: PR #367→#204 が21秒後、同→#234 が35秒後、PR #1136→#1087 が
 * 51秒後）は、**いずれも actor が人間（`takecchi`）である**（#204/#234 は
 * timeline に `commented`→`renamed` が付随する「人が手で閉じた」形、#1087 は
 * 本文に言及すら無い偶然）。⟹ **タイミングだけでは trailer close と偽陽性が
 * 19〜51秒の帯で重なる**が、**actor で見ると重ならない**（bot=trailer close、
 * human=それ以外）。
 *
 * ⟹ **判定条件は2つの AND**——(1) `actor === 'github-actions[bot]'`、
 * (2) その Issue 番号を `Alteroid-Issue-Done` trailer で `close` と名乗る PR が、
 * close の `TRAILER_CLOSE_MAX_DELAY_SECONDS` 秒以内に prior でマージされている
 * こと。**(2) を要求するのは、(1) だけでは「なぜそう判定したか」の証拠
 * （どの PR の trailer か）が残らないためであり、fail-safe として二重にする**
 * ——(1) が真でも (2) の証拠が見つからない未知の形は、trailer close と断定せず
 * 通常の候補判定へフォールバックする（不明な形を握り潰さない。#1128 の一般原則
 * 「判定できないという3つ目の状態を持つ」と同じ向き）。
 *
 * `TRAILER_CLOSE_MAX_DELAY_SECONDS` は実測の最大値（47秒）に安全余裕を足した
 * `90`。**根拠は「この標本での最大値の約2倍」というだけの安全側の丸めであり、
 * 分布の裾を統計的に決めたものではない**（標本が25件しかない）。
 *
 * ## 結びつけの優先順位（(b) の実装）
 *
 * `commit_id` が `null` の close イベントについて、次の順で結びつけ先を決める。
 *
 * 1. **trailer で閉じたと判定できれば、候補から除外する**（上の条件）。
 * 2. その Issue 番号を閉じるキーワード（`Closes #N` 等。安全な形・危ない形を
 *    問わない——GitHub はどちらでも閉じるため。`check-pr-closing-keywords-core.mjs`
 *    の `extractClosingKeywordReferences` を再利用する）で名乗る PR のうち、
 *    close 以前にマージされた最も近い1件が `thresholdSeconds` 以内なら、
 *    そちらへ結びつける（**最寄りのマージがこれと違っても、名乗った PR を採る**）。
 * 3. どちらの経路でも名乗る PR が見つからなければ、**従来どおり「直前の最寄りの
 *    マージ」**（PR の中身を問わない）が `thresholdSeconds` 以内かで判定する
 *    （PR #1003 → PR #1126 / PR #1050 → PR #1143 の実測: どちらも本文・タイトルに
 *    Issue 番号への言及が1文字も無い——手で閉じたのがマージと偶然重なっただけの
 *    偽陽性で、これは直さない。#1128 の元々の仕様どおり一覧に残す）。
 *
 * ⚠️ **やりすぎを落とす歯——「この Issue 番号は過去にどこかの PR の trailer で
 * 名乗られたことがある」を理由に無条件で候補から外すのは誤り。** trailer で
 * 閉じられた後に reopen され、別の PR が閉じるキーワードで（意図どおり）閉じ直す
 * ことはありうる。**上の判定はイベント（1回ごとの close）に対して行う**——
 * 「名乗る PR」の探索も「close ✕ 90秒以内」という時刻の相関を必ず要求するので、
 * ずっと昔の trailer 命名 PR が無関係な別の close イベントを巻き込むことはない
 * （合成の歯で確認済み）。
 *
 * ## 何を読むか・読まないか（正直に書く）
 *
 * - **読む**: マージ済み PR の本文（`gh pr list --json ...,body`）。
 * - **読まない**: コミットメッセージそのもの。**この repo の設定は squash マージ
 *   のみ**（実測: `gh api repos/takecchi/alteroid --jq
 *   '{allow_squash_merge,allow_merge_commit,allow_rebase_merge}'` → `{true,
 *   false, false}`）ので、マージコミットのメッセージは実質「PR タイトル＋PR
 *   本文」である（実測: PR #1199 で両者を突き合わせると、GitHub 側の reflow で
 *   行の折り返し位置が変わるだけで内容は同じだった。逐語の一致ではなく
 *   目視での内容確認）。**⚠️ 折返しの位置が変わるということは、理論上は
 *   本文では同じ行に収まっていた「キーワード＋参照」がコミットメッセージ側では
 *   行をまたぐ（またはその逆）ことがありうる**——`extractClosingKeywordReferences`
 *   は行単位で走査するため、そうなった場合は本文からの判定とコミットメッセージ
 *   からの判定がずれる。**この食い違いは実測していない**（起きた実例を見つけて
 *   いない）。
 * - **読まない**: PR タイトル。`check-pr-closing-keywords-core.mjs` の実測
 *   （直近マージ済み150本でタイトルにキーワード＋参照の隣接を持つものは0本）を
 *   根拠に、この道具では追加しない——複雑さに見合う実例が無い。
 * - **言えないこと（変わらない）**: **意図した閉じ方か事故かの区別。** trailer で
 *   閉じた分を除いても、残る候補（キーワードで閉じた分）はやはり「意図どおり」
 *   （例: #1041 → PR #1112）と「事故」（例: #910 → PR #912）の両方を含む——
 *   この2つは timeline のデータからは区別できないという #1128 の元の指摘は、
 *   trailer の分を除いた後も変わらず成り立つ。
 * - **新たに言えないこと**: 手で閉じたのがマージと偶然重なっただけの形
 *   （#1003 → PR #1126 / #1050 → PR #1143 のように、PR が Issue 番号を1文字も
 *   名乗っていない場合）は、trailer 判定にもキーワード判定にも掛からないので
 *   引き続き「候補に残るが理由は分からない」——この道具はここを直すものではない。
 *
 * ## 判定の芯（Issue #1128 の案。検算して採用した）
 *
 * `closed` イベントは「誰が・何で閉じたか」を持つ。
 *
 * - **`commit_id` がマージコミットなら、コミットメッセージ経由で閉じた。** これは
 *   タイミングに依存しない確定的な一致である——squash マージのコミット本文に
 *   閉じるキーワードが在れば、GitHub はそのコミットが `main` へ入った瞬間に閉じる。
 *   `commit_id` が実在する merged PR の `mergeCommitOid` と**一致する**ことで判定
 *   する（時間差は問わない。一致そのものが証拠である）。
 * - **`commit_id` が `null` で、マージの数秒後に閉じているなら、PR 本文経由で
 *   閉じた。** こちらはタイミングでしか判定できない——`closed` イベントには
 *   「どの PR の本文が原因か」という直接のリンクが無いため、**マージ直後という
 *   状況証拠**だけを見る。
 *
 * ## 閾値をどう決めたか（実測。勘で決めていない）
 *
 * Issue #1128 が挙げた5件の実例（#910/#993×2/#866/#913/#1041）を
 * `gh api repos/takecchi/alteroid/issues/<N>/timeline` で検算し（生の出力は
 * PR 本文に貼った）、マージ〜closeの差はすべて **1〜2秒**だった。
 *
 * それだけでは閾値の根拠として弱い（標本が6件しかない）ので、**`main` の閉じた
 * Issue 全254件**を `gh api repos/takecchi/alteroid/issues/events --paginate` で
 * 洗い、`commit_id` が `null` の241件それぞれについて「直前に merge された PR
 * との時間差」の分布を取った（観測 2026-09-17）。
 *
 * ```
 * <=2s:      124件
 * 2-5s:        3件
 * 5-10s:       1件
 * 10-60s:     25件
 * 60-3600s:   68件
 * >3600s:     20件
 * ```
 *
 * **2〜9秒の4件を個別に確認したところ、全件が本物の閉じるキーワード（`Closes #NNN`
 * 系の本文）を持っていた**——PR #676（`Closes #668` / `Refs #667`。#667 は9秒後、
 * #668 は2秒後に閉じた。同じマージが2つの Issue を閉じ、処理に多少のジッターが
 * 在る）、PR #909（`#698` を末尾に単独行で持ち、#905 が4秒後に閉じた）、
 * PR #1126（本文末尾に `#1003` の単独行があり、#1003 が4秒後に閉じた）。
 *
 * **10秒以上のクラスタは逆に、確認した範囲で「閉じるキーワードではない」ことが
 * わかった。** PR #367（`main` へのマージ）は本文に `Fixes #254` / `Fixes #362`
 * とだけ書き、`#204` / `#234` は「関連」として番号だけ挙げていた。それでも
 * #204（21秒後）・#234（35秒後）はこの PR のマージの直後に閉じていた——ただし
 * timeline を見ると、両方とも close の直前に `commented` → `renamed` イベントが
 * 在り、**人が手で本文を編集してコメントし、閉じた**形だった（自動クローズでは
 * こういう付随イベントは付かない）。PR #1136 に至っては本文に `#1087` への言及が
 * 1つも無いのに、51秒後に #1087 が閉じている——**マージ直後に人が別件を手で
 * 片付けただけの偶然**である。
 *
 * ⟹ **9秒（確認できた最大の真陽性）と21秒（確認できた最小の偽陽性）のあいだに
 * 12秒の空白があり、閾値をそのどこに置いても実測との整合は変わらない。**
 * **`THRESHOLD_SECONDS = 10` を採用した**——真陽性側に1秒の余裕を足しただけの、
 * 空白の中でいちばん真陽性に近い側に寄せた値である（閾値を上げるほど、この
 * 一覧に人手のレビューが要らない偶然の一致が混ざる）。
 *
 * ⚠️ **この閾値は「この repo のこの標本」から引いたものであり、GitHub の内部の
 * 遅延特性を保証するものではない。** 標本が増えたら測り直すこと。
 *
 * ## commit_id が非 null だが、既知の merged PR のどれとも一致しない場合
 *
 * 実測（同じ254件の走査）では0件だった。それでも、そのような `closed` イベントは
 * 「閉じるキーワードを含むコミットで閉じた」こと自体は確定している（GitHub の
 * 仕様上、`commit_id` が非 null の close は必ず commit message 経由）ため、
 * **`prNumber: null` のまま候補に含める**（対応する PR が分からないだけで、
 * キーワードで閉じたこと自体は疑いようがない。握り潰さない）。
 */

import { evaluateIssueDoneTrailer } from './issue-done-trailer-core.mjs';
import { extractClosingKeywordReferences } from './check-pr-closing-keywords-core.mjs';

/** 実測に基づく既定の閾値（秒）。根拠は上の doc コメント。 */
export const DEFAULT_THRESHOLD_SECONDS = 10;

/**
 * `issue-done-trailer.yml` が `gh issue close` を呼ぶときの actor。この repo で
 * `gh issue close` を呼ぶ workflow はこれ1本だけ（根拠は上の doc コメント）。
 */
export const TRAILER_CLOSE_ACTOR = 'github-actions[bot]';

/**
 * trailer 命名 PR のマージから close までの遅延として許す上限（秒）。実測
 * （25件、2026-09-23観測）の最大値47秒に安全余裕を足した値。根拠は上の doc コメント。
 */
export const TRAILER_CLOSE_MAX_DELAY_SECONDS = 90;

/**
 * `commit_id` が `null` の close イベントについて、直前（`mergedAt <= closedAt`）に
 * マージされた PR のうち、いちばん近い1件を返す。
 *
 * @param {{ number: number, mergedAt: number }[]} mergedPRs `mergedAt` はミリ秒 epoch
 * @param {number} closedAtMs closed イベントの時刻（ミリ秒 epoch）
 */
function findNearestPriorMerge(mergedPRs, closedAtMs) {
  let best = null;
  for (const pr of mergedPRs) {
    if (pr.mergedAt > closedAtMs) continue;
    const diffSeconds = (closedAtMs - pr.mergedAt) / 1000;
    if (best === null || diffSeconds < best.diffSeconds) {
      best = { number: pr.number, mergedAt: pr.mergedAt, diffSeconds };
    }
  }
  return best;
}

/**
 * マージ済み PR の一覧から、「Issue 番号 → その番号を名乗った PR（マージ時刻付き）」
 * の索引を2つ作る（trailer 経由・閉じるキーワード経由）。**本文が無い（`body` が
 * 文字列でない）PR はどちらの索引にも入らない**——呼び出し側（歯を含む）が
 * `body` を渡さない場合でも、それは「名乗っていない」と同じ扱いになり、
 * 従来どおり「直前の最寄りのマージ」へフォールバックする（後方互換）。
 *
 * @param {{ number: number, mergedAt: string, body?: string }[]} mergedPRs
 * @returns {{
 *   trailerNamers: Map<number, { number: number, mergedAt: number }[]>,
 *   keywordNamers: Map<number, { number: number, mergedAt: number }[]>,
 * }}
 */
function indexNamers(mergedPRs) {
  const trailerNamers = new Map();
  const keywordNamers = new Map();

  function add(map, issueNumber, entry) {
    if (!map.has(issueNumber)) map.set(issueNumber, []);
    map.get(issueNumber).push(entry);
  }

  for (const pr of mergedPRs) {
    if (typeof pr.body !== 'string') continue;
    const mergedAtMs = Date.parse(pr.mergedAt);
    if (Number.isNaN(mergedAtMs)) continue;
    const entry = { number: pr.number, mergedAt: mergedAtMs };

    const trailerResult = evaluateIssueDoneTrailer(pr.body);
    if (trailerResult.verdict === 'close') {
      for (const issue of trailerResult.issues) {
        add(trailerNamers, issue.number, entry);
      }
    }

    for (const issueNumber of extractClosingKeywordReferences(pr.body)) {
      add(keywordNamers, issueNumber, entry);
    }
  }

  return { trailerNamers, keywordNamers };
}

/**
 * 「閉じるキーワードで閉じた疑いのある Issue」を並べる。**純粋関数。`gh` を呼ばない。**
 *
 * @param {{
 *   mergedPRs: { number: number, mergedAt: string, mergeCommitOid: string|null, body?: string }[],
 *   closeEvents: { issueNumber: number, closedAt: string, commitId: string|null, actor?: string|null }[],
 *   thresholdSeconds?: number,
 * }} input
 *   `mergedPRs` はマージ済み PR の一覧（squash 前提。`mergeCommitOid` は
 *   `mergeCommit.oid`）。**`body` は省略可能**——渡さなければ、その PR は
 *   trailer/キーワードのどちらの「名乗り」索引にも入らず、常に「直前の最寄りの
 *   マージ」経由のフォールバックだけで判定される（後方互換。既存の歯が `body`
 *   無しで書かれているため）。`closeEvents` は Issue の `closed` イベントの一覧
 *   （同じ Issue が複数回閉じていれば複数件——履歴の全件を渡すこと。
 *   `check-keyword-closed-issues.mjs` 側で PR 自身の closed イベントは除外して渡す）。
 * @returns {{
 *   issueNumber: number,
 *   closedAt: string,
 *   prNumber: number|null,
 *   mergedAt: string|null,
 *   secondsAfterMerge: number|null,
 *   matchedVia: 'commit-id'|'timing',
 *   actor: string|null,
 * }[]}
 *   候補の一覧。**「意図した閉じ方か事故か」は一切含まない**——machine
 *   readable な形でその判定を持たせないことが #1128 の要求そのものである。
 */
export function findKeywordClosedCandidates({
  mergedPRs,
  closeEvents,
  thresholdSeconds = DEFAULT_THRESHOLD_SECONDS,
}) {
  const mergedByOid = new Map();
  const mergedForTiming = [];
  for (const pr of mergedPRs) {
    const mergedAtMs = Date.parse(pr.mergedAt);
    if (Number.isNaN(mergedAtMs)) continue;
    mergedForTiming.push({ number: pr.number, mergedAt: mergedAtMs });
    if (typeof pr.mergeCommitOid === 'string' && pr.mergeCommitOid.length > 0) {
      mergedByOid.set(pr.mergeCommitOid, { number: pr.number, mergedAt: pr.mergedAt });
    }
  }
  const { trailerNamers, keywordNamers } = indexNamers(mergedPRs);

  const candidates = [];

  for (const ev of closeEvents) {
    const closedAtMs = Date.parse(ev.closedAt);
    if (Number.isNaN(closedAtMs)) continue;

    if (typeof ev.commitId === 'string' && ev.commitId.length > 0) {
      const matchedPr = mergedByOid.get(ev.commitId) ?? null;
      const secondsAfterMerge =
        matchedPr !== null ? (closedAtMs - Date.parse(matchedPr.mergedAt)) / 1000 : null;
      candidates.push({
        issueNumber: ev.issueNumber,
        closedAt: ev.closedAt,
        prNumber: matchedPr?.number ?? null,
        mergedAt: matchedPr?.mergedAt ?? null,
        secondsAfterMerge,
        matchedVia: 'commit-id',
        actor: ev.actor ?? null,
      });
      continue;
    }

    // commit_id が null: まず「trailer で閉じた」かを見る（#1128 コメント
    // 2026-09-23 の決定。条件と実測根拠は上の doc コメント）。
    const nearestTrailerNamer = findNearestPriorMerge(
      trailerNamers.get(ev.issueNumber) ?? [],
      closedAtMs,
    );
    const isTrailerClose =
      ev.actor === TRAILER_CLOSE_ACTOR &&
      nearestTrailerNamer !== null &&
      nearestTrailerNamer.diffSeconds <= TRAILER_CLOSE_MAX_DELAY_SECONDS;
    if (isTrailerClose) {
      // trailer で閉じたと判定——候補から外す。「この Issue 番号がかつて
      // どこかの trailer で名乗られたことがある」だけでは外さない
      // （このイベント自身の時刻・actor と相関する命名 PR が要る。上の doc の
      // 「やりすぎを落とす歯」参照）。
      continue;
    }

    // 次に、閉じるキーワードで名乗った PR を探す（最寄りのマージより優先する）。
    const nearestKeywordNamer = findNearestPriorMerge(
      keywordNamers.get(ev.issueNumber) ?? [],
      closedAtMs,
    );
    if (nearestKeywordNamer !== null && nearestKeywordNamer.diffSeconds <= thresholdSeconds) {
      candidates.push({
        issueNumber: ev.issueNumber,
        closedAt: ev.closedAt,
        prNumber: nearestKeywordNamer.number,
        mergedAt: new Date(nearestKeywordNamer.mergedAt).toISOString(),
        secondsAfterMerge: nearestKeywordNamer.diffSeconds,
        matchedVia: 'timing',
        actor: ev.actor ?? null,
      });
      continue;
    }

    // 名乗る PR がどちらの経路でも見つからない: 従来どおり「直前の最寄りの
    // マージ」へ落とす（PR #1003 → PR #1126 / #1050 → PR #1143 の実測: 名乗る
    // PR が無い偽陽性は、これまでどおり一覧に残す。#1128 の元々の仕様）。
    const nearest = findNearestPriorMerge(mergedForTiming, closedAtMs);
    if (nearest !== null && nearest.diffSeconds <= thresholdSeconds) {
      candidates.push({
        issueNumber: ev.issueNumber,
        closedAt: ev.closedAt,
        prNumber: nearest.number,
        mergedAt: new Date(nearest.mergedAt).toISOString(),
        secondsAfterMerge: nearest.diffSeconds,
        matchedVia: 'timing',
        actor: ev.actor ?? null,
      });
    }
  }

  return candidates;
}

/**
 * 候補一覧を、人が読んで次を判断できる文へ畳む。
 *
 * **この関数自身が「判定できない」と名乗る**（#1128 の要求: 意図か事故かの区別を
 * 出力に書かない代わりに、区別できないこと自体を出力へ明示する）。
 */
export function formatReport(candidates, thresholdSeconds = DEFAULT_THRESHOLD_SECONDS) {
  const header = `check-keyword-closed-issues（閾値=${thresholdSeconds}秒）:`;
  if (candidates.length === 0) {
    return `${header} 候補は0件。`;
  }

  const lines = [
    `${header} ${candidates.length}件の候補。`,
    '⚠️ これは「閉じるキーワードで閉じた疑いがある」という一覧であって、意図した閉じ方か' +
      '事故かの判定ではない。この道具はその2つを区別できない——一覧を出すところまでが' +
      '機械の仕事で、判断は人がすること。',
    '',
  ];

  const sorted = [...candidates].sort((a, b) => (a.closedAt < b.closedAt ? 1 : -1));
  for (const c of sorted) {
    const via =
      c.matchedVia === 'commit-id' ? 'commit_idがマージコミットと一致' : 'マージ直後のタイミング';
    const prPart = c.prNumber !== null ? `PR #${c.prNumber}` : '対応する merged PR は不明';
    const secondsPart =
      c.secondsAfterMerge !== null ? `マージの${c.secondsAfterMerge}秒後` : '（時間差は不明）';
    const actorPart = c.actor ? `actor=${c.actor}` : '';
    lines.push(
      `  #${c.issueNumber} closed ${c.closedAt} — ${prPart}の${secondsPart}（${via}）${actorPart}`,
    );
  }

  return lines.join('\n');
}
