import type { Meta, StoryObj } from '@storybook/react-vite';

import { Input } from './input';

const meta = {
  title: 'UI/Input',
  component: Input,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
  argTypes: {
    disabled: { control: 'boolean' },
  },
} satisfies Meta<typeof Input>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: { placeholder: 'マネージャー名を入力', className: 'w-64' },
};

export const Disabled: Story = {
  args: { placeholder: '編集できません', disabled: true, className: 'w-64' },
};

export const Invalid: Story = {
  args: {
    defaultValue: '不正な値',
    'aria-invalid': true,
    className: 'w-64',
  },
};
