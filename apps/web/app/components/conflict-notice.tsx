import type { ReactNode } from 'react';

import { Button } from '@alteroid/ui';
import { formatDateTime, redactBody } from '@alteroid/logic';

// 記憶の詳細とやり方の詳細は、保存・削除が 409 になったとき同じ形の帯を出す。違うのは名詞（`noun`）と、
// 「いまの内容」の見せ方（やり方だけ種類と題の行を足す。`summary`）だけ。

/** 衝突の相手方（ほかで書かれた、いまの内容）。消されていたら `null`。 */
type ConflictCurrent = { updatedAt: string; content: string };

const BAND_CLASS = 'mb-3 rounded-lg border border-destructive/50 p-3 text-sm';

function CurrentContent({
  current,
  summary,
  children,
}: {
  current: ConflictCurrent;
  summary?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <>
      <p className="mt-2 text-xs text-muted-foreground">
        いまの内容（{formatDateTime(current.updatedAt)} に更新）
      </p>
      {summary}
      <pre className="mt-1 max-h-48 overflow-auto rounded-md bg-muted p-2 text-xs break-words whitespace-pre-wrap select-text">
        {/* 伏せる: 本体の表示（<Markdown>）と揃える。下書きは編集欄に生のまま残っている */}
        {redactBody(current.content)}
      </pre>
      {children}
    </>
  );
}

/** 保存が 409 になったときの帯。 */
export function ConflictNotice({
  noun,
  current,
  summary,
  busy,
  onOverwrite,
  onDiscard,
}: {
  noun: string;
  current: ConflictCurrent | null;
  summary?: ReactNode;
  busy: boolean;
  onOverwrite: () => void;
  onDiscard: () => void;
}) {
  return (
    <div role="alert" className={BAND_CLASS}>
      <p className="font-medium text-destructive">
        {current === null
          ? `読んだ後に、この${noun}がほかで消された。保存していない（下書きはそのまま残してある）。`
          : `読んだ後に、この${noun}がほかで書き換えられた。保存していない（下書きはそのまま残してある）。`}
      </p>
      {current !== null && <CurrentContent current={current} summary={summary} />}
      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" variant="danger" disabled={busy} onClick={onOverwrite}>
          自分の内容で上書きする
        </Button>
        <Button size="sm" disabled={busy} onClick={onDiscard}>
          自分の下書きを捨てて、いまの内容を読み直す
        </Button>
      </div>
    </div>
  );
}

/** 削除が 409 になったとき（書き始めた後に作られていた場合を含む）の帯。 */
export function DeleteConflictNotice({
  noun,
  current,
  summary,
  onClose,
}: {
  noun: string;
  current: ConflictCurrent | null;
  summary?: ReactNode;
  onClose: () => void;
}) {
  return (
    <div role="alert" className={BAND_CLASS}>
      <p className="font-medium text-destructive">
        {current === null
          ? `読んだ後に、この${noun}はほかで消された。こちらでは消していない。`
          : `読んだ後に、この${noun}がほかで書き換えられた。消していない。`}
      </p>
      {current !== null && (
        <CurrentContent current={current} summary={summary}>
          <p className="mt-2 text-xs text-muted-foreground">
            この内容でも消すなら、もう一度「削除」を押して確認してください。
          </p>
        </CurrentContent>
      )}
      <div className="mt-3">
        <Button size="sm" onClick={onClose}>
          閉じる
        </Button>
      </div>
    </div>
  );
}
