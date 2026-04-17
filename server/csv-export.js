/**
 * CSV export utilities.
 *
 * Spec: RFC 4180. Fields containing commas, quotes, or newlines are wrapped
 * in double-quotes with embedded quotes doubled. Includes a UTF-8 BOM so
 * Excel opens the file with proper encoding.
 */

const UTF8_BOM = '\uFEFF';

function escapeCell(value) {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Convert an array of objects to CSV.
 *
 * @param {Array<Object>} rows - Data rows
 * @param {Array<{key: string, label: string, format?: Function}>} columns - Column definitions
 * @returns {string} CSV text (with UTF-8 BOM for Excel)
 */
function toCsv(rows, columns) {
  const header = columns.map(c => escapeCell(c.label)).join(',');
  const lines = rows.map(row => {
    return columns.map(col => {
      const raw = row[col.key];
      const value = col.format ? col.format(raw, row) : raw;
      return escapeCell(value);
    }).join(',');
  });
  return UTF8_BOM + [header, ...lines].join('\r\n');
}

/**
 * Format a Date or ISO string as YYYY-MM-DD HH:mm.
 */
function formatDateTime(v) {
  if (!v) return '';
  try {
    const d = typeof v === 'string' ? new Date(v) : v;
    if (isNaN(d.getTime())) return String(v);
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  } catch {
    return String(v);
  }
}

/**
 * Column presets for common export targets.
 */
const COLUMNS = {
  kols: [
    { key: 'display_name', label: 'Name' },
    { key: 'username', label: 'Handle' },
    { key: 'platform', label: 'Platform' },
    { key: 'followers', label: 'Followers' },
    { key: 'engagement_rate', label: 'Engagement %' },
    { key: 'avg_views', label: 'Avg Views' },
    { key: 'category', label: 'Category' },
    { key: 'email', label: 'Email' },
    { key: 'ai_score', label: 'AI Score' },
    { key: 'estimated_cpm', label: 'Est. CPM' },
    { key: 'status', label: 'Status' },
    { key: 'profile_url', label: 'Profile URL' },
    { key: 'collected_at', label: 'Collected At', format: formatDateTime },
  ],

  contacts: [
    { key: 'display_name', label: 'KOL Name' },
    { key: 'username', label: 'Handle' },
    { key: 'platform', label: 'Platform' },
    { key: 'kol_email', label: 'Email' },
    { key: 'cooperation_type', label: 'Type' },
    { key: 'status', label: 'Email Status' },
    { key: 'contract_status', label: 'Contract' },
    { key: 'content_status', label: 'Content' },
    { key: 'content_url', label: 'Content URL' },
    { key: 'payment_amount', label: 'Payment' },
    { key: 'payment_status', label: 'Paid' },
    { key: 'sent_at', label: 'Sent At', format: formatDateTime },
    { key: 'reply_at', label: 'Replied At', format: formatDateTime },
  ],

  content: [
    { key: 'platform', label: 'Platform' },
    { key: 'content_title', label: 'Title' },
    { key: 'content_url', label: 'URL' },
    { key: 'publish_date', label: 'Published' },
    { key: 'views', label: 'Views' },
    { key: 'likes', label: 'Likes' },
    { key: 'comments', label: 'Comments' },
    { key: 'shares', label: 'Shares' },
    { key: 'kol_name', label: 'Creator' },
  ],
};

module.exports = { toCsv, formatDateTime, COLUMNS };
