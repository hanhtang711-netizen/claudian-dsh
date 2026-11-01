/** @jest-environment jsdom */
import '@test/helpers/ObsidianSettingsDOM';

import { testDate } from '@test/helpers/testClock';
import { fireEvent, within } from '@testing-library/dom';
import { axe } from 'jest-axe';

import type { ChatMessage, ToolCallInfo } from '@/core/types';
import { ChatState } from '@/features/chat/state/ChatState';
import type { ChatTab } from '@/features/chat/tabs/ChatTab';
import { createTabPlacementPort } from '@/features/chat/tabs/runtime/TabRuntimePorts';
import { ChatPresentationPlacement } from '@/features/chat/view/ChatPresentationPlacement';

function plan(id: string, statuses = ['completed', 'in_progress', 'pending']): ToolCallInfo {
  return { id, name: 'TodoWrite', status: 'completed', input: { todos: statuses.map((status, index) => ({
    content: `Task ${index + 1}`, activeForm: `Working ${index + 1}`, status,
  })) } };
}

function message(toolCalls: ToolCallInfo[]): ChatMessage {
  return { id: 'response', role: 'assistant', content: '', timestamp: testDate().getTime(), toolCalls };
}

function tab(id: string, state: ChatState, providerId = 'codex') {
  const contentEl = document.body.createDiv();
  const messagesWrapperEl = contentEl.createDiv();
  const inputComposerEl = contentEl.createDiv();
  const inputEl = inputComposerEl.createEl('textarea', { attr: { 'aria-label': 'Message' } });
  return { id, providerId, state,
    zenPresentation: { state, subscribeActivity: (listener: () => void) => state.subscribeActivity(listener) },
    placement: createTabPlacementPort({ contentEl, messagesWrapperEl, inputComposerEl, inputEl }, () => undefined, () => undefined),
  } as unknown as ChatTab;
}

function harness(state = new ChatState()) {
  let active: ChatTab | null = tab('first', state);
  const panel = document.body.createDiv();
  const quota = panel.createDiv({ text: 'Account quota' });
  const placement = new ChatPresentationPlacement({ getActiveTab: () => active, isWide: () => false, getTabCount: () => 3 });
  placement.mount(panel, quota);
  const nav = document.createElement('nav');
  nav.setAttribute('aria-label', 'Conversations');
  nav.textContent = '1 2 3';
  placement.attachNavRow(nav);
  placement.update();
  return { panel, state, placement, nav, quota, switchTo(next: ChatTab | null) { active = next; placement.update(); } };
}

afterEach(() => document.body.replaceChildren());

