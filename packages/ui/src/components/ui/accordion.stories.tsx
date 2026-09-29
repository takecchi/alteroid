import type { Meta, StoryObj } from '@storybook/react-vite';

import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from './accordion';

const meta = {
  title: 'UI/Accordion',
  component: Accordion,
  parameters: { layout: 'padded' },
  tags: ['autodocs'],
} satisfies Meta<typeof Accordion>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: { type: 'single', collapsible: true },
  render: (args) => (
    <Accordion {...args} className="max-w-lg">
      <AccordionItem value="request">
        <AccordionTrigger>依頼の全文</AccordionTrigger>
        <AccordionContent>
          apps/web の見た目を shadcn の既定から alteroid
          のテーマへ差し替える。部品には手を入れない。
        </AccordionContent>
      </AccordionItem>
      <AccordionItem value="report">
        <AccordionTrigger>報告</AccordionTrigger>
        <AccordionContent>
          検証一式を最後の変更の後に通した。CI は ready の後に確かめる。
        </AccordionContent>
      </AccordionItem>
      <AccordionItem value="unverified">
        <AccordionTrigger>確かめていないこと</AccordionTrigger>
        <AccordionContent>Safari での見え方。</AccordionContent>
      </AccordionItem>
    </Accordion>
  ),
};
