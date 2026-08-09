import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import InlineMarkdown from './inlineMarkdown';

describe('InlineMarkdown', () => {
  it('renders **bold** as <strong> instead of literal asterisks', () => {
    const { container } = render(<InlineMarkdown>{'Fixed **the crash** on save'}</InlineMarkdown>);
    expect(container.textContent).toBe('Fixed the crash on save');
    expect(container.querySelector('strong').textContent).toBe('the crash');
  });

  it('renders `code` as <code>', () => {
    const { container } = render(<InlineMarkdown>{'Set `DATABASE_URL` first'}</InlineMarkdown>);
    expect(container.querySelector('code').textContent).toBe('DATABASE_URL');
    expect(container.textContent).toBe('Set DATABASE_URL first');
  });

  it('renders http links and marks them noopener', () => {
    render(<InlineMarkdown>{'See [the docs](https://example.com/x) for more'}</InlineMarkdown>);
    const link = screen.getByRole('link', { name: 'the docs' });
    expect(link).toHaveAttribute('href', 'https://example.com/x');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('refuses non-http schemes and leaves the source literal', () => {
    const { container } = render(<InlineMarkdown>{'[click](javascript:alert(1))'}</InlineMarkdown>);
    expect(container.querySelector('a')).toBeNull();
    expect(container.textContent).toBe('[click](javascript:alert(1))');
  });

  it('escapes raw HTML rather than interpreting it', () => {
    const { container } = render(<InlineMarkdown>{'<img src=x onerror=boom> **ok**'}</InlineMarkdown>);
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toBe('<img src=x onerror=boom> ok');
  });

  it('handles several markers in one string', () => {
    const { container } = render(
      <InlineMarkdown>{'**A** then `b` then [c](https://e.co) end'}</InlineMarkdown>
    );
    expect(container.querySelector('strong').textContent).toBe('A');
    expect(container.querySelector('code').textContent).toBe('b');
    expect(container.querySelector('a').textContent).toBe('c');
    expect(container.textContent).toBe('A then b then c end');
  });

  it('passes plain text through untouched', () => {
    const { container } = render(<InlineMarkdown>{'nothing special here'}</InlineMarkdown>);
    expect(container.textContent).toBe('nothing special here');
  });
});
