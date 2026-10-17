/** @jest-environment jsdom */
import { testDate } from '@test/helpers/testClock';
import { fireEvent, within } from '@testing-library/dom';
import { axe } from 'jest-axe';

import type { ProviderRateLimitState } from '@/core/providers/types';
import { AccountQuotaDashboard } from '@/features/chat/view/AccountQuotaDashboard';

HTMLElement.prototype.empty = function () { this.replaceChildren(); };

it('renders account quota, saturated reset time and an accessible manual refresh without late UI work', async () => {
  const container = document.body.createDiv();
  let listener!: (state: ProviderRateLimitState) => void;
  let finish!: () => void;
  const off = jest.fn();
  const service = {
    subscribe: jest.fn((onState: typeof listener) => { listener = onState; return off; }),
    refresh: jest.fn(() => new Promise<void>(resolve => { finish = resolve; })),
  };
  const panel = new AccountQuotaDashboard(container, service);
  listener({ status: 'ready', windows: [
    { label: '5小时', remainingPercent: 83, usedPercent: 17, resetsAt: null },
    { label: '本周', remainingPercent: 0, usedPercent: 100, resetsAt: Math.floor(testDate().getTime() / 1000) + 3600 },
  ] });
  const ui = within(container);
  expect(ui.getByText('5小时 剩 83%')).toBeDefined();
  expect(ui.getByText(/本周 已满/).textContent).toContain('重置');
  const button = ui.getByRole('button', { name: '刷新 Codex 额度' });
  expect(button.getAttribute('type')).toBe('button');
  expect(await axe(container)).toHaveNoViolations();
  fireEvent.click(button);
  expect(service.refresh).toHaveBeenCalledTimes(1);
  expect(button.getAttribute('aria-busy')).toBe('true');
  panel.dispose(); finish(); await Promise.resolve();
  expect(off).toHaveBeenCalledTimes(1);
  expect(container.children).toHaveLength(0);
  container.remove();
});
