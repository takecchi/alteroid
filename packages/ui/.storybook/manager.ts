import { addons } from 'storybook/manager-api';

import { alteroidDark } from './theme';

// 外枠（左の一覧・上の帯）の色。理由は `theme.ts`。
addons.setConfig({ theme: alteroidDark });
