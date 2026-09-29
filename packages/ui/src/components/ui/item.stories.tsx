import type { Meta, StoryObj } from '@storybook/react-vite';
import { BellRing } from 'lucide-react';

import { Badge } from './badge';
import { Button } from './button';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from './item';

const meta = {
  title: 'UI/Item',
  component: Item,
  parameters: { layout: 'padded' },
  tags: ['autodocs'],
} satisfies Meta<typeof Item>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <ItemGroup className="max-w-xl gap-2">
      <Item variant="outline">
        <ItemMedia variant="icon">
          <BellRing />
        </ItemMedia>
        <ItemContent>
          <ItemTitle>
            本番の DB へ migrate を当ててよいか <Badge variant="outline">42 分前</Badge>
          </ItemTitle>
          <ItemDescription>
            mgr-7f3c が止まって待っている。当てると usage_daily の索引が作り直される。
          </ItemDescription>
        </ItemContent>
        <ItemActions>
          <Button size="sm">答える</Button>
        </ItemActions>
      </Item>
      <Item variant="muted">
        <ItemContent>
          <ItemTitle>日報を回す</ItemTitle>
          <ItemDescription>毎日 23:30（JST）</ItemDescription>
        </ItemContent>
      </Item>
    </ItemGroup>
  ),
};
