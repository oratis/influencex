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
    authUrl: 'https://www.linkedin.com/oauth/v2/authorization',
    tokenUrl: 'https://www.linkedin.com/oauth/v2/accessToken',
    userInfoUrl: 'https://api.linkedin.com/v2/userinfo',
    scope: 'openid profile w_member_social email',
    usesPKCE: false,
    clientIdEnv: 'LINKEDIN_CLIENT_ID',
    clientSecretEnv: 'LINKEDIN_CLIENT_SECRET',
  },
};

function getProvider(name) {
  return PROVIDERS[name] || null;
}

function isConfigured(name) {
  const p = PROVIDERS[name];
  if (!p) return false;
  return !!(process.env[p.clientIdEnv] && process.env[p.clientSecretEnv]);
}

function listProviders() {
  return Object.values(PROVIDERS).map(p => ({
    id: p.id,
    label: p.label,
    configured: isConfigured(p.id),
    scope: p.scope,
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

  const res = await fetch(p.tokenUrl, { method: 'POST', headers, body: body.toString() });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${p.label} token exchange ${res.status}: ${text.slice(0, 300)}`);
  }
  const data = await res.json();

  // Fetch account info
  let accountName = null, accountId = null;
  try {
    const userRes = await fetch(p.userInfoUrl, {
      headers: { 'Authorization': `Bearer ${data.access_token}` },
    });
    if (userRes.ok) {
      const user = await userRes.json();
      if (providerName === 'twitter') {
        accountId = user.data?.id;
        accountName = user.data?.username || user.data?.name;
      } else if (providerName === 'linkedin') {
        accountId = user.sub;
        accountName = user.name || user.email;
      }
    }
  } catch { /* ok, optional */ }

  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token || null,
    expires_in: data.expires_in || null,
    scope: data.scope || p.scope,
    token_type: data.token_type || 'Bearer',
    account_name: accountName,
    account_id: accountId,
  };
}

/**
 * Post content directly to the platform using a stored access token.
 * Returns { success, platform_post_id?, url?, error? }.
 */
async function publishDirect(providerName, accessToken, { text, imageUrl }) {
  if (providerName === 'twitter') {
    return publishTwitter(accessToken, { text });
  }
  if (providerName === 'linkedin') {
    return publishLinkedIn(accessToken, { text });
  }
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

module.exports = {
  PROVIDERS,
  getProvider,
  isConfigured,
  listProviders,
  buildAuthorizeUrl,
  exchangeCodeForToken,
  publishDirect,
};
