/**
 * 見本（`*.stories.tsx`）だけが使う会話の並び。**`index.ts` からは出さない。**
 *
 * stories のファイルに置かないのは、Storybook が stories の名前付き export を
 * すべて見本として扱うからである。
 */
import type { ConversationListItem } from './conversation-list';

export const SAMPLE_CONVERSATIONS: ConversationListItem[] = [
  {
    id: 'conv_a',
    preview: '来週の登壇資料、構成案だけ先に作っておいて',
    updatedLabel: '3 分前',
    messages: 4,
  },
  {
    id: 'conv_b',
    preview: '日報の締め時刻を 23:30 にしたい',
    updatedLabel: '2 時間前',
    messages: 2,
  },
  {
    id: 'conv_c',
    preview: 'SDK の更新 PR、マージしてよいか判断して',
    updatedLabel: '昨日',
    messages: 7,
  },
];
