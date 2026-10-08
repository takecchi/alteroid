import type { ReopenArchive, ReopenRecord } from './clone-distill-memory-state.js';

/**
 * 日誌（`[判断]`）に載せる、退避の結果の言い方。
 *
 * 「退避できなかった」と「退避するものが無かった」を同じ文へ畳まない
 * （後者は正常で、前者は生ログが器の外に残っていないことを意味する）。
 */
export function describeReopenArchive(archive: ReopenArchive): string {
  switch (archive.kind) {
    case 'saved':
      return `退避: ${archive.id}`;
    case 'failed':
      return '⚠️ 退避できなかった。古いセッションの生ログは器の外に残っていない';
    case 'none':
      return '退避するものが無かった';
    case 'pending':
      return '退避はまだ終わっていない';
  }
}

/**
 * 開き直した後の最初のターンの入力へ、1度だけ添える断り書き。
 *
 * ## ⛔ 「どうすべきか」は書かない
 *
 * 文脈窓の畳みの断り（`Clone#contextWindowFoldNotice`、`CONTEXT_WINDOW_ALSO_NOTICE`）と
 * 同じ約束で、渡すのは何が起きたかとどの口で読めるかだけである。
 * ただし「同じ内容がこのセッションへ入るとまた弾かれうる」は事実なので書く
 * （理由が安全分類器の拒否だったときの話であって、そうでなければ当たらない）。
 */
export function describeReopenNotice(record: ReopenRecord): string {
  const archive =
    record.archive.kind === 'saved'
      ? `古いセッションの生ログはアーカイブ ${record.archive.id} に退避してある（\`GET /archive/${record.archive.id}\` で読める）。`
      : record.archive.kind === 'failed'
        ? '⚠️ 古いセッションの生ログの退避は失敗した。'
        : record.archive.kind === 'pending'
          ? '古いセッションの生ログの退避先は、このターンを組む時点ではまだ確定していない。'
          : '古いセッションには退避するものが無かった。';
  return (
    `[system] 人間（${record.actor}）の操作で、このセッションは前のセッションを resume せずに` +
    `開き直したものである（理由: ${record.reason}）。` +
    `古いセッション id: ${record.previousSessionId ?? '不明'}。${archive}` +
    '**⟹ あなたはそれまでのやりとりを文脈として持っていない。**' +
    'ただし会話の記録そのものは消えていない（`conversation_read` で読み直せる）。' +
    '⚠️ 記憶（システムプロンプトの「現在の記憶」）はそのままである。' +
    (record.distill ? '' : '古いセッションの末尾は記憶へ蒸留していない。') +
    '理由が安全分類器（safeguards）の拒否だった場合、同じ内容がこのセッションへ入るとまた弾かれうる。' +
    '\n\n---\n\n'
  );
}
