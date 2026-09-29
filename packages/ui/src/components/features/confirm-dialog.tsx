import type { ReactNode } from 'react';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';

/**
 * 取り返しのつかない操作の前の確認（一括削除・失効・中断）。
 *
 * **確かめる文言は操作の名前と同じにする**（`confirmLabel`）。「削除する」を押した
 * 先で「OK」を押させると、何に同意したのかが確認の画面から消える。`description` には
 * **何が消えて何が残るか**を書く——「本当によろしいですか」は何も伝えない。
 *
 * 開け閉めは呼ぶ側が持つ（`open` / `onOpenChange`）。押したあとに通信が走るなら、
 * `onConfirm` の中で閉じるかどうかを呼ぶ側が決める。
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  cancelLabel = 'やめる',
  destructive = false,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  /** 消す・失効させる操作なら真（確かめるボタンが警告の色になる）。 */
  destructive?: boolean;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          {description !== undefined && (
            <AlertDialogDescription>{description}</AlertDialogDescription>
          )}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{cancelLabel}</AlertDialogCancel>
          <AlertDialogAction variant={destructive ? 'destructive' : 'default'} onClick={onConfirm}>
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
