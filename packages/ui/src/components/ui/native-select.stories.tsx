import type { Meta, StoryObj } from '@storybook/react-vite';

import { NativeSelect, NativeSelectOption, NativeSelectOptGroup } from './native-select';

const meta = {
  title: 'UI/NativeSelect',
  component: NativeSelect,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof NativeSelect>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <NativeSelect defaultValue="manager" className="w-64">
      <NativeSelectOption value="manager">マネージャー</NativeSelectOption>
      <NativeSelectOption value="worker">作業者</NativeSelectOption>
      <NativeSelectOption value="clone">クローン</NativeSelectOption>
    </NativeSelect>
  ),
};

export const Small: Story = {
  render: () => (
    <NativeSelect size="sm" defaultValue="ja" className="w-40">
      <NativeSelectOption value="ja">日本語</NativeSelectOption>
      <NativeSelectOption value="en">英語</NativeSelectOption>
    </NativeSelect>
  ),
};

export const WithOptGroup: Story = {
  render: () => (
    <NativeSelect defaultValue="tokyo" className="w-64">
      <NativeSelectOptGroup label="関東">
        <NativeSelectOption value="tokyo">東京</NativeSelectOption>
        <NativeSelectOption value="yokohama">横浜</NativeSelectOption>
      </NativeSelectOptGroup>
      <NativeSelectOptGroup label="関西">
        <NativeSelectOption value="osaka">大阪</NativeSelectOption>
      </NativeSelectOptGroup>
    </NativeSelect>
  ),
};