it('restores tasks above conversation navigation and quota, and updates from the active session without rebuilding the composer', async () => {
  const state = new ChatState();
  state.messages = [message([plan('initial')])];
  const h = harness(state);
  const ui = within(h.panel);
  const region = ui.getByRole('region', { name: 'Codex tasks' });
  expect(region.compareDocumentPosition(h.nav) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(h.nav.compareDocumentPosition(h.quota) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(ui.getByText('Tasks 1/3')).toBeDefined();
  expect(ui.getByText('Working 2')).toBeDefined();
  expect(ui.getByText('Task 3')).toBeDefined();
  expect(Array.from(region.querySelectorAll('.claudian-task-panel-icon')).map(icon => icon.textContent)).toEqual(['✓', '•', '•']);
  const composer = h.panel.querySelector('.claudian-active-input-slot')!.firstElementChild;
  const toggle = ui.getByRole('button', { name: 'Tasks 1/3' });
  fireEvent.click(toggle);
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  expect(ui.queryByRole('list')).toBeNull();
  const updated = plan('second', ['completed', 'completed', 'in_progress']);
  state.lastMessage!.toolCalls!.push(updated);
  state.recordActivity({ kind: 'tool', tool: updated });
  const updatedToggle = ui.getByRole('button', { name: 'Tasks 2/3' });
  expect(updatedToggle.getAttribute('aria-expanded')).toBe('false');
  fireEvent.click(updatedToggle);
  expect(ui.getByText('Working 3')).toBeDefined();
  expect(h.panel.querySelector('.claudian-active-input-slot')!.firstElementChild).toBe(composer);
  expect(await axe(h.panel)).toHaveNoViolations();
  h.placement.restoreAll();
});

it('switches sources by runtime identity, ignores detached updates, and releases the final subscription on close', () => {
  const a = new ChatState();
  a.messages = [message([plan('a')])];
  const releaseA = jest.fn();
  const realSubscribeA = a.subscribeActivity.bind(a);
  const subscribeA = jest.spyOn(a, 'subscribeActivity').mockImplementation(listener => {
    const unsubscribe = realSubscribeA(listener);
    return () => { releaseA(); unsubscribe(); };
  });
  const h = harness(a);
  expect(subscribeA).toHaveBeenCalledTimes(1);
  h.placement.update();
  expect(subscribeA).toHaveBeenCalledTimes(1);
  const b = new ChatState();
  b.messages = [message([plan('b', ['completed'])])];
  const releaseB = jest.fn();
  const realSubscribeB = b.subscribeActivity.bind(b);
  jest.spyOn(b, 'subscribeActivity').mockImplementation(listener => {
    const unsubscribe = realSubscribeB(listener);
    return () => { releaseB(); unsubscribe(); };
  });
  h.switchTo(tab('first', b));
  expect(within(h.panel).getByText('Tasks 1/1')).toBeDefined();
  expect(releaseA).toHaveBeenCalledTimes(1);
  a.messages = [message([plan('stale', [])])];
  expect(within(h.panel).getByText('Tasks 1/1')).toBeDefined();
  h.switchTo(null);
  expect(releaseB).toHaveBeenCalledTimes(1);
  expect(within(h.panel).queryByRole('region', { name: 'Codex tasks' })).toBeNull();
  h.switchTo(tab('third', b));
  h.placement.restoreAll();
  expect(releaseB).toHaveBeenCalledTimes(2);
  expect(h.panel.querySelector('.claudian-task-panel')).toBeNull();
  b.messages = [message([plan('late')])];
  expect(h.panel.querySelector('.claudian-task-panel')).toBeNull();
  h.placement.mount(h.panel, h.quota);
  h.placement.update();
  expect(within(h.panel).getByText('Tasks 1/3')).toBeDefined();
  h.placement.restoreAll();
});

it('clears an explicit empty plan, reconstructs after hydration, and never shows Claude or subagent-only plans', () => {
  const h = harness();
  const ui = within(h.panel);
  expect(ui.queryByRole('region', { name: 'Codex tasks' })).toBeNull();
  h.state.messages = [message([plan('original')])];
  expect(ui.getByText('Tasks 1/3')).toBeDefined();
  h.state.messages = [message([plan('original'), plan('clear', [])])];
  expect(ui.queryByRole('region', { name: 'Codex tasks' })).toBeNull();
  h.state.messages = [message([plan('compacted')])];
  expect(ui.getByText('Tasks 1/3')).toBeDefined();
  h.switchTo(tab('claude', h.state, 'claude'));
  expect(ui.queryByRole('region', { name: 'Codex tasks' })).toBeNull();
  const nested = new ChatState();
  nested.messages = [message([{ id: 'agent', name: 'Agent', input: {}, status: 'completed',
    subagent: { id: 'child', description: '', prompt: '', isExpanded: false, status: 'completed', toolCalls: [plan('child')] },
  }])];
  h.switchTo(tab('nested', nested));
  expect(ui.queryByRole('region', { name: 'Codex tasks' })).toBeNull();
  h.placement.restoreAll();
});

it('ignores invalid or failed snapshots, renders text safely, and clears completed plans on the next user prompt', () => {
  const good = plan('good', ['completed']);
  good.input.todos = [{ content: '<img src=x onerror=alert(1)>', status: 'completed' }];
  const invalid: ToolCallInfo = { ...plan('invalid'), input: { todos: [{ content: 'invalid', status: 'surprise' }] } };
  const failed = { ...plan('failed', []), status: 'error' as const };
  const h = harness();
  h.state.messages = [message([good, invalid, failed])];
  const ui = within(h.panel);
  expect(ui.getByText('Tasks 1/1')).toBeDefined();
  expect(ui.getByText('<img src=x onerror=alert(1)>')).toBeDefined();
  expect(h.panel.querySelector('img')).toBeNull();
  h.state.addMessage({ id: 'next', role: 'user', content: 'next', timestamp: testDate({ seconds: 1 }).getTime() });
  expect(ui.queryByRole('region', { name: 'Codex tasks' })).toBeNull();
  h.state.messages = [message([plan('unfinished')]), { id: 'followup', role: 'user', content: 'continue', timestamp: testDate({ seconds: 1 }).getTime() }];
  expect(ui.getByText('Tasks 1/3')).toBeDefined();
  h.placement.restoreAll();
});
