import { setIcon } from 'obsidian';

import type { ProviderRateLimitService, ProviderRateLimitState } from '@/core/providers/types';

/** Account-scoped presentation: never follows the active conversation's provider. */
export class AccountQuotaDashboard {
  private readonly root: HTMLElement;
  private readonly windows: HTMLElement;
  private readonly refreshButton: HTMLButtonElement;
  private readonly unsubscribe: () => void;
  private disposed = false;
  private refreshRevision = 0;

  constructor(container: HTMLElement, private readonly service: ProviderRateLimitService) {
    this.root = container.createDiv({ cls: 'claudian-codex-rate-limits' });
    this.root.createSpan({ cls: 'claudian-codex-rate-limits-label', text: 'Codex 额度' });
    this.windows = this.root.createDiv({
      cls: 'claudian-codex-rate-limits-windows', attr: { 'aria-live': 'polite' },
    });
    this.refreshButton = this.root.createEl('button', {
      cls: 'claudian-codex-rate-limits-refresh', attr: { type: 'button', 'aria-label': '刷新 Codex 额度' },
    });
    setIcon(this.refreshButton, 'refresh-cw');
    this.refreshButton.addEventListener('click', this.refresh);
    this.unsubscribe = service.subscribe(state => this.render(state));
  }

  setVisible(visible: boolean): void {
    this.root.hidden = !visible;
  }

  dispose(): void {
    this.disposed = true;
    this.refreshRevision++;
    this.unsubscribe();
    this.refreshButton.removeEventListener('click', this.refresh);
    this.root.remove();
  }

  private readonly refresh = (): void => {
    const revision = ++this.refreshRevision;
    this.refreshButton.setAttribute('aria-busy', 'true');
    void this.service.refresh().catch(() => undefined).finally(() => {
      if (!this.disposed && revision === this.refreshRevision) this.refreshButton.removeAttribute('aria-busy');
    });
  };

  private render(state: ProviderRateLimitState): void {
    if (this.disposed) return;
    this.windows.empty();
    if (state.status !== 'ready') {
      this.windows.createSpan({ cls: 'claudian-codex-rate-limits-unavailable', text: '暂不可读取' });
      return;
    }
    for (const quota of state.windows) {
      const severity = quota.remainingPercent <= 5 ? 'critical' : quota.remainingPercent <= 20 ? 'warning' : 'normal';
      const reset = quota.resetsAt === null ? null : new Date(quota.resetsAt * 1000);
      const text = quota.remainingPercent === 0 && reset
        ? `${quota.label} 已满 · ${reset.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}重置`
        : `${quota.label} 剩 ${quota.remainingPercent}%`;
      this.windows.createSpan({
        cls: `claudian-codex-rate-limit-window claudian-codex-rate-limit-${severity}`, text,
        attr: { title: `已用 ${quota.usedPercent}%${reset ? ` · 预计重置：${reset.toLocaleString()}` : ''}` },
      });
    }
  }
}
