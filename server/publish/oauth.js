/**
 * OAuth 2.0 flows for direct-posting platforms.
 *
 * Currently scaffolded:
 *   - twitter (X) — OAuth 2.0 with PKCE. Requires TWITTER_CLIENT_ID and
 *     TWITTER_CLIENT_SECRET env vars. Register an app at
 *     https://developer.twitter.com and enable OAuth 2.0 with scopes:
 *     tweet.read tweet.write users.read offline.access
 *   - linkedin — OAuth 2.0. Requires LINKEDIN_CLIENT_ID and LINKEDIN_CLIENT_SECRET.
 *     Register at https://www.linkedin.com/developers/ with scopes:
 *     openid profile w_member_social email
 *
 * Without env vars configured, the init endpoint returns 400 with a
 * human-readable reason.
 */

const crypto = require('crypto');
const fetch = require('../proxy-fetch');

const CALLBACK_BASE = process.env.OAUTH_CALLBACK_BASE || 'https://influencexes.com';

const PROVIDERS = {
  twitter: {
    id: 'twitter',
    label: 'X (Twitter)',
    kind: 'oauth',
    authUrl: 'https://twitter.com/i/oauth2/authorize',
    tokenUrl: 'https://api.twitter.com/2/oauth2/token',
    userInfoUrl: 'https://api.twitter.com/2/users/me',
    scope: 'tweet.read tweet.write users.read offline.access',
    usesPKCE: true,
    clientIdEnv: 'TWITTER_CLIENT_ID',
    clientSecretEnv: 'TWITTER_CLIENT_SECRET',
  },
  linkedin: {
    id: 'linkedin',
    label: 'LinkedIn',
    kind: 'oauth',
    authUrl: 'https://www.linkedin.com/oauth/v2/authorization',
    tokenUrl: 'https://www.linkedin.com/oauth/v2/accessToken',
    userInfoUrl: 'https://api.linkedin.com/v2/userinfo',
    scope: 'openid profile w_member_social email',
    usesPKCE: false,
    clientIdEnv: 'LINKEDIN_CLIENT_ID',
    clientSecretEnv: 'LINKEDIN_CLIENT_SECRET',
  },
  instagram: {
    id: 'instagram',
    label: 'Instagram (Business)',
    kind: 'oauth',
    // Meta Graph uses Facebook Login; the IG Business account must be linked
    // to a Facebook Page the user admins.
    authUrl: 'https://www.facebook.com/v18.0/dialog/oauth',
    tokenUrl: 'https://graph.facebook.com/v18.0/oauth/access_token',
    // Resolved per-account via /me/accounts → page → instagram_business_account.
    userInfoUrl: null,
    scope: 'instagram_basic,instagram_content_publish,pages_show_list,pages_read_engagement',
    usesPKCE: false,
    clientIdEnv: 'META_APP_ID',
    clientSecretEnv: 'META_APP_SECRET',
  },
  youtube: {
    id: 'youtube',
    label: 'YouTube',
    kind: 'oauth',
    // Google OAuth 2.0. Separate client from Google SSO (GOOGLE_OAUTH_*) because
    // YouTube requires Data API v3 + YouTube Analytics API enabled on the GCP
    // project and the scopes below, which we don't want to grant for plain SSO.
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    // channels.list(mine=true) returns the connected channel's id + snippet.title.
    userInfoUrl: 'https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true',
    scope: 'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly https://www.googleapis.com/auth/yt-analytics.readonly',
    usesPKCE: true,
    clientIdEnv: 'YOUTUBE_CLIENT_ID',
    clientSecretEnv: 'YOUTUBE_CLIENT_SECRET',
    // Google only issues a refresh_token when access_type=offline + prompt=consent.
    extraAuthParams: { access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true' },
  },
  // --- API-key-based blog platforms. No OAuth dance — the user provides
  // credentials directly and we store them in platform_connections. The
  // "configured" flag is always true; configuration happens per-user.
  medium: {
    id: 'medium',
    label: 'Medium',
    kind: 'api_key',
    fields: [
      { name: 'integration_token', label: 'Integration Token', type: 'password',
        help: 'Create at https://medium.com/me/settings → Integration tokens' },
    ],
  },
  ghost: {
    id: 'ghost',
    label: 'Ghost',
    kind: 'api_key',
    fields: [
      { name: 'site_url', label: 'Ghost Site URL', type: 'text',
        help: 'e.g. https://yoursite.ghost.io — no trailing slash' },
      { name: 'admin_api_key', label: 'Admin API Key', type: 'password',
        help: 'Ghost Admin → Integrations → Add custom integration' },
    ],
  },
  wordpress: {
    id: 'wordpress',
    label: 'WordPress',
    kind: 'api_key',
    fields: [
      { name: 'site_url', label: 'Site URL', type: 'text',
        help: 'e.g. https://yoursite.com — self-hosted WP with REST API enabled' },
      { name: 'username', label: 'Username', type: 'text' },
      { name: 'application_password', label: 'Application Password', type: 'password',
        help: 'WP Admin → Users → Profile → Application Passwords' },
    ],
  },
};

function getProvider(name) {
  return PROVIDERS[name] || null;
}

function isConfigured(name) {
  const p = PROVIDERS[name];
  if (!p) return false;
  if (p.kind === 'api_key') return true; // User provides creds directly
  return !!(process.env[p.clientIdEnv] && process.env[p.clientSecretEnv]);
}

function listProviders() {
  return Object.values(PROVIDERS).map(p => ({
    id: p.id,
    label: p.label,
    kind: p.kind || 'oauth',
    configured: isConfigured(p.id),
    scope: p.scope || null,
    fields: p.fields || null,
  }));
}

function base64urlEncode(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function generatePKCE() {
  const verifier = base64urlEncode(crypto.randomBytes(32));
  const challenge = base64urlEncode(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

/**
 * Build the authorization URL the user is redirected to.
 * Returns { url, state, codeVerifier } — caller persists state+verifier and
 * looks them up on callback to exchange the code.
 */
function buildAuthorizeUrl(providerName, { workspaceId, userId, redirectUri }) {
  const p = getProvider(providerName);
  if (!p) throw new Error(`Unknown provider: ${providerName}`);
  if (!isConfigured(providerName)) {
    throw new Error(`${p.label} not configured (missing ${p.clientIdEnv} / ${p.clientSecretEnv})`);
  }

  const state = crypto.randomBytes(16).toString('hex');
  const redirect = redirectUri || `${CALLBACK_BASE}/api/publish/oauth/${p.id}/callback`;
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: process.env[p.clientIdEnv],
    redirect_uri: redirect,
    scope: p.scope,
    state,
  });

  let codeVerifier = null;
  if (p.usesPKCE) {
    const { verifier, challenge } = generatePKCE();
    codeVerifier = verifier;
    params.set('code_challenge', challenge);
    params.set('code_challenge_method', 'S256');
  }

  if (p.extraAuthParams) {
    for (const [k, v] of Object.entries(p.extraAuthParams)) params.set(k, v);
  }

  return {
    url: `${p.authUrl}?${params.toString()}`,
    state,
    codeVerifier,
    redirect,
  };
}

/**
 * Exchange an authorization code for an access token.
 */
async function exchangeCodeForToken(providerName, { code, redirectUri, codeVerifier }) {
  const p = getProvider(providerName);
  if (!p) throw new Error(`Unknown provider: ${providerName}`);

  const clientId = process.env[p.clientIdEnv];
  const clientSecret = process.env[p.clientSecretEnv];

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
  });
  if (p.usesPKCE && codeVerifier) {
    body.set('code_verifier', codeVerifier);
  }

  const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
  if (providerName === 'twitter') {
    // Twitter uses Basic auth for confidential clients
    const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    headers['Authorization'] = `Basic ${basic}`;
  } else {
    body.set('client_secret', clientSecret);
  }

  // Meta's token endpoint accepts GET with query params; POST also works but
  // some SDKs report quirks. We stay with POST form-encoded for consistency.
  const res = await fetch(p.tokenUrl, { method: 'POST', headers, body: body.toString() });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${p.label} token exchange ${res.status}: ${text.slice(0, 300)}`);
  }
  const data = await res.json();

  // Fetch account info
  let accountName = null, accountId = null;
  let accessToken = data.access_token;
  let expiresIn = data.expires_in || null;
  let metadata = null;

  if (providerName === 'instagram') {
    // Meta flow: short-lived user token → long-lived user token → pick Page →
    // read its `instagram_business_account`. We store the Page access token
    // (long-lived) and the IG Business user id.
    try {
      const llRes = await fetch(
        `https://graph.facebook.com/v18.0/oauth/access_token?grant_type=fb_exchange_token&client_id=${encodeURIComponent(clientId)}&client_secret=${encodeURIComponent(clientSecret)}&fb_exchange_token=${encodeURIComponent(data.access_token)}`
      );
      if (llRes.ok) {
        const ll = await llRes.json();
        if (ll.access_token) { accessToken = ll.access_token; expiresIn = ll.expires_in || expiresIn; }
      }
      const pagesRes = await fetch(
        `https://graph.facebook.com/v18.0/me/accounts?fields=id,name,access_token,instagram_business_account&access_token=${encodeURIComponent(accessToken)}`
      );
      if (pagesRes.ok) {
        const pages = await pagesRes.json();
        const linked = (pages.data || []).find(pg => pg.instagram_business_account?.id);
        if (linked) {
          accessToken = linked.access_token || accessToken;
          accountId = linked.instagram_business_account.id;
          metadata = { page_id: linked.id, page_name: linked.name, ig_user_id: accountId };
          // Resolve IG username for display
          try {
            const igRes = await fetch(
              `https://graph.facebook.com/v18.0/${accountId}?fields=username&access_token=${encodeURIComponent(accessToken)}`
            );
            if (igRes.ok) {
              const ig = await igRes.json();
              accountName = ig.username ? `@${ig.username}` : linked.name;
            } else {
              accountName = linked.name;
            }
          } catch { accountName = linked.name; }
        }
      }
    } catch { /* ok, optional */ }
  } else if (p.userInfoUrl) {
    try {
      const userRes = await fetch(p.userInfoUrl, {
        headers: { 'Authorization': `Bearer ${accessToken}` },
      });
      if (userRes.ok) {
        const user = await userRes.json();
        if (providerName === 'twitter') {
          accountId = user.data?.id;
          accountName = user.data?.username || user.data?.name;
        } else if (providerName === 'linkedin') {
          accountId = user.sub;
          accountName = user.name || user.email;
        } else if (providerName === 'youtube') {
          const channel = (user.items || [])[0];
          if (channel) {
            accountId = channel.id;
            accountName = channel.snippet?.title || channel.snippet?.customUrl || null;
            metadata = {
              channel_id: channel.id,
              channel_handle: channel.snippet?.customUrl || null,
              country: channel.snippet?.country || null,
            };
          }
        }
      }
    } catch { /* ok, optional */ }
  }

  return {
    access_token: accessToken,
    refresh_token: data.refresh_token || null,
    expires_in: expiresIn,
    scope: data.scope || p.scope,
    token_type: data.token_type || 'Bearer',
    account_name: accountName,
    account_id: accountId,
    metadata,
  };
}

