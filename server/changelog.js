/**
 * Changelog parser. Reads docs/CHANGELOG.md and returns structured entries.
 *
 * Format expected:
 *   ## YYYY-MM-DD — codename
 *   ### Added
 *   - Bullet
 *   - Bullet
 *   ### Changed
 *   - Bullet
 *
 * Anything before the first `## ` heading or after the next `---` separator
 * is treated as preamble / footer and skipped.
 *
 * Cached in-memory for 60s so frequent requests don't re-parse.
 */

const fs = require('fs');
const path = require('path');

const CHANGELOG_PATH = path.join(__dirname, '..', 'docs', 'CHANGELOG.md');
const CACHE_TTL_MS = 60_000;

let _cache = null;
let _cacheAt = 0;

function isoDateOrNull(s) {
  if (!s) return null;
  const m = String(s).trim().match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

function parse(markdown) {
  // Top-level entries split on `## ` (two hashes + space at line start).
  // Use a leading newline so the first entry parses cleanly.
  const text = '\n' + markdown.replace(/\r\n/g, '\n');
  const headingRegex = /\n## ([^\n]+)\n/g;
  const headings = [];
  let m;
  while ((m = headingRegex.exec(text)) !== null) {
    headings.push({ start: m.index, headEnd: m.index + m[0].length, title: m[1].trim() });
  }
  const entries = [];
  for (let i = 0; i < headings.length; i++) {
    const head = headings[i];
    const next = headings[i + 1];
    const body = text.slice(head.headEnd, next ? next.start : undefined);
    // Title pattern: "YYYY-MM-DD — codename" (em-dash) or just "YYYY-MM-DD"
    const dateMatch = head.title.match(/^(\d{4}-\d{2}-\d{2})\s*[—–-]?\s*(.*)$/);
    const date = dateMatch ? dateMatch[1] : null;
    const codename = dateMatch ? dateMatch[2].trim() || null : head.title;
    if (!date) continue; // skip headings that aren't dated entries

    // Group bullets by `### Section`. Sections we know about; anything else
    // gets folded into `notes` so we don't lose content.
    const groups = { added: [], changed: [], fixed: [], removed: [], notes: [] };
    // Match `### Heading` at start-of-body OR after newline, so the first
    // sub-section after the entry heading isn't missed.
    const sectionRegex = /(?:^|\n)### ([^\n]+)\n/g;
    const sectionHeads = [];
    let sm;
    while ((sm = sectionRegex.exec(body)) !== null) {
      sectionHeads.push({ start: sm.index, headEnd: sm.index + sm[0].length, name: sm[1].trim().toLowerCase() });
    }
    if (sectionHeads.length === 0) {
      // No sub-sections — bullets at the entry level go into notes.
      groups.notes.push(...extractBullets(body));
    } else {
      for (let j = 0; j < sectionHeads.length; j++) {
        const sh = sectionHeads[j];
        const sNext = sectionHeads[j + 1];
        const sectionBody = body.slice(sh.headEnd, sNext ? sNext.start : undefined);
        const bullets = extractBullets(sectionBody);
        const key = (
          sh.name.startsWith('add')    ? 'added'
        : sh.name.startsWith('chang')  ? 'changed'
        : sh.name.startsWith('fix')    ? 'fixed'
        : sh.name.startsWith('remove') ? 'removed'
        : 'notes'
        );
        groups[key].push(...bullets);
      }
    }

    entries.push({
      date,
      codename,
      added: groups.added,
      changed: groups.changed,
      fixed: groups.fixed,
      removed: groups.removed,
      notes: groups.notes,
    });
  }
  // Newest first (the doc is already that way, but sort defensively).
  entries.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  return entries;
}

function extractBullets(body) {
  const out = [];
  for (const line of body.split('\n')) {
    const m = line.match(/^\s*-\s+(.*)$/);
    if (m && m[1].trim()) out.push(m[1].trim());
  }
  return out;
}

async function getEntries({ force = false } = {}) {
  const now = Date.now();
  if (!force && _cache && now - _cacheAt < CACHE_TTL_MS) return _cache;
  let text;
  try {
    text = await fs.promises.readFile(CHANGELOG_PATH, 'utf8');
  } catch {
    _cache = [];
    _cacheAt = now;
    return _cache;
  }
  _cache = parse(text);
  _cacheAt = now;
  return _cache;
}

function _resetCacheForTest() {
  _cache = null;
  _cacheAt = 0;
}

module.exports = { getEntries, parse, isoDateOrNull, extractBullets, _resetCacheForTest };
