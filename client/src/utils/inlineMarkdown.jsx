import React from 'react';

/**
 * Minimal inline-markdown renderer — no new dependency, no `dangerouslySetInnerHTML`.
 *
 * Handles exactly the inline constructs our CHANGELOG uses:
 *   `**bold**`  →  <strong>
 *   `` `code` ``→  <code>
 *   `[text](url)` → <a> (http/https/mailto only; everything else stays literal)
 *
 * Everything else is emitted as plain text, so any other markup in the source
 * shows up verbatim rather than being interpreted — React escapes it for us.
 */

const TOKEN = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\[[^\]\n]+\]\([^)\s]+\))/g;
const SAFE_HREF = /^(https?:\/\/|mailto:)/i;

export function renderInlineMarkdown(source) {
  if (source == null) return null;
  const text = String(source);
  const out = [];
  let lastIndex = 0;
  let key = 0;

  TOKEN.lastIndex = 0;
  let match;
  while ((match = TOKEN.exec(text)) !== null) {
    if (match.index > lastIndex) out.push(text.slice(lastIndex, match.index));
    const [raw] = match;

    if (raw.startsWith('`')) {
      out.push(
        <code
          key={key++}
          style={{
            background: 'var(--bg-input)',
            padding: '1px 5px',
            borderRadius: 4,
            fontSize: '0.92em',
          }}
        >
          {raw.slice(1, -1)}
        </code>
      );
    } else if (raw.startsWith('**')) {
      out.push(<strong key={key++}>{raw.slice(2, -2)}</strong>);
    } else {
      const split = raw.indexOf('](');
      const label = raw.slice(1, split);
      const href = raw.slice(split + 2, -1);
      if (SAFE_HREF.test(href)) {
        out.push(
          <a key={key++} href={href} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)' }}>
            {label}
          </a>
        );
      } else {
        // Unsafe / relative scheme: keep the raw source instead of linking.
        out.push(raw);
      }
    }
    lastIndex = match.index + raw.length;
  }

  if (lastIndex < text.length) out.push(text.slice(lastIndex));
  return out.length === 0 ? text : out;
}

/** Convenience wrapper so call sites read as JSX. */
export default function InlineMarkdown({ children }) {
  return <>{renderInlineMarkdown(children)}</>;
}
