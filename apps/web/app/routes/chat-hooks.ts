import { useEffect } from 'react';

import { useMarkConversationRead } from '@alteroid/swr';
import type { ConversationDetail } from '@alteroid/logic';

import { usePageVisible } from '~/lib/use-page-visible';

export function useMarkShownConversationRead(
  shownId: string | undefined,
  historyData: ConversationDetail | undefined,
) {
  // history だけを見る（手元の lines や transient は見ない）: 日誌の発言ではないので、返答が日誌に載る前に離れたときも既読になってしまう
  const pageVisible = usePageVisible();
  const markRead = useMarkConversationRead();
  useEffect(() => {
    if (!pageVisible || shownId === undefined || historyData === undefined) return;
    markRead(shownId, historyData);
  }, [pageVisible, shownId, historyData, markRead]);
}
