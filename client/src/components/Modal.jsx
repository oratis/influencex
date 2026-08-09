import React, { useEffect, useRef } from 'react';

/**
 * Modal / Drawer primitives — the single implementation of the dialog contract
 * described in docs/design.md §8.3 / §10.3.
 *
 * The contract (previously only honoured by ConfirmDialog, hand-rolled and
 * skipped by 8+ other modals):
 *   1. `role="dialog"` + `aria-modal="true"` + an accessible name
 *      (`label` or `labelledBy`).
 *   2. Focus moves into the dialog on open (explicit `initialFocusRef`, else
 *      the first focusable descendant, else the dialog itself).
 *   3. Focus is trapped: Tab / Shift+Tab cycle within the dialog.
 *   4. ESC closes.
 *   5. Backdrop click closes.
 *   6. Focus returns to the element that opened the dialog on close.
 *
 * Both `<Modal>` and `<Drawer>` keep their children's existing markup — they
 * only own the overlay, the dialog element and the behaviour above. Pass
 * `className` / `style` / `overlayClassName` / `overlayStyle` to preserve a
 * call site's original look.
 */

// Deliberately not filtered by visibility: jsdom has no layout, so
// `offsetParent`/`getClientRects` checks would make the trap untestable.
const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'summary',
  '[tabindex]:not([tabindex="-1"])',
  '[contenteditable="true"]',
].join(',');

function focusableWithin(node) {
  if (!node) return [];
  return Array.from(node.querySelectorAll(FOCUSABLE_SELECTOR))
    .filter(el => !el.hasAttribute('disabled') && el.getAttribute('aria-hidden') !== 'true');
}

// Registry of open dialogs. Every instance listens on `document`, so
// stopPropagation alone can't stop a sibling listener — without this, ESC
// inside a ConfirmDialog opened from a Drawer would close both at once.
//
// "Topmost" = the innermost dialog that doesn't contain another open dialog.
// Registration order breaks ties between siblings (React runs child effects
// before parent effects, so push order alone would get nesting backwards).
const openDialogs = [];

function topmostDialog() {
  const live = openDialogs.filter(d => d.ref.current);
  if (live.length === 0) return null;
  const leaves = live.filter(d => !live.some(o => o !== d && d.ref.current.contains(o.ref.current)));
  const pool = leaves.length > 0 ? leaves : live;
  return pool[pool.length - 1];
}

/**
 * Wire the dialog contract onto any container element.
 *
 * Returns a ref to attach to the dialog box (not the overlay).
 *
 *   const dialogRef = useModalBehavior({ onClose });
 *   <div ref={dialogRef} role="dialog" aria-modal="true">…</div>
 */
export function useModalBehavior({ onClose, initialFocusRef, closeOnEsc = true, trapFocus = true } = {}) {
  const containerRef = useRef(null);
  const previousFocusRef = useRef(null);
  const onCloseRef = useRef(onClose);

  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);

  useEffect(() => {
    previousFocusRef.current = document.activeElement;
    const entry = { ref: containerRef };
    openDialogs.push(entry);

    // Defer one tick so the dialog subtree is mounted before we hunt for a
    // focus target.
    const timer = setTimeout(() => {
      const explicit = initialFocusRef?.current;
      if (explicit && typeof explicit.focus === 'function') { explicit.focus(); return; }
      const node = containerRef.current;
      if (!node) return;
      const first = focusableWithin(node)[0];
      if (first) { first.focus(); return; }
      if (!node.hasAttribute('tabindex')) node.setAttribute('tabindex', '-1');
      node.focus();
    }, 0);

    function handleKeyDown(e) {
      // Only the topmost dialog reacts to ESC / owns the focus trap.
      if (topmostDialog() !== entry) return;
      if (closeOnEsc && e.key === 'Escape') {
        e.stopPropagation();
        onCloseRef.current?.();
        return;
      }
      if (!trapFocus || e.key !== 'Tab') return;
      const node = containerRef.current;
      if (!node) return;
      const items = focusableWithin(node);
      if (items.length === 0) {
        e.preventDefault();
        node.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      const inside = node.contains(active);
      if (e.shiftKey) {
        if (!inside || active === first) { e.preventDefault(); last.focus(); }
      } else if (!inside || active === last) {
        e.preventDefault();
        first.focus();
      }
    }

    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('keydown', handleKeyDown, true);
      const idx = openDialogs.indexOf(entry);
      if (idx !== -1) openDialogs.splice(idx, 1);
      const prev = previousFocusRef.current;
      if (prev && typeof prev.focus === 'function' && document.contains(prev)) {
        try { prev.focus(); } catch { /* element vanished mid-teardown */ }
      }
    };
    // Mount/unmount only — the dialog is mounted conditionally by its parent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return containerRef;
}

export default function Modal({
  onClose,
  label,
  labelledBy,
  describedBy,
  initialFocusRef,
  closeOnEsc = true,
  closeOnBackdrop = true,
  overlayClassName = 'modal-overlay',
  overlayStyle,
  className = 'modal',
  style,
  role = 'dialog',
  children,
  ...rest
}) {
  const dialogRef = useModalBehavior({ onClose, initialFocusRef, closeOnEsc });

  return (
    <div
      className={overlayClassName}
      style={overlayStyle}
      onClick={closeOnBackdrop ? (e) => { if (e.target === e.currentTarget) onClose?.(); } : undefined}
    >
      <div
        ref={dialogRef}
        className={className}
        style={style}
        role={role}
        aria-modal="true"
        aria-label={label}
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
        {...rest}
      >
        {children}
      </div>
    </div>
  );
}

/**
 * Right-side (or left-side) sliding panel. Same contract as <Modal>; the only
 * difference is layout — the overlay aligns the panel to an edge and the panel
 * is full-height.
 */
export function Drawer({
  onClose,
  label,
  labelledBy,
  initialFocusRef,
  side = 'right',
  width = 'min(640px, 100%)',
  closeOnEsc = true,
  closeOnBackdrop = true,
  overlayStyle,
  className,
  style,
  children,
  ...rest
}) {
  const dialogRef = useModalBehavior({ onClose, initialFocusRef, closeOnEsc });

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.55)',
        zIndex: 1000,
        display: 'flex',
        justifyContent: side === 'right' ? 'flex-end' : 'flex-start',
        ...overlayStyle,
      }}
      onClick={closeOnBackdrop ? (e) => { if (e.target === e.currentTarget) onClose?.(); } : undefined}
    >
      <div
        ref={dialogRef}
        className={className}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        aria-labelledby={labelledBy}
        style={{
          width,
          background: 'var(--bg-card)',
          borderLeft: side === 'right' ? '1px solid var(--border)' : undefined,
          borderRight: side === 'left' ? '1px solid var(--border)' : undefined,
          height: '100vh',
          display: 'flex',
          flexDirection: 'column',
          ...style,
        }}
        {...rest}
      >
        {children}
      </div>
    </div>
  );
}