/**
 * Post content directly to the platform using a stored access token.
 * Returns { success, platform_post_id?, url?, error? }.
 */
async function publishDirect(providerName, credentials, payload) {
  const { text, title, imageUrl, tags, accountId } = payload || {};
  // For OAuth providers, `credentials` is an access token (string).
  // For API-key providers, `credentials` is a JSON object with the fields
  // captured at connection time (decoded from platform_connections.metadata).
  if (providerName === 'twitter')   return publishTwitter(credentials, { text });
  if (providerName === 'linkedin')  return publishLinkedIn(credentials, { text });
  if (providerName === 'instagram') return publishInstagram(credentials, { text, imageUrl, igUserId: accountId });
  if (providerName === 'youtube')   return publishYouTube(credentials, { title, text, videoUrl: payload?.video_url || payload?.videoUrl, tags, privacyStatus: payload?.privacy_status || payload?.privacyStatus });
  if (providerName === 'medium')    return publishMedium(credentials, { text, title, tags });
  if (providerName === 'ghost')     return publishGhost(credentials, { text, title, tags });
  if (providerName === 'wordpress') return publishWordPress(credentials, { text, title, tags });
  return { success: false, error: `Direct publishing not implemented for ${providerName}` };
}

async function publishTwitter(accessToken, { text }) {
  const res = await fetch('https://api.twitter.com/2/tweets', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${accessToken}` },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    return { success: false, error: `Twitter API ${res.status}: ${errText.slice(0, 300)}` };
  }
  const data = await res.json();
  return {
    success: true,
    platform_post_id: data.data?.id,
    url: data.data?.id ? `https://twitter.com/i/status/${data.data.id}` : null,
  };
}

