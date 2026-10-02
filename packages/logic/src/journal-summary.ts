/**
 * 日誌エントリを1行に潰す（一覧・通知・CLI で同じ文言を使うため）。
 *
 * もとは `packages/swr/src/hooks/queries.ts` に在った（#2558 で移設）。**React にも
 * SWR にも依存しない**ので、純ロジックの層に置き、`apps/cli` からも読めるようにした。
 * 文言・ロジックは1文字も変えていない。`@alteroid/swr` は再 export している。
 */
import { summarizeJournalDiagnosticsEntry } from '@alteroid/core/journal-diagnostics-format';

import type { JournalEntry } from './types.js';

/**
 * 成功した `github_observation` の CI の軸を1行にする（#2608）。
 *
 * **`@alteroid/core` の `describeGithubCi`（`progress-github.ts`）と1文字も違えない写し。**
 * core 本体の値の import はブラウザバンドルへサーバ専用のドメイン層を入れてしまう
 * （`@alteroid/core/journal-search` の分離の経緯）ので、ここへ写して持つ。
 * 文言を結ぶ歯は `journal-summary.test.ts` が持つ（core の関数と突き合わせる）。
 */
export function describeGithubCiText(ok: {
  ci?: {
    pulls: number;
    success: number;
    failure: number;
    pending: number;
    checks: string;
    truncated?: boolean;
  };
  ciUnavailable?: string;
}): string {
  if (ok.ci !== undefined) {
    const ci = ok.ci;
    const counted = ci.success + ci.failure + ci.pending;
    return (
      `CI: ${String(ci.pulls)} 件の PR を確認 — success ${String(ci.success)} / failure ${String(ci.failure)} / pending ${String(ci.pending)}` +
      (counted < ci.pulls ? `（チェックが無い等で未集計 ${String(ci.pulls - counted)} 件）` : '') +
      `（数えたもの: ${ci.checks}）` +
      (ci.truncated === true ? '（打ち切り。数は下限）' : '')
    );
  }
  if (ok.ciUnavailable !== undefined)
    return `CI: 取れなかった — ${ok.ciUnavailable}（0 件ではない）`;
  return 'CI: 観測していない（0 件ではない）';
}

