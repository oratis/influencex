import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import FormField from './FormField';

describe('FormField', () => {
  it('renders label + input together with proper htmlFor/id linking', () => {
    render(
      <FormField label="Email">
        <input data-testid="input" type="email" />
      </FormField>
    );
    const input = screen.getByTestId('input');
    const label = screen.getByText('Email');
    expect(label).toHaveAttribute('for', input.id);
  });

  it('applies aria-required + asterisk when required', () => {
    render(
      <FormField label="Name" required>
        <input data-testid="input" />
      </FormField>
    );
    expect(screen.getByTestId('input')).toHaveAttribute('aria-required', 'true');
    expect(screen.getByText('Name').textContent).toContain('*');
  });

  it('shows hint text via aria-describedby', () => {
    render(
      <FormField label="Bio" hint="Up to 200 characters">
        <input data-testid="input" />
      </FormField>
    );
    const input = screen.getByTestId('input');
    const hintId = input.getAttribute('aria-describedby');
    expect(hintId).toBeTruthy();
    expect(document.getElementById(hintId).textContent).toBe('Up to 200 characters');
  });

  it('shows error with role=alert and flips aria-invalid', () => {
    render(
      <FormField label="Email" error="Invalid format">
        <input data-testid="input" />
      </FormField>
    );
    const input = screen.getByTestId('input');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    const err = screen.getByRole('alert');
    expect(err.textContent).toBe('Invalid format');
    // Error wires up describedby (winning over hint when both present)
    expect(input.getAttribute('aria-describedby')).toContain(err.id);
  });

  it('hides hint when error is present (error wins)', () => {
    render(
      <FormField label="Email" hint="Helpful tip" error="Bad email">
        <input data-testid="input" />
      </FormField>
    );
    expect(screen.queryByText('Helpful tip')).toBeNull();
    expect(screen.getByText('Bad email')).toBeInTheDocument();
  });

  it('respects an explicit id prop instead of generating one', () => {
    render(
      <FormField label="Custom" id="my-custom-id">
        <input data-testid="input" />
      </FormField>
    );
    expect(screen.getByTestId('input')).toHaveAttribute('id', 'my-custom-id');
    expect(screen.getByText('Custom')).toHaveAttribute('for', 'my-custom-id');
  });
});