async function publishLinkedIn(accessToken, { text }) {
  // LinkedIn's /v2/ugcPosts requires the user's urn:li:person id; we need to
  // fetch it from /v2/userinfo since we didn't store it. Minimal impl:
  const meRes = await fetch('https://api.linkedin.com/v2/userinfo', {
    headers: { 'Authorization': `Bearer ${accessToken}` },
  });
  if (!meRes.ok) return { success: false, error: 'Failed to resolve LinkedIn user id' };
  const me = await meRes.json();
  const authorUrn = `urn:li:person:${me.sub}`;

  const res = await fetch('https://api.linkedin.com/v2/ugcPosts', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${accessToken}`,
      'X-Restli-Protocol-Version': '2.0.0',
    },
    body: JSON.stringify({
      author: authorUrn,
      lifecycleState: 'PUBLISHED',
      specificContent: {
        'com.linkedin.ugc.ShareContent': {
          shareCommentary: { text },
          shareMediaCategory: 'NONE',
        },
      },
      visibility: { 'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC' },
    }),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    return { success: false, error: `LinkedIn API ${res.status}: ${errText.slice(0, 300)}` };
  }
  const data = await res.json();
  return {
    success: true,
    platform_post_id: data.id,
  };
}

// --- Instagram (Meta Graph API) -----------------------------------------

/**
 * Instagram Business publishing via Meta Graph API. Two-step flow:
 *   1) POST /{ig-user-id}/media with image_url + caption → returns creation_id
 *   2) POST /{ig-user-id}/media_publish with creation_id  → returns post id
 *
 * Notes:
 *   - Requires a public `imageUrl` (Meta fetches it server-side). Captions-only
 *     (no image) are not supported by Instagram's Content Publishing API.
 *   - `accessToken` is the Page access token stored at connection time.
 *   - `igUserId` is the IG Business user id stored in platform_connections.account_id.
 */
async function publishInstagram(accessToken, { text, imageUrl, igUserId }) {
  if (!igUserId) return { success: false, error: 'Instagram connection missing ig_user_id (reconnect account)' };
  if (!imageUrl) return { success: false, error: 'Instagram requires a public image_url — text-only posts are not supported' };

  // Step 1: create media container
  const createParams = new URLSearchParams({
    image_url: imageUrl,
    caption: text || '',
    access_token: accessToken,
  });
  const createRes = await fetch(
    `https://graph.facebook.com/v18.0/${encodeURIComponent(igUserId)}/media`,
    { method: 'POST', body: createParams }
  );
  if (!createRes.ok) {
    const errText = await createRes.text().catch(() => '');
    return { success: false, error: `Instagram create ${createRes.status}: ${errText.slice(0, 300)}` };
  }
  const createData = await createRes.json();
  const creationId = createData.id;
  if (!creationId) return { success: false, error: 'Instagram create returned no id' };

  // Step 2: publish the container
  const publishParams = new URLSearchParams({
    creation_id: creationId,
    access_token: accessToken,
  });
  const pubRes = await fetch(
    `https://graph.facebook.com/v18.0/${encodeURIComponent(igUserId)}/media_publish`,
    { method: 'POST', body: publishParams }
  );
  if (!pubRes.ok) {
    const errText = await pubRes.text().catch(() => '');
    return { success: false, error: `Instagram publish ${pubRes.status}: ${errText.slice(0, 300)}` };
  }
  const pubData = await pubRes.json();
  return {
    success: true,
    platform_post_id: pubData.id,
    url: pubData.id ? `https://www.instagram.com/p/${pubData.id}/` : null,
  };
}

