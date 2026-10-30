import { ErrorNote } from '@alteroid/ui';

import { SLUG_USABLE_FORM } from '~/lib/slug';

// URL の名前が形に合わないとき、取得せずに（サーバの 400 を待たずに）出す。文は web の規則（`~/lib/slug`）から作る
export function InvalidSlugNote({ kind, slug }: { kind: '記憶' | 'やり方'; slug: string }) {
  return (
    <div className="p-4">
      <h2 className="font-mono text-base font-semibold break-all">{slug}</h2>
      <ErrorNote error={`${kind}の名前が使えない形。${SLUG_USABLE_FORM}`} className="mt-3" />
    </div>
  );
}
