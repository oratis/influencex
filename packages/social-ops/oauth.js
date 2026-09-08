'use strict';

/**
 * Pure OAuth helpers for the platforms that authorise through a consent page.
 *
 * Nothing here reads process.env or a database: client id / secret / redirect
 * URI come in as arguments, tokens go back out as return values, and the HOST
 * owns storage, encryption and state persistence. That is the whole point of
 * the split — this package can be published and audited without ever having
 * seen a credential.
 *
 * The consent page itself is always opened by a HUMAN (the account holder).
 * There is no helper here for driving a login form and there never will be.
 */

const crypto = require('crypto');
const { resolveDeps, readJson, readErrorText } = require('./result');

const PROVIDERS = Object.freeze({
  x: {
    id: 'x',
    authUrl: 'https://x.com/i/oauth2/authorize',
    tokenUrl: 'https://api.x.com/2/oauth2/token',
    userInfoUrl: 'https://api.x.com/2/users/me',
    defaultScope: 'tweet.read tweet.write users.read offline.access media.write',
    usesPKCE: true,
    clientIdParam: 'client_id',
    tokenAuth: 'basic', // confidential client: Basic client_id:secret on the token call
    endpointsVerified: true,
  },
  instagram: {
    id: 'instagram',
    // Meta Graph via Facebook Login; the IG professional account must be
    // linked to a Facebook Page the user admins.
    authUrl: 'https://www.facebook.com/v21.0/dialog/oauth',
    tokenUrl: 'https://graph.facebook.com/v21.0/oauth/access_token',
    userInfoUrl: null,
    defaultScope: 'instagram_basic,instagram_content_publish,instagram_manage_insights,pages_show_list,pages_read_engagement',
    usesPKCE: false,
    clientIdParam: 'client_id',
    tokenAuth: 'body',
    endpointsVerified: true,
  },
  youtube: {
    id: 'youtube',
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    userInfoUrl: 'https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true',
    defaultScope: 'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly https://www.googleapis.com/auth/yt-analytics.readonly',
    usesPKCE: true,
    clientIdParam: 'client_id',
    tokenAuth: 'body',
    // Google only issues a refresh_token with access_type=offline + prompt=consent.
    extraAuthParams: { access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true' },
    endpointsVerified: true,
  },
  tiktok: {
    id: 'tiktok',
    authUrl: 'https://www.tiktok.com/v2/auth/authorize/',
    tokenUrl: 'https://open.tiktokapis.com/v2/oauth/token/',
    userInfoUrl: 'https://open.tiktokapis.com/v2/user/info/?fields=open_id,union_id,avatar_url,display_name,username',
    defaultScope: 'user.info.basic,video.upload,video.publish,video.list',
    usesPKCE: true,
    clientIdParam: 'client_key', // TikTok's name for client_id
    tokenAuth: 'body',
    endpointsVerified: true,
  },
  reddit: {
    id: 'reddit',
    authUrl: 'https://www.reddit.com/api/v1/authorize',
    tokenUrl: 'https://www.reddit.com/api/v1/access_token',
    userInfoUrl: 'https://oauth.reddit.com/api/v1/me',
    defaultScope: 'identity submit read flair',
    usesPKCE: false,
    clientIdParam: 'client_id',
    tokenAuth: 'basic',
    extraAuthParams: { duration: 'permanent' },
    requiresUserAgent: true,
    endpointsVerified: true,
  },
  douyin: {
    id: 'douyin',
    authUrl: 'https://open.douyin.com/platform/oauth/connect/',
    tokenUrl: 'https://open.douyin.com/oauth/access_token/',
    refreshUrl: 'https://open.douyin.com/oauth/refresh_token/',
    userInfoUrl: null, // open_id comes back with the token
    defaultScope: 'user_info,video.create,video.data',
    usesPKCE: false,
    clientIdParam: 'client_key',
    tokenAuth: 'body',
    // 抖音 wraps the payload: { data: { access_token, open_id, ... }, message }
    tokenEnvelope: 'data',
    endpointsVerified: false,
  },
  kuaishou: {
    id: 'kuaishou',
    authUrl: 'https://open.kuaishou.com/oauth2/connect',
    tokenUrl: 'https://open.kuaishou.com/oauth2/access_token',
    refreshUrl: 'https://open.kuaishou.com/oauth2/refresh_token',
    userInfoUrl: null, // open_id comes back with the token
    defaultScope: 'user_info,user_video_publish,user_video_info',
    usesPKCE: false,
    clientIdParam: 'app_id',
    clientSecretParam: 'app_secret',
    tokenAuth: 'body',
    endpointsVerified: false,
  },
  bilibili: {
    id: 'bilibili',
    authUrl: 'https://account.bilibili.com/pc/account-pc/auth/oauth',
    tokenUrl: 'https://api.bilibili.com/x/account-oauth2/v1/token',
    refreshUrl: 'https://api.bilibili.com/x/account-oauth2/v1/refresh_token',
    userInfoUrl: null,
    defaultScope: 'USER_INFO,ARC_BASE,ARC_DATA',
    usesPKCE: false,
    clientIdParam: 'client_id',
    tokenAuth: 'body',
    tokenEnvelope: 'data',
    // bilibili's page takes `gourl` for the redirect rather than redirect_uri.
    redirectParam: 'gourl',
    endpointsVerified: false,
  },
});

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** PKCE pair (RFC 7636, S256). */
function generatePkce() {
  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

function generateState() {
  return crypto.randomBytes(16).toString('hex');
}

function getProvider(name) {
  return PROVIDERS[name] || null;
}

/**
 * Build the URL the ACCOUNT HOLDER opens. Returns the url plus the state and
 * verifier the host must persist (encrypted or signed) until the callback.
 */
function buildAuthorizeUrl(providerName, { clientId, redirectUri, scope, state, codeVerifier } = {}) {
  const p = getProvider(providerName);
  if (!p) throw new Error(`Unknown OAuth provider: ${providerName}`);
  if (!clientId) throw new Error(`${providerName}: clientId is required`);
  if (!redirectUri) throw new Error(`${providerName}: redirectUri is required`);

  const finalState = state || generateState();
  const params = new URLSearchParams({
    response_type: 'code',
    [p.clientIdParam]: clientId,
    [p.redirectParam || 'redirect_uri']: redirectUri,
    scope: scope || p.defaultScope,
    state: finalState,
  });

  let verifier = null;
  if (p.usesPKCE) {
    if (codeVerifier) {
      verifier = codeVerifier;
      params.set('code_challenge', base64url(crypto.createHash('sha256').update(verifier).digest()));
    } else {
      const pk = generatePkce();
      verifier = pk.verifier;
      params.set('code_challenge', pk.challenge);
    }
    params.set('code_challenge_method', 'S256');
  }
  for (const [k, v] of Object.entries(p.extraAuthParams || {})) params.set(k, v);

  return { url: `${p.authUrl}?${params.toString()}`, state: finalState, codeVerifier: verifier, redirectUri };
}

function unwrapToken(p, data) {
  if (!data) return {};
  if (p.tokenEnvelope && data[p.tokenEnvelope] && typeof data[p.tokenEnvelope] === 'object') {
    return data[p.tokenEnvelope];
  }
  return data;
}

async function postToken(p, body, { clientId, clientSecret }, deps) {
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };
  if (p.tokenAuth === 'basic') {
    headers.Authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`;
  } else {
    body.set(p.clientSecretParam || 'client_secret', clientSecret);
  }
  if (p.requiresUserAgent) headers['User-Agent'] = deps.userAgent;
  const res = await deps.fetch(p.tokenUrl, { method: 'POST', headers, body: body.toString() });
  if (!res.ok) {
    const text = await readErrorText(res);
    throw new Error(`${p.id} token endpoint ${res.status}: ${text}`);
  }
  const raw = await readJson(res);
  const data = unwrapToken(p, raw);
  if (!data.access_token) {
    throw new Error(`${p.id} token endpoint returned no access_token${raw && raw.message ? `: ${String(raw.message).slice(0, 200)}` : ''}`);
  }
  return { raw, data };
}

/**
 * Exchange the callback `code` for tokens and resolve the connected account's
 * stable id + display handle. Returns a normalised shape; `metadata` carries
 * whatever the connector later needs (ig user id, channel id, open_id…).
 */
async function exchangeCode(providerName, { clientId, clientSecret, code, redirectUri, codeVerifier } = {}, depsIn) {
  const p = getProvider(providerName);
  if (!p) throw new Error(`Unknown OAuth provider: ${providerName}`);
  if (!clientId || !clientSecret) throw new Error(`${providerName}: clientId and clientSecret are required`);
  if (!code) throw new Error(`${providerName}: code is required`);
  const deps = resolveDeps(depsIn);

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    [p.clientIdParam]: clientId,
  });
  if (redirectUri) body.set('redirect_uri', redirectUri);
  if (p.usesPKCE && codeVerifier) body.set('code_verifier', codeVerifier);

  const { data } = await postToken(p, body, { clientId, clientSecret }, deps);

  const result = {
    provider: p.id,
    accessToken: data.access_token,
    refreshToken: data.refresh_token || null,
    expiresIn: data.expires_in != null ? Number(data.expires_in) : null,
    scope: data.scope || p.defaultScope,
    tokenType: data.token_type || 'Bearer',
    account: { id: null, name: null },
    metadata: {},
  };

  // Providers that return the identity with the token.
  if (data.open_id) {
    result.account.id = data.open_id;
    result.metadata.openId = data.open_id;
    if (data.union_id) result.metadata.unionId = data.union_id;
  }
  if (data.mid) {
    result.account.id = String(data.mid);
    result.metadata.mid = String(data.mid);
  }

  await resolveAccount(p, result, { clientId, clientSecret }, deps);
  return result;
}

/** Best-effort identity resolution; a failure here never fails the exchange. */
async function resolveAccount(p, result, { clientId, clientSecret }, deps) {
  try {
    if (p.id === 'instagram') {
      // short-lived user token → long-lived → Page → instagram_business_account
      const ll = await deps.fetch(
        `https://graph.facebook.com/v21.0/oauth/access_token?grant_type=fb_exchange_token&client_id=${encodeURIComponent(clientId)}&client_secret=${encodeURIComponent(clientSecret)}&fb_exchange_token=${encodeURIComponent(result.accessToken)}`,
      );
      if (ll.ok) {
        const j = await readJson(ll);
        if (j && j.access_token) {
          result.accessToken = j.access_token;
          if (j.expires_in) result.expiresIn = Number(j.expires_in);
        }
      }
      const pages = await deps.fetch(
        `https://graph.facebook.com/v21.0/me/accounts?fields=id,name,access_token,instagram_business_account&access_token=${encodeURIComponent(result.accessToken)}`,
      );
      if (pages.ok) {
        const j = await readJson(pages);
        const linked = ((j && j.data) || []).find((pg) => pg.instagram_business_account && pg.instagram_business_account.id);
        if (linked) {
          result.accessToken = linked.access_token || result.accessToken;
          result.account.id = linked.instagram_business_account.id;
          result.account.name = linked.name || null;
          result.metadata = { ...result.metadata, pageId: linked.id, pageName: linked.name, igUserId: linked.instagram_business_account.id };
          const ig = await deps.fetch(
            `https://graph.facebook.com/v21.0/${encodeURIComponent(result.account.id)}?fields=username&access_token=${encodeURIComponent(result.accessToken)}`,
          );
          if (ig.ok) {
            const u = await readJson(ig);
            if (u && u.username) result.account.name = `@${u.username}`;
          }
        }
      }
      return;
    }
    if (!p.userInfoUrl) return;
    const headers = { Authorization: `Bearer ${result.accessToken}` };
    if (p.requiresUserAgent) headers['User-Agent'] = deps.userAgent;
    const res = await deps.fetch(p.userInfoUrl, { headers });
    if (!res.ok) return;
    const u = await readJson(res);
    if (!u) return;
    if (p.id === 'x') {
      result.account.id = u.data && u.data.id ? u.data.id : null;
      result.account.name = u.data && u.data.username ? `@${u.data.username}` : (u.data && u.data.name) || null;
    } else if (p.id === 'youtube') {
      const ch = (u.items || [])[0];
      if (ch) {
        result.account.id = ch.id;
        result.account.name = (ch.snippet && (ch.snippet.title || ch.snippet.customUrl)) || null;
        result.metadata = { ...result.metadata, channelId: ch.id, channelHandle: ch.snippet && ch.snippet.customUrl ? ch.snippet.customUrl : null };
      }
    } else if (p.id === 'tiktok') {
      const usr = (u.data && u.data.user) || {};
      result.account.id = usr.open_id || usr.union_id || null;
      result.account.name = usr.display_name || usr.username || null;
      result.metadata = { ...result.metadata, openId: usr.open_id || null, unionId: usr.union_id || null };
    } else if (p.id === 'reddit') {
      result.account.id = u.id || null;
      result.account.name = u.name ? `u/${u.name}` : null;
    }
  } catch {
    /* identity is a convenience; the tokens are what matter */
  }
}

