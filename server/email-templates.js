/**
 * Email template system with variable substitution.
 *
 * Variables use {{variable_name}} syntax. Missing variables are replaced with
 * an empty string (warning logged). Templates can be stored in the DB or
 * loaded from the built-in defaults below.
 *
 * Supported variables (for outreach templates):
 *   {{kol_name}}         - Display name or @handle
 *   {{kol_handle}}       - Username / handle without @
 *   {{platform}}         - youtube / tiktok / instagram
 *   {{followers}}        - Formatted follower count (e.g. "12.5K")
 *   {{category}}         - Detected content category
 *   {{campaign_name}}    - Campaign display name
 *   {{sender_name}}      - Sender's name (from env or per-call override)
 *   {{product_name}}     - Product/brand name
 *   {{cooperation_type}} - "affiliate" or "paid"
 *   {{price_quote}}      - Offered price, if any
 */

const DEFAULT_TEMPLATES = {
  'outreach-affiliate-en': {
    id: 'outreach-affiliate-en',
    name: 'Affiliate Outreach (English)',
    language: 'en',
    cooperation_type: 'affiliate',
    subject: 'Partnership opportunity with {{product_name}} - {{kol_name}}',
    body: `Hi {{kol_name}},

I came across your {{platform}} channel and loved your content on {{category}}. With {{followers}} followers, you're exactly the kind of creator we'd love to work with.

I'm {{sender_name}} from {{product_name}}. We're launching an affiliate program for {{category}} creators and would love to invite you. You'd get:

• A unique affiliate link with performance tracking
• Commission on every conversion you drive
• Early access to new features
• Flexible content direction — you know your audience best

If this sounds interesting, just reply and I'll send over the details.

Best,
{{sender_name}}`,
  },

  'outreach-paid-en': {
    id: 'outreach-paid-en',
    name: 'Paid Collab Outreach (English)',
    language: 'en',
    cooperation_type: 'paid',
    subject: 'Paid collab with {{product_name}} - {{kol_name}}',
    body: `Hi {{kol_name}},

I'm {{sender_name}} from {{product_name}}. We've been following your {{platform}} content on {{category}} and think there's a great fit for a paid partnership.

Our initial offer is {{price_quote}} for a dedicated piece of content. We're flexible on format and timeline — you know what works best for your audience.

Happy to share more details, talking points, and examples. Let me know if you'd like to chat.

Best,
{{sender_name}}`,
  },

  'follow-up-en': {
    id: 'follow-up-en',
    name: 'Follow-up (English)',
    language: 'en',
    cooperation_type: 'any',
    subject: 'Following up - {{product_name}} partnership',
    body: `Hi {{kol_name}},

Just wanted to circle back on my earlier note about a partnership with {{product_name}}. Totally understand if it's not the right fit — just wanted to make sure it didn't get lost in your inbox.

If there's interest, happy to jump on a quick call or send over more details. Otherwise no worries, and wishing you the best with your content!

Best,
{{sender_name}}`,
  },

  'outreach-affiliate-zh': {
    id: 'outreach-affiliate-zh',
    name: '分销合作 (中文)',
    language: 'zh',
    cooperation_type: 'affiliate',
    subject: '{{product_name}} x {{kol_name}} 合作邀约',
    body: `{{kol_name}} 你好，

我是 {{product_name}} 的 {{sender_name}}，看了你在 {{platform}} 上 {{category}} 相关的内容，非常喜欢！{{followers}} 的粉丝基础很符合我们的合作画像。

我们正在招募 {{category}} 方向的分销合作伙伴，提供：

• 专属推广链接 + 实时数据看板
• 转化按比例分成，上不封顶
• 优先体验新功能
• 自由的内容方向 — 你最懂你的观众

如果感兴趣，回复即可，我给你发详细合作方案。

Best,
{{sender_name}}`,
  },
};

/**
 * Substitute {{variables}} in a template string.
 * Missing variables are replaced with empty string.
 */
function renderTemplate(template, variables = {}) {
  if (!template) return '';
  return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    if (variables[key] === undefined || variables[key] === null) {
      return '';
    }
    return String(variables[key]);
  });
}

/**
 * Render a full email (subject + body) from a template.
 */
function renderEmail(templateId, variables = {}) {
  const template = DEFAULT_TEMPLATES[templateId];
  if (!template) {
    throw new Error(`Template not found: ${templateId}`);
  }

  return {
    templateId,
    templateName: template.name,
    subject: renderTemplate(template.subject, variables),
    body: renderTemplate(template.body, variables),
  };
}

/**
 * Suggest a template based on KOL attributes and cooperation type.
 */
function suggestTemplate({ cooperation_type = 'affiliate', language = 'en' } = {}) {
  const candidates = Object.values(DEFAULT_TEMPLATES).filter(t =>
    t.language === language &&
    (t.cooperation_type === cooperation_type || t.cooperation_type === 'any')
  );
  return candidates[0] || DEFAULT_TEMPLATES['outreach-affiliate-en'];
}

/**
 * List all available templates.
 */
function listTemplates() {
  return Object.values(DEFAULT_TEMPLATES).map(t => ({
    id: t.id,
    name: t.name,
    language: t.language,
    cooperation_type: t.cooperation_type,
    subject: t.subject,
  }));
}

/**
 * Format a number as a compact string (12500 -> "12.5K").
 */
function formatFollowers(n) {
  if (!n && n !== 0) return '';
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return String(n);
}

module.exports = {
  renderTemplate,
  renderEmail,
  suggestTemplate,
  listTemplates,
  formatFollowers,
  DEFAULT_TEMPLATES,
};
