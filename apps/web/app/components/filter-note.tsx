import type { ReactNode } from 'react';

export function FilterNote({ children }: { children: ReactNode }) {
  return <p className="mb-4 text-xs text-warn">{children}</p>;
}
