import type { Meta, StoryObj } from '@storybook/react-vite';

import { Label } from './label';
import { RadioGroup, RadioGroupItem } from './radio-group';

const meta = {
  title: 'UI/RadioGroup',
  component: RadioGroup,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof RadioGroup>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <RadioGroup defaultValue="good" className="gap-3">
      {[
        { value: 'good', label: '良かった' },
        { value: 'bad', label: '良くなかった' },
        { value: 'unclear', label: '判断できない' },
      ].map((option) => (
        <div key={option.value} className="flex items-center gap-2">
          <RadioGroupItem value={option.value} id={`appraisal-${option.value}`} />
          <Label htmlFor={`appraisal-${option.value}`}>{option.label}</Label>
        </div>
      ))}
    </RadioGroup>
  ),
};
