import { useId, useState } from 'react';
import { useNavigate } from 'react-router';

import { Button, FieldHint, Input, cn } from '@alteroid/ui';

import { useBeforeUnloadGuard } from '~/lib/leave-guard';
import { isValidSlug, SLUG_USABLE_FORM } from '~/lib/slug';

// 記憶とやり方の一覧の上に置く「新しい名前を入れて開く」口。開いた先（`${basePath}/${slug}`）の詳細の画面が書く。
export function NewSlugForm({
  heading,
  basePath,
  selectedSlug,
}: {
  heading: string;
  basePath: string;
  selectedSlug: string | undefined;
}) {
  const navigate = useNavigate();
  const slugId = useId();
  const hintId = useId();
  const [slug, setSlug] = useState('');
  // 移動の確認（useBlocker）は置かない: ルーターのブロッカーは1つで、子の経路（memory-detail.tsx・practice-detail.tsx）が持つため
  useBeforeUnloadGuard(slug !== '' && slug !== selectedSlug);
  const valid = isValidSlug(slug);
  const open = () => void navigate(`${basePath}/${slug}`);

  return (
    <div
      className={cn(
        'shrink-0 border-b border-border px-4 py-3 md:px-6',
        selectedSlug !== undefined && 'hidden md:block',
      )}
    >
      <div className="md:flex md:items-end md:gap-6">
        <div className="md:shrink-0">
          <p className="mb-2 text-sm font-medium md:mb-1">{heading}</p>
          <label htmlFor={slugId} className="mb-1 block text-xs text-muted-foreground md:mb-0">
            名前（半角の英小文字・数字・. _ - のみ）
          </label>
        </div>
        <div className="flex gap-2 md:w-96">
          <Input
            id={slugId}
            aria-describedby={hintId}
            value={slug}
            placeholder="例: work-style"
            onChange={(event) => setSlug(event.target.value)}
            submitDisabled={!valid}
            onSubmitShortcut={open}
          />
          <Button variant="primary" disabled={!valid} onClick={open}>
            開く
          </Button>
        </div>
      </div>
      <FieldHint id={hintId} className="mt-1.5">
        先頭は英数字で、128 文字まで。
      </FieldHint>
      {slug !== '' && !valid && (
        <p className="mt-1.5 text-xs text-destructive">{SLUG_USABLE_FORM}</p>
      )}
    </div>
  );
}
