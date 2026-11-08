import { inboxEventShape } from './dropped-record.js';
import type { RestoredInboxEventVerdict } from './inbox-staleness.js';
import type { InboxEvent } from './schema.js';
import type { PendingInboxEvent } from './store.js';

// `clone.ts` の `Clone` にあった、再配達（器が落ちて未読を拾い直した配り直し）の文面を作るメソッドを、状態を持たない純関数として出したもの。
// 切り出した理由: `Clone` の private で直接呼べず、`clone-redelivery-text-pin.test.ts` と `clone-redelivery-journal-text-pin.test.ts` が `createClone` 越しにしか縛れなかったため。
// `Clone` の状態は読まない: `restoredCohort`（同じ起動で一緒に拾い直した件数。`#restoreUnreadPass` が書く）と記録の引き（`redeliveryState.get`）は、呼び元が引数で渡す。
// 同期のまま保つ: 呼び元の評価順を変えないため。
// 日誌の本文の関数（`describe*`）は接頭辞（`EXCHANGE_KIND_*_PREFIX`）の後ろだけを返す: `exchange-kind-coverage.test.ts` が呼び元の `text:` に接頭辞の字面を要求するため、接頭辞は呼び元に残す。

// 件数が複数のときの文言は `alone` を参照しない: `alone` が真なら live な record は高々1件のため
// 1件のときは文言を変えない: `inbox-persistence.test.ts` が逐語で見るため。
// 各件を `deliveries` / `at` / `inboxEventShape(event)` で列挙し、要約しない: 人間が後から読み返す日誌のため。時間の窓や件数の上限は持ち込まない
export function redeliveredLiveHeadline(
  records: readonly PendingInboxEvent[],
  alone: boolean,
  restoredCohort: number,
): string {
  if (records.length === 1) {
    const record = records[0];
    if (record === undefined) return '';
    return (
      `未読のまま残っていた合図を配り直した（${record.deliveries}回目の配達` +
      (alone
        ? ''
        : `＝器が入れ替わった回数。同じ起動で一緒に拾い直した未読が ${restoredCohort} 件あり、` +
          `配達回数は残っている未読の全行で一緒に進む — この合図の処理が落ちた回数ではない`) +
      `、${record.at} に受け取ったもの）: ${inboxEventShape(record.event)}`
    );
  }

  const details = records
    .map(
      (record, index) =>
        `[${index + 1}] ${record.deliveries}回目の配達、${record.at} に受け取ったもの: ` +
        inboxEventShape(record.event),
    )
    .join('\n');
  return (
    `未読のまま残っていた合図を配り直した（まとめて${records.length}件。回数はいずれも` +
    `器が入れ替わった回数——同じ起動で一緒に拾い直した未読が ${restoredCohort} 件あり、` +
    `配達回数は残っている未読の全行で一緒に進む — それぞれの合図の処理が落ちた回数ではない）:\n` +
    details
  );
}

export interface RedeliveryNoticeSource {
  /** 同じ起動で一緒に拾い直した未読の件数（stale も数える）。 */
  readonly restoredCohort: number;
  /** 配り直しの記録の引き。記録が無い（配り直しではない）合図は `undefined`。 */
  readonly recordOf: (id: string) => PendingInboxEvent | undefined;
}

// 「二度目だと分からない」ことは受け入れない: 分からないとクローンは同じ報告に二度応答し、ターンが丸ごと無駄になるため
// `batch.length === 1` は1件専用の文言を変えない: 既存の逐語一致の歯（`inbox-persistence.test.ts` など）を壊さないため
// 2件以上は1件ごとに断り書きを繰り返さず束の行にする: N 件を並べると断り書きの分量が本文を埋めるため（件数・配達回数の最大値・最古の時刻を持たせる）
// 印付きが1件しかない束も `alone` ではない側へ倒す: 「この回数をこの合図のせいにしない」より慎重な言い方で、情報は減らないため
export function redeliveryNoticeFor(
  batch: readonly InboxEvent[],
  { restoredCohort, recordOf }: RedeliveryNoticeSource,
): string {
  if (batch.length === 1) {
    const event = batch[0];
    if (event === undefined) return '';
    const record = recordOf(event.id);
    if (record === undefined) return '';

    // 同時に拾い直した件数で名乗り分ける: 2件以上だと居合わせただけの合図も同じだけ回数が増えており、回数から原因が読めないため
    const alone = restoredCohort <= 1;
    return [
      `[system] **これは配り直しである（${record.deliveries} 回目の配達）。**` +
        `${record.at} に受け取ったまま、処理を終える前にデーモンが落ちた合図を、起動時に拾い直した。`,
      '同じ内容に既に応答しているかもしれない。日誌（`journal_read`）と `manager_list` を見て、' +
        '同じ仕事を二度起こさないこと。',
      ...(alone
        ? record.deliveries >= 2
          ? [
              '**2 回以上配り直している。** 器が入れ替わった時点で受信箱に在った未読はこの1件' +
                'だけだった ⟹ この合図の処理そのものが落ちている可能性がある。' +
                '同じやり方をもう一度なぞる前に、なぜ落ちたかを先に見ること。',
            ]
          : []
        : [
            `**この回数は「器が入れ替わった回数」であって、この合図の処理が落ちた回数ではない。**` +
              `同じ起動で一緒に拾い直した未読が ${restoredCohort} 件あり、この合図は` +
              'そのうちの1件である（配達回数は残っている未読の**全行**で一緒に進む）。' +
              '**まだ一度も処理されていない可能性がある** — この回数を「この合図で落ちた」' +
              'の根拠にしないこと。',
          ]),
      '',
      '---',
      '',
    ].join('\n');
  }

  const records: PendingInboxEvent[] = [];
  for (const event of batch) {
    const record = recordOf(event.id);
    if (record !== undefined) records.push(record);
  }
  if (records.length === 0) return '';

  const maxDeliveries = Math.max(...records.map((record) => record.deliveries));
  const oldestAt = records.map((record) => record.at).sort()[0];

  return [
    `[system] **これは配り直しの束である（束 ${batch.length} 件のうち ${records.length} 件が` +
      `配り直し、最大 ${maxDeliveries} 回の配達、最も古いものは ${oldestAt} に受け取った）。**` +
      '処理を終える前にデーモンが落ちた合図を、起動時に拾い直した。',
    '同じ内容に既に応答しているかもしれない。日誌（`journal_read`）と `manager_list` を見て、' +
      '同じ仕事を二度起こさないこと。',
    `**この回数は「器が入れ替わった回数」であって、この合図の処理が落ちた回数ではない。**` +
      `同じ起動で一緒に拾い直した未読が ${restoredCohort} 件あり、この合図は` +
      'そのうちの1件である（配達回数は残っている未読の**全行**で一緒に進む）。' +
      '**まだ一度も処理されていない可能性がある** — この回数を「この合図で落ちた」' +
      'の根拠にしないこと。',
    '',
    '---',
    '',
  ].join('\n');
}

