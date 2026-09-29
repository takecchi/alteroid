import type { Meta, StoryObj } from '@storybook/react-vite';

import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectGroup,
  SelectLabel,
  SelectItem,
  SelectSeparator,
} from './select';

const meta = {
  title: 'UI/Select',
  component: Select,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof Select>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <Select defaultValue="manager">
      <SelectTrigger className="w-48">
        <SelectValue placeholder="役割を選ぶ" />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          <SelectLabel>役割</SelectLabel>
          <SelectItem value="clone">クローン</SelectItem>
          <SelectItem value="manager">マネージャー</SelectItem>
          <SelectItem value="worker">作業者</SelectItem>
        </SelectGroup>
        <SelectSeparator />
        <SelectItem value="none">なし</SelectItem>
      </SelectContent>
    </Select>
  ),
};
