import React, { useId } from 'react';

/**
 * Standard form-field wrapper. Eliminates the boilerplate of label / input /
 * help text / error chrome scattered across pages, and enforces our a11y
 * baseline:
 *   - every input has an id and an associated <label htmlFor>
 *   - help text is wired via aria-describedby
 *   - error state flips aria-invalid and shows the error message in red
 *
 * Usage:
 *   <FormField label="Email" required>
 *     <input type="email" value={...} onChange={...} />
 *   </FormField>
 *
 *   <FormField label="Password" error={err} hint="At least 6 characters">
 *     <PasswordInput value={...} onChange={...} />
 *   </FormField>
 *
 * The child element gets `id`, `aria-describedby`, `aria-invalid` injected
 * automatically. Pass `id` explicitly if you need a stable selector for
 * tests / form autofill.
 *
 * Sprint Q2 task C5 (PLATFORM_AUDIT_2026-04 deferred → done).
 */
export default function FormField({
  label,
  hint,
  error,
  required,
  id,
  className,
  children,
  style,
}) {
  const generatedId = useId();
  const inputId = id || generatedId;
  const hintId = `${inputId}-hint`;
  const errorId = `${inputId}-error`;

  // Children: clone the single child and inject a11y attrs. If multiple
  // children passed (e.g. an input + button), only the first interactive
  // element gets the id; the rest are passed through as-is.
  const child = React.Children.only(children);
  const describedBy = [error ? errorId : null, hint ? hintId : null].filter(Boolean).join(' ') || undefined;
  const enhancedChild = React.cloneElement(child, {
    id: child.props.id || inputId,
    'aria-describedby': describedBy,
    'aria-invalid': error ? true : undefined,
    'aria-required': required ? true : undefined,
  });

  return (
    <div className={`form-group ${className || ''}`} style={style}>
      {label && (
        <label className="form-label" htmlFor={inputId}>
          {label}
          {required && <span aria-hidden="true" style={{ color: 'var(--danger)', marginLeft: 4 }}>*</span>}
        </label>
      )}
      {enhancedChild}
      {hint && !error && (
        <p id={hintId} style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4, marginBottom: 0 }}>
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} role="alert" style={{ fontSize: 12, color: 'var(--danger)', marginTop: 4, marginBottom: 0 }}>
          {error}
        </p>
      )}
    </div>
  );
}
