import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';

// 打鍵ごとに撃たない: 検索はストア全体を舐めうるため
const SEARCH_DEBOUNCE_MS = 300;

// 検索語を URL の `?<param>=` と同期する（正本は URL）。入力中の語 draft を返し、300ms の debounce のあと replace: true で書き戻す（空なら消す）。
// committed は URL に確定している語。
export function useSearchParamDraft(
  param: string,
): readonly [draft: string, setDraft: (value: string) => void, committed: string] {
  const [searchParams, setSearchParams] = useSearchParams();
  const committed = searchParams.get(param) ?? '';
  const [draft, setDraft] = useState(committed);
  // 自分が URL へ書いた語を持つ: 外からの変更（ナビのリンク・戻る）と区別しないと、打鍵中の入力を自分の書き込みの反映で巻き戻すため
  const [written, setWritten] = useState<string | null>(null);
  const [seen, setSeen] = useState(committed);
  // effect でなく描画中に取り込む（#3985）: effect の中で setState すると描き直しが1往復増えるため
  // 打鍵の途中でも外からの変更を優先して draft を捨てる: 残すと debounce の後に古い draft で URL を書き戻し、
  // リンクで検索を外せない・別の語へ移っても元の語に戻る
  if (committed !== seen) {
    setSeen(committed);
    setWritten(null);
    if (committed !== written) setDraft(committed);
  }
  useEffect(() => {
    if (draft === committed) return;
    const timer = setTimeout(() => {
      setWritten(draft);
      setSearchParams(
        (previous) => {
          const next = new URLSearchParams(previous);
          if (draft === '') next.delete(param);
          else next.set(param, draft);
          return next;
        },
        { replace: true },
      );
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [draft, committed, param, setSearchParams]);
  return [draft, setDraft, committed];
}
