import type { ReactNode } from 'react';

export function OlderButton({
  loading,
  onClick,
  children,
}: {
  loading: boolean;
  onClick: () => unknown;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={loading}
      className="w-full rounded-md border border-border py-2 text-sm text-muted-foreground hover:text-foreground disabled:opacity-60"
    >
      {loading ? '読み込み中…' : children}
    </button>
  );
}