/**
 * Refresh an access token. Returns the same shape as exchangeCode minus
 * identity. Providers that rotate refresh tokens (X, TikTok, 抖音) return the
 * new one; the host must store it or the next refresh fails.
 */
async function refreshAccessToken(providerName, { clientId, clientSecret, refreshToken } = {}, depsIn) {
  const p = getProvider(providerName);
  if (!p) throw new Error(`Unknown OAuth provider: ${providerName}`);
  if (!refreshToken) throw new Error(`${providerName}: refreshToken is required`);
  if (!clientId || !clientSecret) throw new Error(`${providerName}: clientId and clientSecret are required`);
  const deps = resolveDeps(depsIn);

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    [p.clientIdParam]: clientId,
  });
  const target = { ...p, tokenUrl: p.refreshUrl || p.tokenUrl };
  const { data } = await postToken(target, body, { clientId, clientSecret }, deps);
  return {
    provider: p.id,
    accessToken: data.access_token,
    refreshToken: data.refresh_token || refreshToken,
    expiresIn: data.expires_in != null ? Number(data.expires_in) : null,
    scope: data.scope || null,
    tokenType: data.token_type || 'Bearer',
  };
}

module.exports = {
  PROVIDERS,
  getProvider,
  generatePkce,
  generateState,
  buildAuthorizeUrl,
  exchangeCode,
  refreshAccessToken,
};