// `#redeliveredLiveHeadline` 側（`redeliveredLiveHeadline`）と同じ「配達回数は残っている未読の全行で一緒に進む」の断り書きを、ここでも別に持つ: 今回は文面を一字も変えない移し替えで、重複の整理は別の変更にするため
// 型ごとの本文追記（`#journalIncomingBody`）は `Clone` に残す: 消した合図の中身が日誌のどこにも残らなくなるのを避けるため（この関数が返すのは捨てた行の本文だけ）
export function describeStaleRedeliveryDropped(
  record: PendingInboxEvent,
  context: { readonly alone: boolean; readonly completedRound?: boolean },
  restoredCohort: number,
): string {
  return (
    `未読のまま残っていた合図を配り直したが（${record.deliveries}回目の配達` +
    (context.alone
      ? ''
      : `＝器が入れ替わった回数。同じ起動で一緒に拾い直した未読が ${restoredCohort} 件あり、` +
        `配達回数は残っている未読の全行で一緒に進む — この合図の処理が落ちた回数ではない`) +
    `、${record.at} に受け取ったもの）、` +
    (context.completedRound === true
      ? `その回は既に完了していた（定期の依頼の \`lastScheduledRunAt\` 以前）ので` +
        `ターンを起こさずに消した（モデルへは1文字も渡していない。本文は` +
        `直前の行に残してある。完了した回を二度走らせないための畳みで、まだ走っていない回は畳まない）: `
      : `もう効く先の無い種類だったので` +
        `ターンを起こさずに消した（モデルへは1文字も渡していない。本文は` +
        `直前の行に残してある。まだ要る状況なら、この種類の合図は作り直される）: `) +
    `${inboxEventShape(record.event)}`
  );
}

// 件数が0かどうかの判定（0件のときは書かない）は呼び元に残す: 書くか書かないかは `Clone` の `#journalSelf` を呼ぶかどうかで、文面ではないため
export function describeRestoreUnreadPassStart(total: number): string {
  return `未読の拾い直しを始める（claimPending が返した総数 ${total} 件）`;
}

// `processed` は「ストアから消えた件数」で統一する: 行が「残り N 件は次の起動で拾い直す」と名乗る以上、N はストアの実際の残りと一致させるため（stale は含め、live は含めない）
// 内訳は専用のカウンタを持たず都度数え直す: 中断のタイミングと更新の順序が噛み合わず2本のカウンタが食い違うバグを作る余地を避けるため
export function describeRestoreUnreadPassEnd(
  decided: ReadonlyArray<{ readonly verdict: RestoredInboxEventVerdict }>,
  processed: number,
  context: { readonly interrupted: boolean },
): string {
  const total = decided.length;
  const staleCount = decided
    .slice(0, processed)
    .filter((entry) => entry.verdict === 'stale').length;
  const liveCount = processed - staleCount;
  return context.interrupted
    ? `未読の拾い直しを中断した（#stopped または #inbox.closed。` +
        `総数 ${total} 件のうち ${processed} 件を処理した＝内訳 stale ${staleCount} 件・` +
        `live ${liveCount} 件。残り ${total - processed} 件は次の起動で拾い直す）`
    : `未読の拾い直しが終わった（総数 ${total} 件のうち ${processed} 件を` +
        `処理した＝内訳 stale ${staleCount} 件・live ${liveCount} 件）`;
}

// 次にいつ配り直すかを書く（#6139）: 再試行は回数で打ち切らないので、読み手が「止まった」のか「待っている」のかを取り違えないため
// `retryDelayMs` が無い（手で起こした回）のときは再試行しない。`lastRetryDelayMs` は後退の最後の間隔（定数は `Clone` 側が持つ）
export function describeFailedTimerRetryClause(
  retryDelayMs: number | undefined,
  lastRetryDelayMs: number,
): string {
  return retryDelayMs === undefined
    ? '手で起こした回なので再試行せず、次の起動か次の定刻で配り直される'
    : `${String(retryDelayMs / 60_000)} 分後に配り直す。成功するまで最長 ` +
        `${String(lastRetryDelayMs / 60_000)} 分ごとに配り直し続ける`;
}
