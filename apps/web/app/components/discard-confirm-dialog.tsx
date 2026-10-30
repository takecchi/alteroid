import { ConfirmDialog } from '@alteroid/ui';

// 書きかけの編集をやめるときの確認。開閉と閉じる動作は `useDiscardGuard` が持つ。
export function DiscardConfirmDialog({
  open,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title="保存していない変更があります"
      description="編集をやめると、書きかけの内容は失われます。"
      confirmLabel="破棄して閉じる"
      destructive
      onConfirm={onConfirm}
    />
  );
}
