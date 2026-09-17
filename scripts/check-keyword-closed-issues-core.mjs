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

/** 実測に基づく既定の閾値（秒）。根拠は上の doc コメント。 */
export const DEFAULT_THRESHOLD_SECONDS = 10;

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
 * 「閉じるキーワードで閉じた疑いのある Issue」を並べる。**純粋関数。`gh` を呼ばない。**
 *
 * @param {{
 *   mergedPRs: { number: number, mergedAt: string, mergeCommitOid: string|null }[],
 *   closeEvents: { issueNumber: number, closedAt: string, commitId: string|null, actor?: string|null }[],
 *   thresholdSeconds?: number,
 * }} input
 *   `mergedPRs` はマージ済み PR の一覧（squash 前提。`mergeCommitOid` は
 *   `mergeCommit.oid`）。`closeEvents` は Issue の `closed` イベントの一覧
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

    // commit_id が null: タイミングでしか判定できない側。
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
