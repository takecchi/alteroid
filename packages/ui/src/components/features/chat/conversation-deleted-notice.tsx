// `ChatHeader` の `notice`（`<p role="status">`）へ入れるので、`p` の中に置ける要素（span）だけで組む。
// 消えてしまうトーストにしない: 「消せなかったもの」（`remainsIn`）と「後始末の失敗」（`incomplete`）は、読んで判断する材料のため
export interface ConversationDeletedSummary {
  hiddenCount: number;
  attachmentsRemoved: number;
  commitmentsRemoved: number;
  incomplete: readonly string[];
  remainsIn: readonly string[];
}

export function ConversationDeletedNotice({ result }: { result: ConversationDeletedSummary }) {
  return (
    <span data-conversation-deleted-notice>
      <span className="block">
        会話を削除しました。この会話の発言は、どの画面・クローンからも読めなくなりました。
      </span>
      <span className="block">
        {`発言 ${result.hiddenCount} 件を読めなくし、添付 ${result.attachmentsRemoved} 件・台帳の約束 ${result.commitmentsRemoved} 件を消しました。`}
      </span>
      {result.incomplete.length > 0 && (
        <span className="mt-1 block text-warn" data-conversation-deleted-incomplete>
          <span className="block font-semibold">
            会話は読めなくなっていますが、次の後始末が終わっていません。
          </span>
          {result.incomplete.map((item, index) => (
            <span key={`${index}:${item}`} className="block">
              {`・${item}`}
            </span>
          ))}
        </span>
      )}
      {result.remainsIn.length > 0 && (
        <span className="mt-1 block" data-conversation-deleted-remains>
          <span className="block font-semibold">消せずに、中身が残りうる場所があります。</span>
          {result.remainsIn.map((item, index) => (
            <span key={`${index}:${item}`} className="block">
              {`・${item}`}
            </span>
          ))}
        </span>
      )}
    </span>
  );
}
