import type { Meta, StoryObj } from '@storybook/react-vite';

import { Badge } from '../common';

import { MobileTopBar } from './mobile-top-bar';

/** 狭い画面の上端の帯。承認待ちの件数を右端に置く。 */
const meta = {
  title: 'Layout/MobileTopBar',
  component: MobileTopBar,
  parameters: { layout: 'fullscreen' },
  tags: ['autodocs'],
  decorators: [
    (Story) => (
      <div className="max-w-sm">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof MobileTopBar>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    status: 'live',
    onOpenNav: () => undefined,
    trailing: (
      <a href="#" className="flex min-h-11 shrink-0 items-center px-2">
        <Badge tone="warn">承認待ち 3</Badge>
      </a>
    ),
  },
};

/** 承認待ちを読めていない（0件と見分ける印）。 */
export const ApprovalsUnavailable: Story = {
  args: {
    status: 'offline',
    onOpenNav: () => undefined,
    trailing: (
      <a href="#" className="flex min-h-11 shrink-0 items-center px-2">
        <Badge tone="danger">承認待ち ?</Badge>
      </a>
    ),
  },
};