// --- YouTube (Data API v3 resumable upload) -----------------------------

/**
 * YouTube video publish via resumable upload.
 *
 *   1. Fetch the video from the caller-provided public URL (a Cloud Storage
 *      signed URL, S3, etc). The agent-runtime deliverables all resolve to
 *      an HTTP URL so we keep the upload path URL-based for symmetry.
 *   2. Initiate a resumable session: POST /upload/youtube/v3/videos?uploadType=resumable
 *      with the snippet+status JSON and Content-Length hints. Google returns
 *      a Location header (the upload URL).
 *   3. PUT the video bytes to the upload URL. On 200/201 we parse the body
 *      for the video id.
 *
 * Scopes required on the stored token: https://www.googleapis.com/auth/youtube.upload
 * Privacy defaults to `private` so the user can verify before going public.
 */
async function publishYouTube(accessToken, { title, text, videoUrl, tags, privacyStatus }) {
  if (!videoUrl) {
    return {
      success: false,
      error: 'YouTube publishing requires a public video_url (direct MP4 / WebM). Text-only posts are not supported.',
    };
  }

  // 1. Fetch the video file to upload.
  const videoRes = await fetch(videoUrl);
  if (!videoRes.ok) {
    return { success: false, error: `Failed to fetch video_url (${videoRes.status})` };
  }
  const contentType = videoRes.headers.get('content-type') || 'video/*';
  const contentLength = videoRes.headers.get('content-length');
  const videoBuf = Buffer.from(await videoRes.arrayBuffer());

  const metadata = {
    snippet: {
      title: (title || (text || '').split('\n')[0] || 'Untitled').slice(0, 100),
      description: text || '',
      tags: Array.isArray(tags) ? tags.slice(0, 15) : undefined,
      categoryId: '22', // "People & Blogs" — safe default
    },
    status: {
      privacyStatus: privacyStatus || 'private',
      selfDeclaredMadeForKids: false,
    },
  };

  // 2. Initiate resumable upload session.
  const initRes = await fetch(
    'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status',
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': contentType,
        ...(contentLength ? { 'X-Upload-Content-Length': contentLength } : {}),
      },
      body: JSON.stringify(metadata),
    }
  );
  if (!initRes.ok) {
    const errText = await initRes.text().catch(() => '');
    return { success: false, error: `YouTube init ${initRes.status}: ${errText.slice(0, 300)}` };
  }
  const uploadUrl = initRes.headers.get('location');
  if (!uploadUrl) return { success: false, error: 'YouTube did not return an upload Location header' };

  // 3. PUT the video bytes.
  const uploadRes = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': contentType, 'Content-Length': String(videoBuf.length) },
    body: videoBuf,
  });
  if (!uploadRes.ok) {
    const errText = await uploadRes.text().catch(() => '');
    return { success: false, error: `YouTube upload ${uploadRes.status}: ${errText.slice(0, 300)}` };
  }
  const data = await uploadRes.json().catch(() => ({}));
  const videoId = data.id;
  return {
    success: true,
    platform_post_id: videoId || null,
    url: videoId ? `https://www.youtube.com/watch?v=${videoId}` : null,
  };
}

