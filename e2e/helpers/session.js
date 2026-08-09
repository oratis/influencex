/**
 * Session + API helpers for the specs.
 *
 * The admin token is minted once in global-setup.js and persisted inside the
 * Playwright storageState file; reading it back here avoids a second login
 * (the server rate-limits /api/auth/* to 10 requests per minute per IP).
 */

const fs = require('fs');

const { STORAGE_STATE } = require('../env');

function adminToken() {
  const state = JSON.parse(fs.readFileSync(STORAGE_STATE, 'utf8'));
  const origin = (state.origins || [])[0];
  const entry = (origin?.localStorage || []).find(e => e.name === 'influencex_token');
  if (!entry) throw new Error('admin token missing from storage state');
  return entry.value;
}

function authHeaders(workspaceId) {
  const headers = {
    Authorization: `Bearer ${adminToken()}`,
    'Content-Type': 'application/json',
  };
  if (workspaceId) headers['X-Workspace-Id'] = workspaceId;
  return headers;
}

/** Fail loudly on a non-2xx instead of letting a spec assert on garbage. */
async function json(response, what) {
  if (!response.ok()) {
    throw new Error(`${what} failed (${response.status()}): ${await response.text()}`);
  }
  return response.json();
}

module.exports = { adminToken, authHeaders, json };
