/**
 * Feishu (Lark) integration for pulling real data
 *
 * Data sources:
 * 1. 记录已发布达人内容 (Published KOL Content Records)
 *    Spreadsheet: KApys1IPshRGSYtw3XvcDip0n2e / Sheet: d6ef2b
 *    Columns: 发布时间(date), 发布连接(url)
 *
 * 2. 整体注册曲线 (Registration Curve)
 *    Spreadsheet: MBZTsFIjbhB8qjtHwMRc8gRFnkD / Sheet: 550c58
 *    Wiki link: xinsuixing.feishu.cn/wiki/Jejzwgy4BiyjHYke2xYcxpi5nRf
 *    Columns: log_date, 总注册, PC注册, 安卓注册, iOS注册
 */

const fetch = require('./proxy-fetch');
const FEISHU_APP_ID = process.env.FEISHU_APP_ID;
const FEISHU_APP_SECRET = process.env.FEISHU_APP_SECRET;

// Published content spreadsheet
const CONTENT_SHEET_TOKEN = process.env.FEISHU_CONTENT_SHEET_TOKEN || 'KApys1IPshRGSYtw3XvcDip0n2e';
const CONTENT_SHEET_ID = process.env.FEISHU_CONTENT_SHEET_ID || 'd6ef2b';

// Registration data spreadsheet
const REG_SHEET_TOKEN = process.env.FEISHU_REG_SHEET_TOKEN || 'MBZTsFIjbhB8qjtHwMRc8gRFnkD';
const REG_SHEET_ID = process.env.FEISHU_REG_SHEET_ID || '550c58';

let cachedToken = null;
let tokenExpiry = 0;

function isConfigured() {
  return !!(FEISHU_APP_ID && FEISHU_APP_SECRET);
}

async function getTenantToken() {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;

  const res = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: FEISHU_APP_ID, app_secret: FEISHU_APP_SECRET }),
  });
  const data = await res.json();
  if (data.code !== 0) throw new Error(`Feishu auth failed: ${data.msg}`);

  cachedToken = data.tenant_access_token;
  tokenExpiry = Date.now() + (data.expire - 60) * 1000;
  return cachedToken;
}

/**
 * Convert Excel serial date number to YYYY-MM-DD string
 * Excel epoch: 1900-01-01 = serial 1, but uses 1899-12-30 as base for JS Date math
 */
function excelDateToString(serial) {
  if (typeof serial !== 'number' || serial < 1) return '';
  const d = new Date((serial - 25569) * 86400000);
  return d.toISOString().split('T')[0];
}

/**
 * Extract URL from cell value (can be string, or array of link objects)
 */
function extractUrl(cell) {
  if (!cell) return '';
  if (typeof cell === 'string') return cell;
  if (Array.isArray(cell) && cell[0]) {
    return cell[0].link || cell[0].text || '';
  }
  if (typeof cell === 'object' && cell.link) return cell.link;
  return '';
}

/**
 * Detect platform from URL
 */
function detectPlatform(url) {
  if (!url) return 'unknown';
  if (url.includes('tiktok.com')) return 'tiktok';
  if (url.includes('youtube.com') || url.includes('youtu.be')) return 'youtube';
  if (url.includes('instagram.com')) return 'instagram';
  return 'other';
}

/**
 * Fetch all published content records from the Feishu spreadsheet
 * Returns array of { publish_date, content_url, platform }
 */
async function fetchPublishedContent() {
  if (!isConfigured()) return { configured: false, data: [] };

  try {
    const token = await getTenantToken();

    // Get sheet meta to know how many rows
    const metaRes = await fetch(
      `https://open.feishu.cn/open-apis/sheets/v3/spreadsheets/${CONTENT_SHEET_TOKEN}/sheets/query`,
      { headers: { 'Authorization': `Bearer ${token}` } }
    );
    const metaData = await metaRes.json();
    if (metaData.code !== 0) throw new Error(`Sheet meta error: ${metaData.msg}`);

    const sheet = metaData.data?.sheets?.find(s => s.sheet_id === CONTENT_SHEET_ID);
    const rowCount = sheet?.grid_properties?.row_count || 200;

    // Read all data rows (skip header row 1)
    const range = `${CONTENT_SHEET_ID}!A2:B${rowCount}`;
    const dataRes = await fetch(
      `https://open.feishu.cn/open-apis/sheets/v2/spreadsheets/${CONTENT_SHEET_TOKEN}/values/${encodeURIComponent(range)}`,
      { headers: { 'Authorization': `Bearer ${token}` } }
    );
    const data = await dataRes.json();
    if (data.code !== 0) throw new Error(`Sheet data error: ${data.msg}`);

    const rows = data.data?.valueRange?.values || [];
    const results = [];

    for (const row of rows) {
      const dateSerial = row[0];
      const urlCell = row[1];
      const url = extractUrl(urlCell);
      if (!url) continue;

      results.push({
        publish_date: excelDateToString(dateSerial),
        content_url: url,
        platform: detectPlatform(url),
      });
    }

    return {
      configured: true,
      data: results,
      total: results.length,
      source: 'feishu_spreadsheet',
      sheet_title: '记录已发布达人内容',
    };
  } catch (err) {
    console.error('Feishu fetchPublishedContent error:', err.message);
    return { configured: true, data: [], error: err.message };
  }
}

