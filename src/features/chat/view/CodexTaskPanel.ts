import { setIcon } from 'obsidian';

import type { TodoItem } from '@/core/tools/todo';
import type { ChatMessage } from '@/core/types';
import type { ChatTab } from '@/features/chat/tabs/ChatTab';

/** A read-only projection of the active Codex transcript; the session owns task state. */
export class CodexTaskPanel {
  private readonly root: HTMLElement;
  private readonly toggle: HTMLButtonElement;
  private readonly label: HTMLElement;
  private readonly list: HTMLElement;
  private tab: ChatTab | null = null;
  private unsubscribe: (() => void) | null = null;
  private signature = '';
  private expanded = true;

  constructor(container: HTMLElement) {
    this.root = container.createDiv({
      cls: 'claudian-task-panel', attr: { role: 'region', 'aria-label': 'Codex tasks' },
    });
    this.root.hidden = true;
    this.toggle = this.root.createEl('button', {
      cls: 'claudian-task-panel-toggle', attr: { type: 'button', 'aria-expanded': 'true' },
    });
    const icon = this.toggle.createSpan({ cls: 'claudian-tool-icon', attr: { 'aria-hidden': 'true' } });
    setIcon(icon, 'list-checks');
    this.label = this.toggle.createSpan({ cls: 'claudian-tool-name' });
    this.list = this.root.createEl('ul', { cls: 'claudian-task-panel-list claudian-todo-list-container' });
    this.toggle.addEventListener('click', this.toggleExpanded);
  }

  bind(tab: ChatTab | null): void {
    const next = tab?.providerId === 'codex' ? tab : null;
    if (this.tab === next) return;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.tab = next;
    this.signature = '';
    this.expanded = true;
    // Reuse the tab's existing read-only presentation subscription, not a timer or DOM observer.
    if (next) this.unsubscribe = next.zenPresentation.subscribeActivity(this.onActivity);
    this.render();
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.tab = null;
    this.toggle.removeEventListener('click', this.toggleExpanded);
    this.root.remove();
  }

  private readonly onActivity = (): void => {
    const activity = this.tab?.zenPresentation.state.activity;
    // Text deltas cannot change tasks. Hydration/reset emits null activity.
    if (activity && activity.kind !== 'user' && (activity.kind !== 'tool' || activity.tool.name !== 'TodoWrite')) return;
    this.render();
  };

  private readonly toggleExpanded = (): void => {
    this.expanded = !this.expanded;
    this.updateExpanded();
  };

  private updateExpanded(): void {
    this.toggle.setAttribute('aria-expanded', String(this.expanded));
    this.list.hidden = !this.expanded;
  }

  private render(): void {
    const todos = this.tab ? latestTodos(this.tab.state.messages) : [];
    const signature = JSON.stringify(todos);
    if (signature === this.signature) return;
    this.signature = signature;
    this.root.hidden = todos.length === 0;
    this.list.empty();
    const completed = todos.filter(todo => todo.status === 'completed').length;
    this.label.setText(`Tasks ${completed}/${todos.length}`);
    this.updateExpanded();
    for (const todo of todos) {
      const item = this.list.createEl('li', { cls: `claudian-todo-item claudian-todo-${todo.status}` });
      const statusIcon = item.createSpan({ cls: 'claudian-todo-status-icon', attr: { 'aria-hidden': 'true' } });
      setIcon(statusIcon, todo.status === 'completed' ? 'check' : 'dot');
      item.createSpan({ cls: 'claudian-todo-text', text: todo.status === 'in_progress' ? todo.activeForm : todo.content });
    }
  }
}

function latestTodos(messages: readonly ChatMessage[]): TodoItem[] {
  let newerUser = false;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role === 'user') newerUser = true;
    if (message.role !== 'assistant') continue;
    const tools = message.toolCalls ?? [];
    for (let toolIndex = tools.length - 1; toolIndex >= 0; toolIndex--) {
      const tool = tools[toolIndex];
      if (tool.name !== 'TodoWrite' || tool.status === 'error' || tool.status === 'blocked') continue;
      const todos = parseTodos(tool.input.todos);
      if (todos === null) continue;
      return newerUser && todos.every(todo => todo.status === 'completed') ? [] : todos;
    }
  }
  return [];
}

function parseTodos(input: unknown): TodoItem[] | null {
  if (!Array.isArray(input)) return null;
  const todos: TodoItem[] = [];
  for (const item of input) {
    if (!item || typeof item !== 'object') return null;
    const { content, activeForm, status } = item as Record<string, unknown>;
    if (typeof content !== 'string' || !content.trim()
      || (status !== 'pending' && status !== 'in_progress' && status !== 'completed')) return null;
    todos.push({ content, status, activeForm: typeof activeForm === 'string' && activeForm.trim() ? activeForm : content });
  }
  return todos;
}