// --- Blog platforms ------------------------------------------------------

async function publishMedium(creds, { text, title, tags }) {
  const token = typeof creds === 'string' ? creds : creds.integration_token;
  if (!token) return { success: false, error: 'Medium integration_token missing' };
  // Resolve user id
  const meRes = await fetch('https://api.medium.com/v1/me', {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!meRes.ok) return { success: false, error: `Medium /me ${meRes.status}` };
  const me = await meRes.json();
  const userId = me?.data?.id;
  if (!userId) return { success: false, error: 'Medium could not resolve user id' };

  const res = await fetch(`https://api.medium.com/v1/users/${userId}/posts`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: title || (text || '').split('\n')[0].slice(0, 100) || 'Untitled',
      contentFormat: 'markdown',
      content: text,
      tags: Array.isArray(tags) ? tags.slice(0, 5) : [],
      publishStatus: 'public',
    }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    return { success: false, error: `Medium API ${res.status}: ${t.slice(0, 300)}` };
  }
  const data = await res.json();
  return { success: true, platform_post_id: data.data?.id, url: data.data?.url };
}

async function publishGhost(creds, { text, title, tags }) {
  const siteUrl = (creds.site_url || '').replace(/\/$/, '');
  const adminKey = creds.admin_api_key;
  if (!siteUrl || !adminKey) return { success: false, error: 'Ghost site_url and admin_api_key required' };

  // Ghost admin key format: "<id>:<secret>". Build a short-lived JWT.
  const [keyid, secret] = adminKey.split(':');
  if (!keyid || !secret) return { success: false, error: 'Invalid Ghost admin key format (expected id:secret)' };
  const header = base64urlEncode(Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT', kid: keyid })));
  const now = Math.floor(Date.now() / 1000);
  const payload = base64urlEncode(Buffer.from(JSON.stringify({ iat: now, exp: now + 300, aud: '/admin/' })));
  const sigBase = `${header}.${payload}`;
  const sig = base64urlEncode(
    crypto.createHmac('sha256', Buffer.from(secret, 'hex')).update(sigBase).digest()
  );
  const token = `${sigBase}.${sig}`;

  const endpoint = `${siteUrl}/ghost/api/admin/posts/?source=html`;
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Ghost ${token}` },
    body: JSON.stringify({
      posts: [{
        title: title || (text || '').split('\n')[0].slice(0, 100) || 'Untitled',
        html: markdownToHtml(text || ''),
        status: 'published',
        tags: (Array.isArray(tags) ? tags : []).map(t => ({ name: t })),
      }],
    }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    return { success: false, error: `Ghost API ${res.status}: ${t.slice(0, 300)}` };
  }
  const data = await res.json();
  const post = data.posts?.[0];
  return { success: true, platform_post_id: post?.id, url: post?.url };
}

async function publishWordPress(creds, { text, title, tags }) {
  const siteUrl = (creds.site_url || '').replace(/\/$/, '');
  if (!siteUrl || !creds.username || !creds.application_password) {
    return { success: false, error: 'WordPress site_url, username and application_password required' };
  }
  const basic = Buffer.from(`${creds.username}:${creds.application_password}`).toString('base64');
  const endpoint = `${siteUrl}/wp-json/wp/v2/posts`;
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Basic ${basic}` },
    body: JSON.stringify({
      title: title || (text || '').split('\n')[0].slice(0, 100) || 'Untitled',
      content: markdownToHtml(text || ''),
      status: 'publish',
    }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    return { success: false, error: `WordPress API ${res.status}: ${t.slice(0, 300)}` };
  }
  const data = await res.json();
  return { success: true, platform_post_id: String(data.id), url: data.link };
}

