import type { Meta, StoryObj } from '@storybook/react-vite';

import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from './field';
import { Input } from './input';
import { Switch } from './switch';

const meta = {
  title: 'UI/Field',
  component: Field,
  parameters: { layout: 'padded' },
  tags: ['autodocs'],
} satisfies Meta<typeof Field>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <FieldSet className="max-w-md">
      <FieldLegend>資格情報を足す</FieldLegend>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="cred-name">名前</FieldLabel>
          <Input id="cred-name" placeholder="GITHUB_TOKEN" className="font-mono" />
          <FieldDescription>マネージャーの環境変数として渡る名前。</FieldDescription>
        </Field>
        <Field data-invalid="true">
          <FieldLabel htmlFor="cred-value">値</FieldLabel>
          <Input id="cred-value" type="password" aria-invalid="true" />
          <FieldError>値が空。</FieldError>
        </Field>
        <Field orientation="horizontal">
          <Switch id="cred-runner" />
          <FieldLabel htmlFor="cred-runner">作業者にも渡す</FieldLabel>
        </Field>
      </FieldGroup>
    </FieldSet>
  ),
};
