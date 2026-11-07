import { inboxEventShape } from './dropped-record.js';
import type { InboxEvent } from './schema.js';
import type { PendingInboxEvent } from './store.js';

// `clone.ts` の `Clone` にあった、再配達（器が落ちて未読を拾い直した配り直し）の文面を作る2メソッドを、状態を持たない純関数として出したもの。
// 切り出した理由: `Clone` の private で直接呼べず、`clone-redelivery-text-pin.test.ts` が `createClone` 越しにしか縛れなかったため。
// `Clone` の状態は読まない: `restoredCohort`（同じ起動で一緒に拾い直した件数。`#restoreUnreadPass` が書く）と記録の引き（`redeliveryState.get`）は、呼び元が引数で渡す。
// 同期のまま保つ: 呼び元の評価順を変えないため。

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
