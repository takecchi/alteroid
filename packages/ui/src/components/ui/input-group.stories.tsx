import type { Meta, StoryObj } from '@storybook/react-vite';
import { Search } from 'lucide-react';

import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from './input-group';

const meta = {
  title: 'UI/InputGroup',
  component: InputGroup,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof InputGroup>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <div className="w-80 space-y-3">
      <InputGroup>
        <InputGroupAddon>
          <Search />
        </InputGroupAddon>
        <InputGroupInput placeholder="日誌を絞り込む" />
      </InputGroup>
      <InputGroup>
        <InputGroupAddon>
          <InputGroupText>USD</InputGroupText>
        </InputGroupAddon>
        <InputGroupInput placeholder="20.00" inputMode="decimal" />
        <InputGroupAddon align="inline-end">
          <InputGroupText>/ 日</InputGroupText>
        </InputGroupAddon>
      </InputGroup>
    </div>
  ),
};