// Minimal markdown → HTML for blog post bodies. Not a full parser — covers
// the cases the content-text agent actually produces.
function markdownToHtml(md) {
  if (!md) return '';
  let html = md;
  // Code fences first so we don't process their content.
  html = html.replace(/```([^\n]*)\n([\s\S]*?)```/g, (_, lang, code) =>
    `<pre><code class="language-${(lang || '').trim()}">${escapeHtml(code)}</code></pre>`);
  // Inline code
  html = html.replace(/`([^`]+)`/g, (_, c) => `<code>${escapeHtml(c)}</code>`);
  // Headings
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>')
             .replace(/^## (.+)$/gm, '<h2>$1</h2>')
             .replace(/^# (.+)$/gm, '<h1>$1</h1>');
  // Bold / italic
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
             .replace(/\*([^*]+)\*/g, '<em>$1</em>');
  // Links
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  // Paragraphs: split on blank lines
  html = html.split(/\n\n+/).map(block => {
    if (/^<(h\d|pre|ul|ol|blockquote)/.test(block)) return block;
    return `<p>${block.replace(/\n/g, '<br>')}</p>`;
  }).join('\n');
  return html;
}
function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

module.exports = {
  PROVIDERS,
  getProvider,
  isConfigured,
  listProviders,
  buildAuthorizeUrl,
  exchangeCodeForToken,
  publishDirect,
};
