import type { Meta, StoryObj } from '@storybook/react-vite';

import { Button } from './button';
import { ButtonGroup, ButtonGroupSeparator } from './button-group';

const meta = {
  title: 'UI/ButtonGroup',
  component: ButtonGroup,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof ButtonGroup>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <ButtonGroup>
      <Button variant="outline">今日</Button>
      <Button variant="outline">7日</Button>
      <ButtonGroupSeparator />
      <Button variant="outline">30日</Button>
    </ButtonGroup>
  ),
};
