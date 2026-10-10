import { WarnNote } from '@alteroid/ui';
import { type UnreadableApproval } from '@alteroid/logic';

/**
 * 読めない承認待ちが在ることを、一覧の上で断る（commitments 画面の
 * `UnreadableNote` と同じ形）。**0件なら描かない**（0 の行を作らない）。
 *
 * id が取れない行は件数だけに数える。id の列挙には上限を置き、切ったら言う。
 * **「回答済みでも取り下げ済みでもない」を落とさない**——落とすと、行が消えたのと区別が付かない。
 *
 * 承認の画面と会話の画面が共有する。`hint` は、その画面だけが足す1文（会話の画面では、
 * 全件を確かめられる場所を言う）。
 */
const UNREADABLE_APPROVAL_IDS_SHOWN = 20;

export function UnreadableApprovalNote({
  unreadable,
  className = 'mb-4',
  hint,
}: {
  unreadable: readonly UnreadableApproval[];
  className?: string;
  hint?: string;
}) {
  if (unreadable.length === 0) return null;
  const idsAll = unreadable.map((entry) => entry.id).filter((id): id is string => id != null);
  const ids = idsAll.slice(0, UNREADABLE_APPROVAL_IDS_SHOWN);
  const idsRest = idsAll.length - ids.length;
  return (
    <WarnNote className={className}>
      読めない承認待ちが {unreadable.length} 件ある
      {ids.length > 0 &&
        `（id: ${ids.join(', ')}${idsRest > 0 ? ` …ほか ${idsRest} 件は省略` : ''}）`}
      。<strong>壊れた行であって、回答済みでも取り下げ済みでもない。</strong>
      未回答の一覧にも、回答済みの一覧にも載っていない。
      {hint}
    </WarnNote>
  );
}