/** 日誌エントリを人間が読む1行に潰す（一覧と通知で同じ文言を使うため）。 */
export function summarizeJournalEntry(entry: JournalEntry): string {
  switch (entry.type) {
    case 'exchange':
      return `${entry.with} ${entry.role === 'inbound' ? '←' : '→'} ${entry.text}`;
    case 'decision':
      return `${entry.decision}（根拠: ${entry.grounds}）`;
    case 'escalation':
      // **取り下げを先に見る（#963）。** `withdrawnAt` と `answeredAt` は
      // 正常な経路では両立しない（`schema.ts` の `journalEntrySchema` の
      // `escalation` 分岐、`withdrawnAt` の doc）。この分岐が無いと、
      // `approval_withdraw` が積む行（`answeredAt` 未設定）が「確認:」
      // （＝まだ誰も答えていない新しい質問）と誤読される——日誌フィード・
      // ダッシュボードのどちらも、取り下げた事実が読めなくなる
      // （issue #963 の受け入れ基準「取り下げの事実と理由が日誌に残る」は、
      // 行が在るだけでなく人間が読んで分かることを指す）。
      if (entry.withdrawnAt !== undefined) return `取り下げ済み: ${entry.question}`;
      return entry.answeredAt === undefined
        ? `確認: ${entry.question}`
        : `回答済: ${entry.question}`;
    case 'tool_use':
      return `${entry.actor} が ${entry.tool}`;
    case 'memory_update': {
      // **単位はバイトである**（`schema.ts` の `bytesBefore`/`bytesAfter` の
      // doc）。`entry.summary` には文字数が埋め込まれていることがある
      // （`memory_delete` の「削除直前 N 文字」）ので、バイトの注記は
      // `:` の手前——`cause`/`action` と同じ構造化された括弧の中——に置き、
      // 自由文の `summary` はコロンの後ろへ分ける（1行の中でも、単位の
      // 混ざる場所を分ける。#318 のコメントで実際に読み違いが起きている）。
      //
      // `action` と `bytesBefore`/`bytesAfter` は `optional`——この区別が
      // 導入される前の古いエントリは両方とも無い。無いことを `0` として
      // 出すと「変化が無かった」と読めてしまう（AGENTS.md の地雷表「取れない
      // 軸に 0 の行を作る」）ので、値が無いときは「不明」と明示し、
      // 黙って省かない（省くと、バイトが出ている行と混ざったときに
      // 「変化なし」に読める）。
      const action = entry.action === undefined ? '' : `/${entry.action}`;
      const bytes =
        entry.bytesBefore === undefined || entry.bytesAfter === undefined
          ? '前後バイト数不明（旧形式）'
          : `${entry.bytesBefore}→${entry.bytesAfter} バイト`;
      return `記憶 ${entry.slug} を更新（${entry.cause}${action} / ${bytes}）: ${entry.summary}`;
    }
    case 'daily_report':
      // **印の付いた行を「日報」と呼ばない**（`schema.ts` の `unavailable` の doc）。
      // 日誌の一覧は日報の有無を人間が拾い読みする面でもあるので、ここが
      // 「2026-08-20 の日報」としか言わないと、書けなかった日が書けた日と同じ顔で
      // 並ぶ。理由まで出すのは日報の面の仕事なので、ここでは印だけを言う。
      return entry.unavailable === undefined
        ? `${entry.date} の日報`
        : `⚠ ${entry.date} の日報は作れなかった: ${entry.unavailable}`;
    case 'external_event':
      return `${entry.source}: ${entry.summary}`;
    // **`worker_wait` / `turn_usage` / `context_usage` / `inbox_flow` は
    // `@alteroid/core/journal-diagnostics-format` へ移した（issue #2016）。**
    // CLI（`apps/cli/src/chat.ts` の `/journal`）がこの4種の要約を空欄の
    // まま出していたため、同じ文言を CLI とここで共有する口として切り出した
    // ——文言・ロジックは1文字も変えていない（移設のみ。
    // `journal-diagnostics-format.ts` 冒頭の doc）。
    case 'worker_wait':
    case 'turn_usage':
    case 'context_usage':
    case 'inbox_flow':
      return summarizeJournalDiagnosticsEntry(entry);
    case 'token_rotation':
      // **`text` をそのまま出す。** ここで組み直すと、同じ事実を読む4つの面
      // （stderr・この画面・クローンの `journal_read`・CLI）で言い方が分かれる。
      // 文言の持ち主は `describeTokenRotation` 1つである。
      //
      // **見出しの `event` は落とさない** — 一覧の1行しか読まない人が、
      // `exhausted`（全層が止まる）と `not_rotated`（正常）を見分けられなくなる。
      return `[${entry.event}] ${entry.text}`;
    case 'github_observation':
      // **申告であることを落とさない**（`observedBy`）。取れなかった回は数を作らない。
      return entry.result.status === 'ok'
        ? `${entry.repo}: open Issue ${entry.result.openIssues} 件 / open PR ${entry.result.openPulls} 件` +
            (entry.result.truncated ? '（limit に達した。下限）' : '') +
            `（観測者 ${entry.observedBy}）` +
            // **CI の軸を落とさない（#2608）。** `ci` が無いのは「観測していない」、
            // `ciUnavailable` は「取れなかった」で、どちらも 0 件ではない。
            ` / ${describeGithubCiText(entry.result)}`
        : `${entry.repo}: 取れなかった（観測者 ${entry.observedBy}）: ${entry.result.reason}`;
    case 'subagent_stall': {
      // **`token_rotation` と違い、`text` をそのまま出さない。** `entry.text`
      // は `runner.ts` の `#onSubagentStop` が組み立てた `note.text` そのままで、
      // 残っている背景処理の一覧（`taskLines`）と「この行が出ないことは空転が
      // 無かったを意味しない」という断り書きを含む複数行である——`token_rotation`
      // の `text`（`describeTokenRotation` が作る本当の1行）とは密度が違う。
      // この関数の役目は「一覧と通知で同じ文言を使うための、潰した1行」なので、
      // 丸ごと連結すると一覧の1行がこの種別だけ極端に長くなる。ここでは
      // `entry.text` に既に書かれている事情を、必要な欄だけ拾って組み直す。
      //
      // **`outcome` の2値は潰さない** — `woken`（起こし直した。まだ委譲が進む
      // 見込みがある）と `limit_reached`（上限に達して起こし直さなかった。
      // 自動では再開しない＝人が要る）は性質が違う
      // （`schema.ts` の `subagent_stall.outcome` の doc と同じ理由）。
      const agentType = entry.agentType === undefined ? '' : `/${entry.agentType}`;
      const outcome =
        entry.outcome === 'woken'
          ? `起こし直した（${entry.wakeupCount}回目）`
          : `上限に達し、起こし直さなかった（要対応。既に${entry.wakeupCount}回起こし直し済み）`;
      return (
        `作業者 ${entry.agentId}${agentType} が自分で起こした背景処理を ` +
        `${entry.ownedTaskCount}件 残したまま畳もうとした（セッション全体 ${entry.sessionTaskCount}件）: ` +
        outcome
      );
    }
  }
}
