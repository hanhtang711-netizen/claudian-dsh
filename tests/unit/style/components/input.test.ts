/** @jest-environment jsdom */

import { readFileSync } from 'node:fs';
import path from 'node:path';

describe('Composer input styles', () => {
  const css = [
    'src/style/components/input.css',
    'src/style/components/composer-editor.css',
    'src/style/components/composer-info-row.css',
    'src/style/toolbar/model-selector.css',
    'src/style/toolbar/permission-toggle.css',
    'src/style/base/visibility.css',
  ]
    .map(file => readFileSync(path.resolve(file), 'utf8'))
    .join('\n');

  afterEach(() => {
    document.head.replaceChildren();
    document.body.replaceChildren();
  });

  function renderComposer(): HTMLElement {
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
    document.body.innerHTML = `
      <div class="claudian-input-composer">
        <div class="claudian-input-container">
          <div class="claudian-input-nav-row"></div>
          <div class="claudian-input-wrapper">
            <div class="claudian-input-queue-strip claudian-hidden"></div>
            <div class="claudian-context-row"></div>
            <div class="claudian-composer-editor"><div class="cm-content"></div></div>
            <div class="claudian-input-toolbar">
              <div class="claudian-toolbar-chip-anchor claudian-toolbar-chip-anchor--model"></div>
              <div class="claudian-toolbar-chip-anchor claudian-permission-toggle">
                <div class="claudian-toolbar-popover"></div>
              </div>
            </div>
          </div>
          <div class="claudian-input-info-row">
            <div class="claudian-input-info-linked"></div>
          </div>
        </div>
      </div>
    `;
    return document.querySelector('.claudian-input-composer') as HTMLElement;
  }

  const style = (el: Element) => window.getComputedStyle(el);

  it('keeps task text compact and monochrome without native button chrome', () => {
    const nativeStyle = document.createElement('style');
    nativeStyle.textContent = 'button:not(.clickable-icon) { background-color: rgba(255, 255, 255, 0.05); box-shadow: 0 1px 2px black; }';
    document.head.appendChild(nativeStyle);
    renderComposer();
    const panel = document.createElement('section');
    panel.className = 'claudian-task-panel';
    panel.innerHTML = `<button type="button" class="claudian-task-panel-toggle">Tasks 0/1</button>
      <ul class="claudian-task-panel-list"><li class="claudian-task-panel-item claudian-task-panel-in_progress">
      <span class="claudian-task-panel-icon">•</span><span>Working</span></li></ul>`;
    document.body.appendChild(panel);
    expect(style(panel).getPropertyValue('border')).toBe('0px');
    expect(style(panel).getPropertyValue('border-radius')).toBe('0');
    expect(['rgba(0, 0, 0, 0)', 'transparent']).toContain(style(panel).backgroundColor);
    const row = panel.querySelector('.claudian-task-panel-item')!;
    expect(style(panel).fontSize).toBe('13px');
    expect(style(panel).fontFamily).toBe('var(--font-monospace)');
    expect(style(row).fontSize).toBe('12.5px');
    const toggle = panel.querySelector('.claudian-task-panel-toggle')!;
    expect(style(toggle).fontSize).toBe('13px');
    expect(style(toggle).fontFamily).toBe('var(--font-monospace)');
    expect(style(toggle).lineHeight).toBe('1.5');
    expect(style(toggle).fontWeight).toBe('400');
    expect(['rgba(0, 0, 0, 0)', 'transparent']).toContain(style(toggle).backgroundColor);
    expect(style(toggle).boxShadow).toBe('none');
    expect(style(row).lineHeight).toBe('1.4');
    expect(style(row).getPropertyValue('color')).toBe('var(--text-normal)');
    const icon = row.querySelector('.claudian-task-panel-icon')!;
    expect(['inherit', style(row).color]).toContain(style(icon).color);
    expect(style(row).alignItems).toBe('baseline');
    row.classList.replace('claudian-task-panel-in_progress', 'claudian-task-panel-completed');
    expect(style(row).color).toBe('var(--text-muted)');
    expect(['inherit', style(row).color]).toContain(style(icon).color);
    expect(style(panel.querySelector('.claudian-task-panel-list')!).maxHeight).toBe('180px');
  });

  it('sizes the idle input box from its content instead of a fixed floor', () => {
    const composer = renderComposer();
    const wrapper = style(composer.querySelector('.claudian-input-wrapper')!);
    expect(['', '0', '0px', 'auto']).toContain(wrapper.minHeight);
    expect(wrapper.flexDirection).toBe('column');
    // About two lines of text before the toolbar.
    expect(style(composer.querySelector('.claudian-composer-editor')!).minHeight).toBe('48px');
    expect(style(composer.querySelector('.cm-content')!).minHeight).toBe('48px');
  });

  it('lays a wrapped hint out inline, so the caret beside it stays one line tall', () => {
    const composer = renderComposer();
    const hint = document.createElement('span');
    hint.className = 'cm-placeholder';
    composer.querySelector('.cm-content')!.appendChild(hint);
    // CodeMirror's default inline-block makes the native caret as tall as the whole wrapped hint.
    expect(style(hint).display).toBe('inline');
  });

  it('keeps the input box unfilled, as before the redesign, and sizes toolbar labels from it', () => {
    const wrapper = style(renderComposer().querySelector('.claudian-input-wrapper')!);
    expect(['', 'rgba(0, 0, 0, 0)', 'transparent']).toContain(wrapper.getPropertyValue('background-color'));
    // The box, not the shrink-wrapped toolbar, is the size container for narrow-width labels.
    expect(wrapper.getPropertyValue('container-type')).toBe('inline-size');
  });

  it('shows the queued-message strip only while visible, as a cap on the input box', () => {
    const strip = renderComposer().querySelector<HTMLElement>('.claudian-input-queue-strip')!;
    expect(style(strip).display).toBe('none');
    strip.classList.replace('claudian-hidden', 'claudian-visible-flex');
    expect(style(strip).display).toBe('flex');
    // jsdom does not compute border longhands, so read the strip's own declaration.
    const rule = Array.from(document.head.querySelector('style')!.sheet!.cssRules)
      .find((candidate): candidate is CSSStyleRule => (
        candidate instanceof CSSStyleRule && candidate.selectorText === '.claudian-input-queue-strip'
      ))!;
    expect(rule.style.getPropertyValue('border-bottom')).toBe('1px solid var(--background-modifier-border)');
  });

  it('gives every composer button outside the toolbar a visible keyboard focus outline', () => {
    renderComposer();
    const rules = Array.from(document.head.querySelector('style')!.sheet!.cssRules)
      .filter((rule): rule is CSSStyleRule => rule instanceof CSSStyleRule);
    for (const control of [
      'claudian-input-info-linked-main',
      'claudian-input-info-linked-remove',
      'claudian-queue-indicator-action',
      'claudian-queue-indicator-icon-action',
    ]) {
      const outline = rules
        .filter(rule => rule.selectorText.split(',').some(selector => (
          selector.includes(':focus-visible')
          && (selector.includes(control) || selector.includes('.claudian-input-info-linked > button:focus-visible'))
        )))
        .map(rule => rule.style.getPropertyValue('outline'))
        .find(Boolean);
      expect([control, outline]).toEqual([control, '2px solid var(--interactive-accent)']);
    }
  });

  it('pushes the permission control to the far end of the toolbar, its menu opening end-aligned', () => {
    const composer = renderComposer();
    const anchor = composer.querySelector('.claudian-permission-toggle')!;
    expect(style(anchor).getPropertyValue('margin-inline-start')).toBe('auto');
    const popover = style(anchor.querySelector('.claudian-toolbar-popover')!);
    expect([popover.getPropertyValue('inset-inline-start'), popover.getPropertyValue('inset-inline-end')]).toEqual(['auto', '0']);
  });

  it('keeps the info row borderless', () => {
    const composer = renderComposer();
    const row = composer.querySelector<HTMLElement>('.claudian-input-info-row')!;
    expect(style(row).display).toBe('flex');
    expect(style(row).borderStyle).toBe('');
  });
});
