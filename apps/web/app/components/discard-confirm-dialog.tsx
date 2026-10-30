import { ConfirmDialog } from '@alteroid/ui';

// 書きかけの編集をやめるときの確認。開閉と閉じる動作は `useDiscardGuard` が持つ。
// description / confirmLabel / cancelLabel は、呼び出し側に固有の事情があるときだけ上書きする（既定が共有の文言）。
export function DiscardConfirmDialog({
  open,
  onOpenChange,
  onConfirm,
  description = '編集をやめると、書きかけの内容は失われます。',
  confirmLabel = '破棄して閉じる',
  cancelLabel,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
}) {
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title="保存していない変更があります"
      description={description}
      confirmLabel={confirmLabel}
      cancelLabel={cancelLabel}
      destructive
      onConfirm={onConfirm}
    />
  );
}
