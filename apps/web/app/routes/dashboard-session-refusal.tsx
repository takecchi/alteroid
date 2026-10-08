import { Link } from 'react-router';

import { HOME_LINK_CLASS } from '@alteroid/ui';
import { useCloneSessionRefusal } from '@alteroid/swr';

// 取れなかった・形が読めない・欄が無いときは何も出さない: 帯は「弾かれている」ときだけの知らせで、取れないことを「弾かれていない」とも「弾かれている」とも言わないため（取れない自体は接続の表示が持つ）
// ボタンを置かない: 開き直しは文脈の連続性を切る操作で、確認つきの設定画面の節（「クローンのセッションを開き直す」）が持つため。ここはそこへのリンクだけにする
export function SessionRefusalBand() {
  const status = useCloneSessionRefusal();
  const refusal = status.data?.cloneSessionRefusal;
  if (refusal === undefined) return null;
  const category = refusal.category ?? '不明';
  const autoReopen =
    refusal.autoReopen === 'halted'
      ? '自動の開き直しは止めた（開き直したセッションも答えないまま弾かれた）。'
      : refusal.autoReopen === 'disabled'
        ? '自動の開き直しは外してある。'
        : '2回続いたら自動で開き直す。';
  return (
    <div
      role="status"
      data-testid="session-refusal-band"
      className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-warn/40 bg-warn/10 px-4 py-2 text-sm text-warn"
    >
      <p className="min-w-0 flex-1">
        {refusal.streak > 0
          ? `クローンのセッションが安全分類器に ${refusal.streak} 回続けて弾かれている（${category}）。`
          : 'クローンのセッションの自動の開き直しを止めている。'}
        {autoReopen}
      </p>
      <Link to="/settings" className={HOME_LINK_CLASS}>
        設定画面（クローンのセッションを開き直す）
      </Link>
    </div>
  );
}
