import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, nextTick, type App, type Component } from 'vue';
import { createVuetify } from 'vuetify';
import IssueBoard from '../src/components/IssueBoard.vue';
import ProjectDescription from '../src/components/projects/ProjectDescription.vue';
import { BOARD_COLUMNS } from '../src/issues';
import { markdownToText } from '../src/markdown-rich';

const DESCRIPTION = [
  '## Goal',
  'Learn the **Acme** codebase.',
  '',
  'Constraints:',
  '- The module rules are non-negotiable',
  '- See [the docs](https://example.com/docs)',
  '- <script>alert(1)</script>',
].join('\n');

let app: App | undefined;
let host: HTMLDivElement | undefined;

function mount(component: Component, props: Record<string, unknown>): HTMLDivElement {
  host = document.createElement('div');
  document.body.append(host);
  app = createApp(component, props);
  app.use(createVuetify());
  app.component('RouterLink', { props: ['to'], template: '<a><slot /></a>' });
  app.mount(host);
  return host;
}

/** jsdom has no layout; pretend the clamped body is taller than its box (or not). */
function fakeLayout(scrollHeight: number, clientHeight: number): void {
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(scrollHeight);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(clientHeight);
}

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  );
});

afterEach(() => {
  app?.unmount();
  host?.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('project description', () => {
  it('renders markdown as HTML, sanitised, with safe links', () => {
    fakeLayout(40, 40);
    const el = mount(ProjectDescription, { source: DESCRIPTION });
    expect(el.querySelector('h2')?.textContent).toBe('Goal');
    expect(el.querySelector('strong')?.textContent).toBe('Acme');
    expect(el.querySelectorAll('li')).toHaveLength(3);
    const link = el.querySelector('a');
    expect(link?.getAttribute('href')).toBe('https://example.com/docs');
    expect(link?.getAttribute('rel')).toContain('noopener');
    expect(el.querySelector('script')).toBeNull();
    expect(el.textContent).toContain('<script>alert(1)</script>');
  });

  it('clamps long text and toggles between show more and show less', async () => {
    fakeLayout(400, 96);
    const el = mount(ProjectDescription, { source: DESCRIPTION, lines: 4 });
    await nextTick();
    const body = el.querySelector('.project-description__body') as HTMLElement;
    expect(body.classList).toContain('project-description__body--clamped');
    expect(body.style.getPropertyValue('--clamp-lines')).toBe('4');
    const toggle = el.querySelector('[data-test="description-toggle"]') as HTMLButtonElement;
    expect(toggle.textContent).toContain('Show more');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');

    toggle.click();
    await nextTick();
    expect(body.classList).not.toContain('project-description__body--clamped');
    expect(toggle.textContent).toContain('Show less');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');

    toggle.click();
    await nextTick();
    expect(body.classList).toContain('project-description__body--clamped');
  });

  it('shows no toggle when the text fits', async () => {
    fakeLayout(48, 96);
    const el = mount(ProjectDescription, { source: 'Short.' });
    await nextTick();
    expect(el.querySelector('[data-test="description-toggle"]')).toBeNull();
  });
});

describe('markdownToText', () => {
  it('turns markdown into readable lines with bullets and no markup', () => {
    expect(markdownToText(DESCRIPTION)).toBe(
      [
        'Goal',
        'Learn the Acme codebase.',
        'Constraints:',
        '• The module rules are non-negotiable',
        '• See the docs',
        '• <script>alert(1)</script>',
      ].join('\n'),
    );
    expect(markdownToText('')).toBe('');
  });
});

describe('issue board', () => {
  const props = (extra: Record<string, unknown> = {}) => ({
    columns: BOARD_COLUMNS,
    agentNames: {},
    ...extra,
  });

  it('shows an empty state in every empty column and a create action in To do', async () => {
    const onCreate = vi.fn();
    const el = mount(IssueBoard, props({ issues: [], canCreate: true, onCreate }));
    expect(el.querySelectorAll('[data-test="column-empty"]')).toHaveLength(BOARD_COLUMNS.length);
    expect(el.textContent).toContain('No issues');
    const todo = el.querySelector('[data-column="todo"]') as HTMLElement;
    expect(todo.textContent).toContain('Create one to get work started');
    const create = el.querySelectorAll('[data-test="column-create"]');
    expect(create).toHaveLength(1);
    (create[0] as HTMLButtonElement).click();
    await nextTick();
    expect(onCreate).toHaveBeenCalledOnce();
  });

  it('counts issues per column and only shows empty states where nothing is', () => {
    const issues = [
      { id: '1', key: 'GP-1', title: 'First', status: 'todo', priority: 'medium' },
      { id: '2', key: 'GP-2', title: 'Second', status: 'todo', priority: 'high' },
      { id: '3', key: 'GP-3', title: 'Third', status: 'done', priority: 'medium' },
    ];
    const el = mount(IssueBoard, props({ issues }));
    const count = (id: string) =>
      el.querySelector(`[data-column="${id}"] [data-test="column-count"]`)?.textContent?.trim();
    expect(count('todo')).toBe('2');
    expect(count('done')).toBe('1');
    expect(count('backlog')).toBe('0');
    expect(el.querySelector('[data-column="todo"] [data-test="column-empty"]')).toBeNull();
    expect(el.querySelector('[data-column="backlog"] [data-test="column-empty"]')).not.toBeNull();
    expect(el.querySelector('[data-test="column-create"]')).toBeNull();
  });

  it('says nothing matches when a filter empties the columns', () => {
    const el = mount(IssueBoard, props({ issues: [], filtered: true, canCreate: true }));
    expect(el.textContent).toContain('No matching issues');
    expect(el.textContent).not.toContain('Create one');
    expect(el.querySelector('[data-test="column-create"]')).toBeNull();
  });
});
