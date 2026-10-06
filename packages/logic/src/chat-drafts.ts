/**
 * チャットの入力欄に書きかけの本文を、会話ごとに `sessionStorage` へ残す（#3400）。
 *
 * **残すのは本文だけである。** 添付（`File` は保存できない）・承認カードの回答・編集の続きの状態は
 * 残さない。再読み込み・タブの破棄（スマホで別のアプリへ移ると起きやすい）からの復帰で、書きかけの
 * 本文を失わないためのもの。
 *
 * - 鍵は会話 id ごと（新しい会話＝id 無しは `new`）。1つの鍵に1つの本文
 * - **`sessionStorage`**（タブを閉じれば消える）。端末に平文で残す期間を短くするため。別タブには引き継がない
 * - 空にしたら鍵ごと消す。送信で空になれば消え、失敗して戻した文は書き直される
 * - ログアウト（資格情報を捨てるとき）に全部消す（`clearChatDrafts`。`storeCredential(…, null)` が呼ぶ）
 * - 保存先が使えない（無い・容量超過・禁止）ときは黙って何もしない。書きかけを残せないだけで、
 *   入力欄は今までどおり動く
 */

const PREFIX = 'alteroid.chatDraft:';

function keyFor(conversationId: string | undefined): string {
  return `${PREFIX}${conversationId ?? 'new'}`;
}

function storage(): Storage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    // 保存先へ触るだけで投げる環境（アクセスの禁止）。
    return null;
  }
}

/** 会話の書きかけの本文。無ければ `''`。 */
export function loadChatDraft(conversationId: string | undefined): string {
  try {
    return storage()?.getItem(keyFor(conversationId)) ?? '';
  } catch {
    return '';
  }
}

/** 書きかけの本文を残す。空（空白だけを含む）なら鍵ごと消す。 */
export function saveChatDraft(conversationId: string | undefined, text: string): void {
  const target = storage();
  if (target === null) return;
  try {
    if (text === '') target.removeItem(keyFor(conversationId));
    else target.setItem(keyFor(conversationId), text);
  } catch {
    // 容量超過など。残せないだけ。
  }
}

/** 全会話の書きかけを消す（ログアウト）。 */
export function clearChatDrafts(): void {
  const target = storage();
  if (target === null) return;
  try {
    const keys: string[] = [];
    for (let index = 0; index < target.length; index += 1) {
      const key = target.key(index);
      if (key !== null && key.startsWith(PREFIX)) keys.push(key);
    }
    for (const key of keys) target.removeItem(key);
  } catch {
    // 同上。
  }
}
