import React, { useRef, useState } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Modal, { Drawer } from './Modal';

function Harness({ onClose = () => {}, ...props }) {
  return (
    <div>
      <button data-testid="outside">Outside</button>
      <Modal onClose={onClose} label="Test dialog" {...props}>
        <button data-testid="first">First</button>
        <input data-testid="middle" />
        <button data-testid="last">Last</button>
      </Modal>
    </div>
  );
}

// The modal focuses its first focusable child on a 0ms timer.
async function flushOpenFocus() {
  await act(async () => { await new Promise(r => setTimeout(r, 0)); });
}

describe('Modal', () => {
  it('exposes dialog semantics and an accessible name', async () => {
    render(<Harness />);
    await flushOpenFocus();
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAccessibleName('Test dialog');
  });

  it('supports aria-labelledby instead of aria-label', async () => {
    render(
      <Modal onClose={() => {}} labelledBy="dlg-title">
        <h3 id="dlg-title">Invite a teammate</h3>
        <button>ok</button>
      </Modal>
    );
    await flushOpenFocus();
    expect(screen.getByRole('dialog')).toHaveAccessibleName('Invite a teammate');
  });

  it('moves focus into the dialog on open', async () => {
    render(<Harness />);
    await flushOpenFocus();
    expect(screen.getByTestId('first')).toHaveFocus();
  });

  it('honours initialFocusRef over the first focusable child', async () => {
    function WithInitialFocus() {
      const ref = useRef(null);
      return (
        <Modal onClose={() => {}} label="x" initialFocusRef={ref}>
          <button data-testid="first">First</button>
          <input data-testid="target" ref={ref} />
        </Modal>
      );
    }
    render(<WithInitialFocus />);
    await flushOpenFocus();
    expect(screen.getByTestId('target')).toHaveFocus();
  });

  it('restores focus to the trigger when it unmounts', async () => {
    function Toggler() {
      const [open, setOpen] = useState(false);
      return (
        <div>
          <button data-testid="trigger" onClick={() => setOpen(true)}>Open</button>
          {open && (
            <Modal onClose={() => setOpen(false)} label="x">
              <button data-testid="inside">Inside</button>
            </Modal>
          )}
        </div>
      );
    }
    render(<Toggler />);
    const trigger = screen.getByTestId('trigger');
    trigger.focus();
    await userEvent.click(trigger);
    await flushOpenFocus();
    expect(screen.getByTestId('inside')).toHaveFocus();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it('closes on ESC', async () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    await flushOpenFocus();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not close on ESC when closeOnEsc is false', async () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} closeOnEsc={false} />);
    await flushOpenFocus();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes on backdrop click but not on content click', async () => {
    const onClose = vi.fn();
    const { container } = render(<Harness onClose={onClose} />);
    await flushOpenFocus();

    fireEvent.click(screen.getByTestId('first'));
    expect(onClose).not.toHaveBeenCalled();

    const overlay = container.querySelector('.modal-overlay');
    fireEvent.click(overlay);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('traps Tab at the end of the dialog', async () => {
    render(<Harness />);
    await flushOpenFocus();
    const last = screen.getByTestId('last');
    last.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(screen.getByTestId('first')).toHaveFocus();
  });

  it('traps Shift+Tab at the start of the dialog', async () => {
    render(<Harness />);
    await flushOpenFocus();
    const first = screen.getByTestId('first');
    first.focus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(screen.getByTestId('last')).toHaveFocus();
  });

  it('pulls focus back in if it escaped the dialog', async () => {
    render(<Harness />);
    await flushOpenFocus();
    screen.getByTestId('outside').focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(screen.getByTestId('first')).toHaveFocus();
  });
});

describe('stacked dialogs', () => {
  it('only the topmost dialog reacts to ESC', async () => {
    const outer = vi.fn();
    const inner = vi.fn();
    render(
      <div>
        <Modal onClose={outer} label="Outer">
          <button data-testid="outer-btn">Outer</button>
          <Modal onClose={inner} label="Inner">
            <button data-testid="inner-btn">Inner</button>
          </Modal>
        </Modal>
      </div>
    );
    await flushOpenFocus();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(inner).toHaveBeenCalledTimes(1);
    expect(outer).not.toHaveBeenCalled();
  });
});

describe('Drawer', () => {
  it('renders a labelled modal dialog and closes on ESC', async () => {
    const onClose = vi.fn();
    render(
      <Drawer onClose={onClose} label="Contact thread">
        <button data-testid="inside">Inside</button>
      </Drawer>
    );
    await flushOpenFocus();
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAccessibleName('Contact thread');
    expect(screen.getByTestId('inside')).toHaveFocus();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
