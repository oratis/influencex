/**
 * Content-Voice Agent — turns a text script into an audio file via ElevenLabs.
 *
 * Use cases:
 *   - Podcast voiceover from a blog post
 *   - YouTube Short narration from a script (pairs with content-text
 *     format='youtube-short')
 *   - Accessibility: TTS for all written content
 *
 * For v1, uses ElevenLabs' /text-to-speech endpoint with default voice.
 * Future: voice cloning from a sample, multilingual, SSML for pauses.
 *
 * Output: audio file URL (we return a data URL for small clips, future:
 * upload to GCS for persistence).
 */

const fetch = require('../proxy-fetch');
const { Buffer } = require('buffer');

const ELEVENLABS_BASE = 'https://api.elevenlabs.io/v1';
// ElevenLabs' well-known 'Rachel' voice; replaced by ELEVENLABS_VOICE_ID if set
const DEFAULT_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM';

async function synthesize({ text, voiceId, modelId }) {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) throw new Error('ELEVENLABS_API_KEY not configured');

  const effectiveVoice = voiceId || DEFAULT_VOICE_ID;
  const effectiveModel = modelId || process.env.ELEVENLABS_MODEL || 'eleven_turbo_v2_5';

  const res = await fetch(`${ELEVENLABS_BASE}/text-to-speech/${effectiveVoice}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'xi-api-key': key,
      'Accept': 'audio/mpeg',
    },
    body: JSON.stringify({
      text,
      model_id: effectiveModel,
      voice_settings: {
        stability: 0.5,
        similarity_boost: 0.75,
      },
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`ElevenLabs ${res.status}: ${body.slice(0, 300)}`);
  }
  const arr = await res.arrayBuffer();
  return {
    buffer: Buffer.from(arr),
    contentType: res.headers.get('content-type') || 'audio/mpeg',
    voiceId: effectiveVoice,
    modelId: effectiveModel,
  };
}

module.exports = {
  id: 'content-voice',
  name: 'Voice Narration',
  description: 'Turn a script into audio using ElevenLabs TTS. Returns an MP3 data URL. Good for podcast voiceovers, YouTube Short narration, accessibility TTS.',
  version: '1.0.0',
  capabilities: ['generate.audio'],

  inputSchema: {
    type: 'object',
    required: ['text'],
    properties: {
      text: { type: 'string', description: 'Script to narrate. Max 5000 characters for eleven_turbo_v2_5; keep tighter for flash models.' },
      voice_id: { type: 'string', description: "ElevenLabs voice ID. Defaults to 'Rachel' or env ELEVENLABS_VOICE_ID." },
      model_id: { type: 'string', description: 'Model ID. Defaults to eleven_turbo_v2_5 (fast + cheap).' },
    },
  },

  outputSchema: {
    type: 'object',
    properties: {
      audio_url: { type: 'string', description: 'data:audio/mpeg;base64,... URL — can be played in an <audio> tag directly' },
      byte_size: { type: 'number' },
      voice_id: { type: 'string' },
      model_id: { type: 'string' },
      character_count: { type: 'number' },
    },
  },

  costEstimate(input) {
    // ElevenLabs pricing: ~$0.30 per 1K chars for turbo/flash = ¢30 per 1K.
    // For the default turbo_v2_5 model, this is ballpark. Production users
    // should negotiate enterprise pricing for >1M chars/month.
    const chars = (input?.text || '').length;
    return { usdCents: Math.ceil(chars * 30 / 1000), tokens: 0, characters: chars };
  },

  async run(input, ctx) {
    if (!input?.text) throw new Error('text is required');
    if (!process.env.ELEVENLABS_API_KEY) {
      throw new Error('Voice provider not configured. Set ELEVENLABS_API_KEY.');
    }
    if (input.text.length > 5000) {
      throw new Error('Text too long for single call (max 5000 chars). Split and chain calls for longer scripts.');
    }

    ctx.emit('progress', { step: 'synthesizing', message: `Calling ElevenLabs for ${input.text.length} chars...` });

    const { buffer, contentType, voiceId, modelId } = await synthesize({
      text: input.text,
      voiceId: input.voice_id,
      modelId: input.model_id,
    });

    const dataUrl = `data:${contentType};base64,${buffer.toString('base64')}`;
    const costCents = Math.ceil(input.text.length * 30 / 1000);

    ctx.emit('progress', { step: 'complete', message: `Audio ready (${Math.round(buffer.length / 1024)}KB)` });

    return {
      audio_url: dataUrl,
      byte_size: buffer.length,
      voice_id: voiceId,
      model_id: modelId,
      character_count: input.text.length,
      cost: { inputTokens: 0, outputTokens: 0, usdCents: costCents },
    };
  },
};
