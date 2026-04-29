import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import PasswordInput from './PasswordInput';
import { I18nProvider } from '../i18n';

function wrap(ui) {
  return render(<I18nProvider>{ui}</I18nProvider>);
}

describe('PasswordInput', () => {
  it('renders as type=password by default', () => {
    wrap(<PasswordInput id="p" value="" onChange={() => {}} placeholder="enter pw" />);
    expect(screen.getByPlaceholderText('enter pw')).toHaveAttribute('type', 'password');
  });

  it('toggles to type=text when the eye button is clicked', async () => {
    const user = userEvent.setup();
    wrap(<PasswordInput id="p" value="" onChange={() => {}} placeholder="enter pw" />);
    const input = screen.getByPlaceholderText('enter pw');
    expect(input).toHaveAttribute('type', 'password');

    const showBtn = screen.getByRole('button', { name: /show password/i });
    await user.click(showBtn);
    expect(input).toHaveAttribute('type', 'text');

    // Button label flips to "Hide password"
    expect(screen.getByRole('button', { name: /hide password/i })).toBeInTheDocument();
  });

  it('forwards onChange events', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    wrap(<PasswordInput id="p" value="" onChange={onChange} placeholder="pw" />);
    await user.type(screen.getByPlaceholderText('pw'), 'abc');
    expect(onChange).toHaveBeenCalled();
  });

  it('respects autoComplete prop (default current-password)', () => {
    wrap(<PasswordInput id="p" value="" onChange={() => {}} />);
    const inputs = screen.getAllByDisplayValue('');
    const pwInput = inputs.find(i => i.tagName === 'INPUT');
    expect(pwInput).toHaveAttribute('autocomplete', 'current-password');
  });
});
