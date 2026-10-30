import { useRef, type ReactNode } from 'react';

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

// `confirmLabel` は操作の名前と同じにする: 「OK」を押させると、何に同意したのかが確認の画面から消えるため
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  cancelLabel = 'やめる',
  destructive = false,
  onConfirm,
  onCloseAutoFocus,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  destructive?: boolean;
  onConfirm: () => void;
  onCloseAutoFocus?: (event: Event) => void;
}) {
  // 開く直前に焦点の居た要素（開いたボタン）を覚える: AlertDialog.Trigger を使わない作りで、Radix の閉じた後の焦点の戻しは trigger の ref を読むため、何も戻らず body に落ちる（Drawer と同じ）
  const opener = useRef<HTMLElement | null>(null);
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent
        onOpenAutoFocus={() => {
          opener.current =
            document.activeElement instanceof HTMLElement ? document.activeElement : null;
        }}
        onCloseAutoFocus={(event) => {
          // 呼び出し側が戻し先を決めているなら、そちらを優先する（会話の「終える」「削除」）
          if (onCloseAutoFocus !== undefined) {
            onCloseAutoFocus(event);
            return;
          }
          event.preventDefault();
          const target = opener.current;
          opener.current = null;
          if (target?.isConnected === true && target !== document.body) target.focus();
        }}
      >
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
