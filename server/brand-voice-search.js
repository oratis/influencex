/**
 * Brand-voice retrieval via embedding similarity.
 *
 * Two responsibilities:
 *
 * 1. embedBrandVoice(voice) — flatten a brand_voice row's text into a single
 *    string, send to llm.embed(), return the 1536-dim vector (or null if
 *    embedding is unavailable / fails).
 *
 * 2. findBestBrandVoice({ workspaceId, brief, db }) — given a content brief,
 *    return the brand_voice in this workspace whose embedding is closest
 *    (cosine). On Postgres this uses the pgvector `<=>` operator + IVFFlat
 *    index from migration 2026-04-22-brand-voice-embeddings. On SQLite the
 *    embedding column is JSON text — we pull all workspace voices and
 *    compute cosine in JS.
 *
 * Returns null when:
 *   - no brand_voices in the workspace
 *   - no embeddings stored anywhere yet (cold-start)
 *   - llm.embed() fails for the brief itself
 *
 * Callers (content-text agent) treat null as "no preference" and proceed
 * without an injected brand voice — the LLM falls back to its own style.
 */

const llm = require('./llm');
const log = require('./logger');

// Compose the searchable string from a brand_voice row. Concatenation order
// matters less than coverage — we want tone_words to dominate but keep
// description + style_guide as secondary signal.
function composeBrandVoiceText(voice) {
  const parts = [];
  if (voice.name) parts.push(`Name: ${voice.name}`);
  if (voice.description) parts.push(`Description: ${voice.description}`);
  const tones = parseJsonField(voice.tone_words);
  if (tones.length) parts.push(`Tone: ${tones.join(', ')}`);
  if (voice.style_guide) parts.push(`Style guide: ${voice.style_guide}`);
  const dos = parseJsonField(voice.do_examples);
  if (dos.length) parts.push(`Good examples: ${dos.slice(0, 5).join(' | ')}`);
  const donts = parseJsonField(voice.dont_examples);
  if (donts.length) parts.push(`Avoid: ${donts.slice(0, 5).join(' | ')}`);
  return parts.join('\n');
}

function parseJsonField(field) {
  if (!field) return [];
  if (Array.isArray(field)) return field;
  try { const v = JSON.parse(field); return Array.isArray(v) ? v : []; }
  catch { return []; }
}

async function embedBrandVoice(voice) {
  const text = composeBrandVoiceText(voice);
  if (!text) return null;
  try {
    const vectors = await llm.embed({ texts: [text] });
    return vectors?.[0] || null;
  } catch (e) {
    log.warn('[brand-voice] embed failed:', e.message);
    return null;
  }
}

// Cosine similarity for SQLite path — Postgres handles this server-side.
function cosineSim(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return -1;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? -1 : dot / denom;
}

async function findBestBrandVoice({ workspaceId, brief, db, usePostgres }) {
  if (!workspaceId || !brief || !db) return null;

  let queryEmbed;
  try {
    const v = await llm.embed({ texts: [brief] });
    queryEmbed = v?.[0];
  } catch (e) {
    log.warn('[brand-voice] query embed failed:', e.message);
    return null;
  }
  if (!queryEmbed) return null;

  if (usePostgres) {
    // pgvector: ORDER BY embedding <=> $1 (cosine distance, smaller = closer)
    // Cast the JS array to vector via pgvector's literal format.
    try {
      const vectorLit = `[${queryEmbed.join(',')}]`;
      const result = await db.queryOne(
        `SELECT id, name, description, tone_words, do_examples, dont_examples, style_guide,
                (embedding <=> $1::vector) AS distance
         FROM brand_voices
         WHERE workspace_id = $2 AND embedding IS NOT NULL
         ORDER BY embedding <=> $1::vector
         LIMIT 1`,
        [vectorLit, workspaceId]
      );
      if (!result) return null;
      // Reject very dissimilar matches — cosine distance > 0.6 (similarity < 0.4)
      // means the brief isn't really close to any saved voice.
      if (result.distance != null && result.distance > 0.6) return null;
      return hydrateVoice(result);
    } catch (e) {
      log.warn('[brand-voice] pgvector search failed:', e.message);
      return null;
    }
  }

  // SQLite fallback — pull everything, score in JS.
  const all = await db.query(
    `SELECT id, name, description, tone_words, do_examples, dont_examples, style_guide, embedding
     FROM brand_voices
     WHERE workspace_id = ? AND embedding IS NOT NULL`,
    [workspaceId]
  );
  let best = null;
  let bestSim = 0.4;  // minimum threshold; below this we'd rather inject nothing
  for (const row of (all.rows || [])) {
    let vec;
    try { vec = JSON.parse(row.embedding); } catch { continue; }
    if (!Array.isArray(vec)) continue;
    const sim = cosineSim(queryEmbed, vec);
    if (sim > bestSim) {
      bestSim = sim;
      best = row;
    }
  }
  return best ? hydrateVoice(best) : null;
}

// Convert DB row (JSON-stringified arrays) into the shape the agent expects.
function hydrateVoice(row) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    tone_words: parseJsonField(row.tone_words),
    do_examples: parseJsonField(row.do_examples),
    dont_examples: parseJsonField(row.dont_examples),
    style_guide: row.style_guide,
  };
}

module.exports = {
  composeBrandVoiceText,
  embedBrandVoice,
  findBestBrandVoice,
  // Exposed for tests
  cosineSim,
  parseJsonField,
};
