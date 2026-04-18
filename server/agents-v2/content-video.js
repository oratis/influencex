/**
 * Content-Video Agent — orchestrates a short-form video package:
 *   1. Claude writes the script (hook / body / CTA) from a brief
 *   2. Claude writes a shot-by-shot storyboard (visual descriptions per beat)
 *   3. ElevenLabs turns the script into voiceover audio
 *   4. (future) Volcengine image-gen produces a thumbnail / keyframe per shot
 *
 * v1 does steps 1-3. Returns a video "blueprint" the user can manually
 * assemble in any video editor (or a Publisher agent can later compose
 * automatically via ffmpeg + image sequence + audio).
 */

const llm = require('../llm');

const SCRIPT_SYSTEM_PROMPT = `You are a short-form video scriptwriter. Given a topic/brief, produce a complete package for a 30-60 second vertical video (Reels / Shorts / TikTok).

Rules:
- Hook under 5 seconds (first line must grab attention)
- Conversational tone, not announcer-style
- No "In this video we're going to..." preamble
- End with one clear CTA
- Per-beat storyboard: describe the visual alongside each script line

Call compose_video with the structured output.`;

const videoTool = {
  name: 'compose_video',
  description: 'Emit the full video package.',
  input_schema: {
    type: 'object',
    required: ['title', 'hook', 'beats'],
    properties: {
      title: { type: 'string' },
      hook: { type: 'string', description: 'First 5 seconds of the video — attention grabber' },
      beats: {
        type: 'array',
        description: 'Ordered list of beats (shots). 4-8 beats for a 30-60s video.',
        items: {
          type: 'object',
          required: ['voiceover', 'visual'],
          properties: {
            voiceover: { type: 'string', description: 'What the narrator says in this beat' },
            visual: { type: 'string', description: 'Visual description (what the viewer sees)' },
            duration_sec: { type: 'number' },
          },
        },
      },
      cta: { type: 'string' },
      hashtags: { type: 'array', items: { type: 'string' } },
      total_duration_sec: { type: 'number' },
    },
  },
};

module.exports = {
  id: 'content-video',
  name: 'Video Script & Storyboard',
  description: 'Produce a complete short-form video package: hook + beats (voiceover + visuals) + CTA + voiceover audio. Meta-agent that uses Content-Text (Claude) and Content-Voice (ElevenLabs).',
  version: '1.0.0',
  capabilities: ['compose.video'],

  inputSchema: {
    type: 'object',
    required: ['brief'],
    properties: {
      brief: { type: 'string' },
      platform: { type: 'string', enum: ['tiktok', 'reels', 'shorts', 'generic'], default: 'shorts' },
      audience: { type: 'string' },
      include_voiceover: { type: 'boolean', default: true, description: 'Whether to synthesize audio (costs ~¢5-15 extra)' },
      voice_id: { type: 'string' },
    },
  },

  outputSchema: videoTool.input_schema,

  costEstimate(input) {
    // Script: ~2k tokens on sonnet-4-5 ≈ ¢25
    // Voice (if on): ~500 chars at ¢30/1k → ¢15
    return {
      tokens: 2000,
      usdCents: 25 + (input?.include_voiceover === false ? 0 : 15),
    };
  },

  async run(input, ctx) {
    if (!input?.brief) throw new Error('brief is required');
    if (!llm.isConfigured()) throw new Error('LLM provider not configured');

    // ---- Step 1 & 2: script + storyboard in one Claude call ----
    ctx.emit('progress', { step: 'scripting', message: 'Claude writing script + storyboard...' });

    const userMessage = `Brief: ${input.brief}
Platform: ${input.platform || 'shorts'}
${input.audience ? `Audience: ${input.audience}` : ''}

Write the video package. Call compose_video.`;

    const res = await llm.complete({
      messages: [{ role: 'user', content: userMessage }],
      system: SCRIPT_SYSTEM_PROMPT,
      tools: [videoTool],
      maxTokens: 2500,
      temperature: 0.7,
    });

    const toolUse = (res.toolUses || []).find(t => t.name === 'compose_video');
    if (!toolUse) throw new Error('Video agent: Claude did not produce structured output');
    const pkg = toolUse.input;

    ctx.emit('progress', { step: 'scripted', message: `${pkg.beats?.length || 0} beats generated` });

    // ---- Step 3: voiceover (optional) ----
    let audioDataUrl = null;
    let audioBytes = 0;
    const includeVoice = input.include_voiceover !== false;

    if (includeVoice && process.env.ELEVENLABS_API_KEY) {
      ctx.emit('progress', { step: 'voicing', message: 'ElevenLabs synthesizing voiceover...' });
      try {
        // Concatenate beats into a single narration pass
        const fullScript = [pkg.hook, ...pkg.beats.map(b => b.voiceover), pkg.cta].filter(Boolean).join(' ');
        // Defer to content-voice agent via direct function call (avoid creating
        // a nested run — keeps trace tree simple)
        const voiceAgent = require('./content-voice');
        const voiceOutput = await voiceAgent.run({ text: fullScript, voice_id: input.voice_id }, {
          emit: (step, data) => ctx.emit(`voice.${step}`, data),
          logger: ctx.logger,
        });
        audioDataUrl = voiceOutput.audio_url;
        audioBytes = voiceOutput.byte_size;
      } catch (e) {
        ctx.emit('progress', { step: 'voice-failed', message: `Voiceover failed: ${e.message}. Returning script-only package.` });
      }
    }

    ctx.emit('progress', { step: 'complete', message: 'Video package ready' });

    const scriptCost = res.usage?.usdCents || 25;
    const voiceCharCount = includeVoice && audioDataUrl
      ? [pkg.hook, ...pkg.beats.map(b => b.voiceover), pkg.cta].filter(Boolean).join(' ').length
      : 0;
    const voiceCost = Math.ceil(voiceCharCount * 30 / 1000);

    return {
      ...pkg,
      audio_url: audioDataUrl,
      audio_bytes: audioBytes,
      platform: input.platform || 'shorts',
      cost: {
        inputTokens: res.usage?.inputTokens || 0,
        outputTokens: res.usage?.outputTokens || 0,
        usdCents: scriptCost + voiceCost,
      },
    };
  },
};