/**
 * Get summary stats of published content
 */
async function getContentSummary() {
  const result = await fetchPublishedContent();
  if (!result.configured || result.error) return result;

  const byPlatform = {};
  const byDate = {};

  for (const item of result.data) {
    byPlatform[item.platform] = (byPlatform[item.platform] || 0) + 1;
    if (item.publish_date) {
      byDate[item.publish_date] = (byDate[item.publish_date] || 0) + 1;
    }
  }

  return {
    configured: true,
    total: result.data.length,
    by_platform: byPlatform,
    by_date: byDate,
    date_range: {
      earliest: result.data.length > 0 ? result.data[result.data.length - 1].publish_date : null,
      latest: result.data.length > 0 ? result.data[0].publish_date : null,
    },
  };
}

/**
 * Fetch registration data from Feishu spreadsheet (整体注册曲线)
 * Uses valueRenderOption=ToString to resolve formula cells
 * Returns array of { date, total, pc, android, ios }
 */
async function fetchRegistrationData() {
  if (!isConfigured()) return { configured: false, data: [] };

  try {
    const token = await getTenantToken();

    // Get sheet meta
    const metaRes = await fetch(
      `https://open.feishu.cn/open-apis/sheets/v3/spreadsheets/${REG_SHEET_TOKEN}/sheets/query`,
      { headers: { 'Authorization': `Bearer ${token}` } }
    );
    const metaData = await metaRes.json();
    if (metaData.code !== 0) throw new Error(`Reg sheet meta error: ${metaData.msg}`);

    const sheet = metaData.data?.sheets?.find(s => s.sheet_id === REG_SHEET_ID);
    const rowCount = sheet?.grid_properties?.row_count || 200;

    // Read all data (skip header) — use valueRenderOption=ToString to resolve formulas
    const range = `${REG_SHEET_ID}!A2:E${rowCount}`;
    const dataRes = await fetch(
      `https://open.feishu.cn/open-apis/sheets/v2/spreadsheets/${REG_SHEET_TOKEN}/values/${encodeURIComponent(range)}?valueRenderOption=ToString`,
      { headers: { 'Authorization': `Bearer ${token}` } }
    );
    const data = await dataRes.json();
    if (data.code !== 0) throw new Error(`Reg sheet data error: ${data.msg}`);

    const rows = data.data?.valueRange?.values || [];
    const results = [];

    for (const row of rows) {
      const dateVal = row[0];
      if (!dateVal) continue;

      // With ToString, dates come as strings; without, as serial numbers
      let date;
      if (typeof dateVal === 'number') {
        date = excelDateToString(dateVal);
      } else if (typeof dateVal === 'string') {
        // Try parsing as date string (may be "2026/04/01" or "2026-04-01" etc.)
        const d = new Date(dateVal);
        date = !isNaN(d.getTime()) ? d.toISOString().split('T')[0] : dateVal;
      } else {
        continue;
      }

      const pc = parseInt(row[2]) || 0;
      const android = parseInt(row[3]) || 0;
      const ios = parseInt(row[4]) || 0;
      // Total: use the cell value if numeric, otherwise compute from sub-columns
      let total = parseInt(row[1]);
      if (isNaN(total)) total = pc + android + ios;

      results.push({ date, total, pc, android, ios });
    }

    return {
      configured: true,
      data: results,
      total: results.length,
      source: 'feishu_spreadsheet',
      sheet_title: '整体注册曲线',
    };
  } catch (err) {
    console.error('Feishu fetchRegistrationData error:', err.message);
    return { configured: true, data: [], error: err.message };
  }
}

/**
 * Sync all data
 */
async function syncAllData() {
  try {
    const [content, registration] = await Promise.all([
      fetchPublishedContent().catch(e => ({ configured: false, error: e.message, data: [] })),
      fetchRegistrationData().catch(e => ({ configured: false, error: e.message, data: [] })),
    ]);
    return {
      success: true,
      tables: {
        publishedContent: {
          count: content.data?.length || 0,
          configured: content.configured,
          error: content.error,
        },
        registration: {
          count: registration.data?.length || 0,
          configured: registration.configured,
          error: registration.error,
        },
      },
      raw: { content, registration },
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

module.exports = {
  isConfigured,
  fetchPublishedContent,
  fetchRegistrationData,
  getContentSummary,
  syncAllData,
};
