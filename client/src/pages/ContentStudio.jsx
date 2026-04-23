import React, { useState, useEffect, useRef } from 'react';
import { api } from '../api/client';
import { useToast } from '../components/Toast';
import { useConfirm } from '../components/ConfirmDialog';
import { useI18n } from '../i18n';

export default function ContentStudio() {
  const [format, setFormat] = useState('twitter');
  const [brief, setBrief] = useState('');
  const [audience, setAudience] = useState('');
  const [keywords, setKeywords] = useState('');
  const [cta, setCta] = useState('');
  const [imageSize, setImageSize] = useState('2k');
  const [enrichPrompt, setEnrichPrompt] = useState(true);
  const { t } = useI18n();

  const FORMATS = [
    { id: 'twitter', label: t('studio.format_twitter'), emoji: '𝕏', hint: t('studio.hint_twitter'), kind: 'text' },
    { id: 'linkedin', label: t('studio.format_linkedin'), emoji: 'in', hint: t('studio.hint_linkedin'), kind: 'text' },
    { id: 'blog', label: t('studio.format_blog'), emoji: '✎', hint: t('studio.hint_blog'), kind: 'text' },
    { id: 'email', label: t('studio.format_email'), emoji: '✉', hint: t('studio.hint_email'), kind: 'text' },
    { id: 'caption', label: t('studio.format_caption'), emoji: '#', hint: t('studio.hint_caption'), kind: 'text' },
    { id: 'youtube-short', label: t('studio.format_youtube_short'), emoji: '▷', hint: t('studio.hint_youtube_short'), kind: 'text' },
    { id: 'image', label: t('studio.format_image'), emoji: '🖼', hint: t('studio.hint_image'), kind: 'image' },
  ];

  const currentFormat = FORMATS.find(f => f.id === format);
  const isImage = currentFormat?.kind === 'image';
  const [voiceId, setVoiceId] = useState('');
  const [voices, setVoices] = useState([]);
  const [pieces, setPieces] = useState([]);
  const [isGenerating, setIsGenerating] = useState(false);
  const [events, setEvents] = useState([]);
  const [currentOutput, setCurrentOutput] = useState(null);
  const [activeRunId, setActiveRunId] = useState(null);
  const srcRef = useRef(null);
  const toast = useToast();
  const { confirm: confirmDialog } = useConfirm();
  const [publishResults, setPublishResults] = useState(null);
  const [isPublishing, setIsPublishing] = useState(false);
  const [presets, setPresets] = useState([]);
  const [showScheduleModal, setShowScheduleModal] = useState(false);
  const [scheduleAt, setScheduleAt] = useState('');

  useEffect(() => {
    loadVoices();
    loadPieces();
    loadPresets();
    return () => { if (srcRef.current) srcRef.current.close(); };
  }, []);

  useEffect(() => { loadPresets(); }, [format, isImage]);

  async function loadPresets() {
    try {
      const type = isImage ? 'image' : 'text';
      const r = await api.listPromptPresets({ type, limit: 12 });
      setPresets(r.presets || []);
    } catch (e) { /* ok */ }
  }

  function applyPreset(preset) {
    setBrief(preset.prompt);
    api.usePromptPreset(preset.id).catch(() => {});
    toast.success(t('studio.applied_preset', { name: preset.name }));
  }

  async function saveAsPreset() {
    if (!brief.trim()) return;
    const name = window.prompt(isImage ? t('studio.save_preset_prompt_image') : t('studio.save_preset_prompt_text'));
    if (!name) return;
    try {
      await api.createPromptPreset({
        name,
        prompt: brief.trim(),
        type: isImage ? 'image' : 'text',
        agent_id: isImage ? 'content-visual' : 'content-text',
      });
      toast.success(t('studio.saved_preset', { name }));
      loadPresets();
    } catch (e) {
      toast.error(e.message);
    }
  }

  async function handleSchedule() {
    if (!currentOutput) return;
    const content = isImage
      ? { title: currentOutput.original_brief || '', body: currentOutput.url || '', image_url: currentOutput.url }
      : {
          title: currentOutput.title,
          body: currentOutput.body,
          cta: currentOutput.cta,
          hashtags: currentOutput.hashtags || [],
        };
    try {
      await api.schedulePublish({
        platforms: defaultPlatformsFor(format),
        scheduled_at: scheduleAt,
        content,
        mode: 'intent',
      });
      toast.success(t('studio.scheduled'));
      setShowScheduleModal(false);
    } catch (e) {
      toast.error(e.message);
    }
  }

  async function loadVoices() {
    try {
      const r = await api.listBrandVoices();
      setVoices(r.voices || []);
    } catch (e) { /* ok to fail */ }
  }
  async function loadPieces() {
    try {
      const r = await api.listContentPieces({ limit: 20 });
      setPieces(r.pieces || []);
    } catch (e) { /* ok */ }
  }

  async function handleGenerate() {
    if (!brief.trim()) {
      toast.error(t('studio.brief_required'));
      return;
    }
    setIsGenerating(true);
    setCurrentOutput(null);
    setEvents([{ type: 'started', data: { agent: 'content-text' } }]);

    const voice = voices.find(v => v.id === voiceId);
    const agentId = isImage ? 'content-visual' : 'content-text';
    const input = isImage
      ? {
          brief: brief.trim(),
          mode: enrichPrompt ? 'enrich' : 'direct',
          size: imageSize,
          aspect: audience.trim() || undefined,
          brand_voice: voice ? { tone_words: voice.tone_words } : undefined,
        }
      : {
          format,
          brief: brief.trim(),
          audience: audience.trim() || undefined,
          keywords: keywords.split(',').map(k => k.trim()).filter(Boolean),
          cta: cta.trim() || undefined,
          brand_voice: voice ? {
            tone_words: voice.tone_words,
            do_examples: voice.do_examples,
            dont_examples: voice.dont_examples,
          } : undefined,
        };

    try {
      const r = await api.runAgent(agentId, input);
      setActiveRunId(r.runId);
      const src = api.streamAgentRun(r.runId);
      srcRef.current = src;

      for (const ev of ['started', 'progress', 'thinking', 'partial', 'complete', 'error']) {
        src.addEventListener(ev, (e) => {
          try {
            const parsed = JSON.parse(e.data);
            setEvents(prev => [...prev, { type: ev, ...(parsed || {}) }]);
            if (ev === 'complete') {
              setCurrentOutput(parsed.data?.output || null);
              setIsGenerating(false);
            }
            if (ev === 'error') {
              toast.error(parsed.data?.message || t('studio.publisher_failed'));
              setIsGenerating(false);
            }
          } catch { /* ignore */ }
        });
      }
      src.addEventListener('closed', () => { src.close(); setIsGenerating(false); });
    } catch (e) {
      toast.error(e.message);
      setIsGenerating(false);
    }
  }

  async function handleSave() {
    if (!currentOutput) return;
    try {
      if (isImage) {
        let persistedUrl = currentOutput.url;
        let persistedBytes = null;
        try {
          toast.info(t('studio.persisting_image'), 2000);
          const r = await api.fetchAsDataUrl(currentOutput.url);
          persistedUrl = r.data_url;
          persistedBytes = r.byte_size;
        } catch (e) {
          toast.error(t('studio.persist_failed', { error: e.message }));
        }
        await api.createContentPiece({
          type: 'image',
          title: currentOutput.original_brief || '',
          body: persistedUrl,
          status: 'draft',
          metadata: {
            prompt: currentOutput.prompt,
            size: currentOutput.size,
            provider: currentOutput.provider,
            model: currentOutput.model,
            original_url: currentOutput.url,
            persisted_bytes: persistedBytes,
          },
          created_by_agent_run_id: activeRunId,
        });
      } else {
        await api.createContentPiece({
          type: format,
          title: currentOutput.title || '',
          body: currentOutput.body || '',
          status: 'draft',
          metadata: {
            hashtags: currentOutput.hashtags,
            cta: currentOutput.cta,
            word_count: currentOutput.word_count,
            reasoning: currentOutput.reasoning,
          },
          created_by_agent_run_id: activeRunId,
        });
      }
      toast.success(t('studio.saved_library'));
      await loadPieces();
    } catch (e) {
      toast.error(e.message);
    }
  }

  function handleCopy() {
    if (!currentOutput) return;
    const text = currentOutput.title
      ? `${currentOutput.title}\n\n${currentOutput.body}${currentOutput.hashtags?.length ? '\n\n' + currentOutput.hashtags.join(' ') : ''}`
      : currentOutput.body;
    navigator.clipboard.writeText(text);
    toast.success(t('studio.copied'));
  }

  async function handlePublish(platforms) {
    if (!currentOutput) return;
    setIsPublishing(true);
    try {
      const content = isImage
        ? { title: currentOutput.original_brief || '', body: currentOutput.original_brief || '', image_url: currentOutput.url }
        : {
            title: currentOutput.title,
            body: currentOutput.body,
            cta: currentOutput.cta,
            hashtags: currentOutput.hashtags || [],
          };
      const r = await api.runAgent('publisher', { content, platforms });
      let tries = 0;
      while (tries < 20) {
        await new Promise(res => setTimeout(res, 500));
        const run = await api.getAgentRun(r.runId);
        if (run.status === 'complete') {
          setPublishResults(run.output?.results || []);
          break;
        }
        if (run.status === 'error') {
          throw new Error(run.error || t('studio.publisher_failed'));
        }
        tries++;
      }
    } catch (e) {
      toast.error(e.message);
    } finally {
      setIsPublishing(false);
    }
  }

  async function handleDelete(pieceId) {
    const ok = await confirmDialog(t('studio.delete_piece'), { danger: true, confirmText: t('common.delete') });
    if (!ok) return;
    try {
      await api.deleteContentPiece(pieceId);
      toast.success(t('studio.deleted'));
      loadPieces();
    } catch (e) {
      toast.error(e.message);
    }
  }

  return (
    <div className="page-container fade-in">
      <div className="page-header">
        <div>
          <h2>{t('studio.title')}</h2>
          <p>{t('studio.subtitle')}</p>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
        <div className="card">
          <h3 style={{ marginBottom: 14 }}>{t('studio.brief')}</h3>

          <label className="form-label">{t('studio.format')}</label>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6, marginBottom: 16 }}>
            {FORMATS.map(f => (
              <button
                key={f.id}
                onClick={() => setFormat(f.id)}
                style={{
                  padding: '10px 8px', border: `1px solid ${format === f.id ? 'var(--accent)' : 'var(--border)'}`,
                  background: format === f.id ? 'var(--accent-light)' : 'var(--bg-input)',
                  color: format === f.id ? 'var(--accent)' : 'var(--text-primary)',
                  borderRadius: 8, cursor: 'pointer', fontSize: 12, textAlign: 'left',
                  fontFamily: 'inherit', transition: 'all 0.15s',
                }}
              >
                <div style={{ fontSize: 16, marginBottom: 2 }}>{f.emoji}</div>
                <div style={{ fontWeight: 600 }}>{f.label}</div>
                <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>{f.hint}</div>
              </button>
            ))}
          </div>

          {presets.length > 0 && (
            <div style={{ marginBottom: 14 }}>
              <label className="form-label" style={{ fontSize: 12 }}>{t('studio.your_presets')}</label>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {presets.map(p => (
                  <button
                    key={p.id}
                    onClick={() => applyPreset(p)}
                    style={{
                      padding: '4px 10px', fontSize: 11, borderRadius: 14,
                      border: '1px solid var(--border)', background: 'var(--bg-input)',
                      color: 'var(--text-secondary)', cursor: 'pointer', fontFamily: 'inherit',
                    }}
                    title={p.prompt.slice(0, 200)}
                  >
                    {p.name}{p.use_count > 0 ? ` · ${p.use_count}` : ''}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="form-group">
            <label className="form-label" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span>{isImage ? t('studio.brief_label_image') : t('studio.brief_label_text')}</span>
              {brief.trim() && (
                <button
                  onClick={saveAsPreset}
                  style={{
                    fontSize: 11, color: 'var(--accent)', background: 'none',
                    border: 'none', cursor: 'pointer', padding: 0,
                  }}
                  title={t('studio.save_preset_tip')}
                >{t('studio.save_preset')}</button>
              )}
            </label>
            <textarea
              className="form-textarea"
              placeholder={isImage ? t('studio.brief_placeholder_image') : t('studio.brief_placeholder_text')}
              value={brief}
              onChange={e => setBrief(e.target.value)}
              style={{ minHeight: 110 }}
            />
          </div>

          {isImage && (
            <div className="form-row">
              <div className="form-group">
                <label className="form-label">{t('studio.size')}</label>
                <select className="form-select" value={imageSize} onChange={e => setImageSize(e.target.value)}>
                  <option value="2k">{t('studio.size_2k')}</option>
                  <option value="3k">{t('studio.size_3k')}</option>
                </select>
              </div>
              <div className="form-group">
                <label className="form-label">{t('studio.prompt_enrichment')}</label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, padding: '10px 0', cursor: 'pointer' }}>
                  <input type="checkbox" checked={enrichPrompt} onChange={e => setEnrichPrompt(e.target.checked)} />
                  {t('studio.enrich_hint')}
                </label>
              </div>
            </div>
          )}

          <div className="form-row">
            <div className="form-group">
              <label className="form-label">{isImage ? t('studio.aspect') : t('studio.audience')}</label>
              <input className="form-input" placeholder={isImage ? t('studio.aspect_placeholder') : t('studio.audience_placeholder')} value={audience} onChange={e => setAudience(e.target.value)} />
            </div>
            <div className="form-group">
              <label className="form-label">{t('studio.brand_voice')}</label>
              <select className="form-select" value={voiceId} onChange={e => setVoiceId(e.target.value)}>
                <option value="">{t('studio.brand_voice_none')}</option>
                {voices.map(v => <option key={v.id} value={v.id}>{v.name}{v.is_default ? t('studio.brand_voice_default_suffix') : ''}</option>)}
              </select>
            </div>
          </div>

          {!isImage && (
            <div className="form-row">
              <div className="form-group">
                <label className="form-label">{t('studio.keywords')}</label>
                <input className="form-input" placeholder={t('studio.keywords_placeholder')} value={keywords} onChange={e => setKeywords(e.target.value)} />
              </div>
              <div className="form-group">
                <label className="form-label">{t('studio.cta')}</label>
                <input className="form-input" placeholder={t('studio.cta_placeholder')} value={cta} onChange={e => setCta(e.target.value)} />
              </div>
            </div>
          )}

          <button
            className="btn btn-primary"
            onClick={handleGenerate}
            disabled={isGenerating || !brief.trim()}
            style={{ width: '100%', fontSize: 15, padding: 12 }}
          >
            {isGenerating ? t('studio.generating') : t('studio.generate')}
          </button>
        </div>

        <div className="card">
          <h3 style={{ marginBottom: 14 }}>{t('studio.output')}</h3>

          {isGenerating && (
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, fontSize: 13, color: 'var(--accent)' }}>
                <div className="loading-pulse" style={{ width: 8, height: 8, borderRadius: 4, background: 'var(--accent)' }} />
                {t('studio.writing_with_claude')}
              </div>
              <div style={{
                maxHeight: 200, overflowY: 'auto', fontFamily: 'monospace',
                fontSize: 11, background: 'var(--bg-input)', borderRadius: 8, padding: 10,
              }}>
                {events.map((e, i) => (
                  <div key={i} style={{ marginBottom: 2, opacity: e.type === 'started' || e.type === 'progress' ? 1 : 0.6 }}>
                    <span style={{ color: 'var(--accent)' }}>[{e.type}]</span>{' '}
                    {e.data?.message || e.data?.step || ''}
                  </div>
                ))}
              </div>
            </div>
          )}

          {!isGenerating && !currentOutput && (
            <div className="empty-state" style={{ padding: 40 }}>
              <p>{t('studio.empty_output')}</p>
            </div>
          )}

          {currentOutput && isImage && currentOutput.url && (
            <div>
              <img
                src={currentOutput.url}
                alt={currentOutput.original_brief || 'Generated image'}
                style={{
                  width: '100%', borderRadius: 8, border: '1px solid var(--border)',
                  marginBottom: 12,
                }}
              />
              <details style={{ marginBottom: 12 }}>
                <summary style={{ fontSize: 12, color: 'var(--text-muted)', cursor: 'pointer' }}>
                  {t('studio.prompt_used', { count: currentOutput.prompt?.length || 0 })}
                </summary>
                <div style={{
                  fontSize: 12, color: 'var(--text-secondary)', marginTop: 6,
                  lineHeight: 1.5, padding: 10, background: 'var(--bg-input)', borderRadius: 6,
                }}>
                  {currentOutput.prompt}
                </div>
              </details>
              <div className="btn-group">
                <button className="btn btn-primary btn-sm" onClick={handleSave}>{t('studio.save')}</button>
                <a
                  className="btn btn-secondary btn-sm"
                  href={currentOutput.url}
                  target="_blank"
                  rel="noreferrer"
                  download
                >{t('studio.open_download')}</a>
                <button className="btn btn-secondary btn-sm" onClick={handleGenerate}>{t('studio.regenerate')}</button>
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 8 }}>
                {currentOutput.size} · {currentOutput.provider} · {currentOutput.model}
              </div>
            </div>
          )}

          {currentOutput && !isImage && (
            <div>
              {currentOutput.title && (
                <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 12 }}>{currentOutput.title}</div>
              )}
              <div style={{
                whiteSpace: 'pre-wrap', fontSize: 14, lineHeight: 1.6,
                background: 'var(--bg-input)', padding: 14, borderRadius: 8,
                border: '1px solid var(--border)', marginBottom: 12,
              }}>
                {currentOutput.body}
              </div>
              {currentOutput.hashtags?.length > 0 && (
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
                  {currentOutput.hashtags.map(h => (
                    <span key={h} style={{ fontSize: 12, color: 'var(--accent)' }}>{h.startsWith('#') ? h : '#' + h}</span>
                  ))}
                </div>
              )}
              {currentOutput.reasoning && (
                <details style={{ marginBottom: 12 }}>
                  <summary style={{ fontSize: 12, color: 'var(--text-muted)', cursor: 'pointer' }}>{t('studio.reasoning')}</summary>
                  <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 6, lineHeight: 1.5 }}>
                    {currentOutput.reasoning}
                  </div>
                </details>
              )}
              <div className="btn-group">
                <button className="btn btn-primary btn-sm" onClick={handleSave}>{t('studio.save')}</button>
                <button className="btn btn-secondary btn-sm" onClick={handleCopy}>{t('studio.copy')}</button>
                <button className="btn btn-secondary btn-sm" onClick={handleGenerate}>{t('studio.regenerate')}</button>
                <button className="btn btn-secondary btn-sm" onClick={() => handlePublish(defaultPlatformsFor(format))} disabled={isPublishing}>
                  {isPublishing ? '...' : t('studio.publish')}
                </button>
                <button className="btn btn-secondary btn-sm" onClick={() => {
                  const now = new Date();
                  now.setHours(now.getHours() + 1, 0, 0, 0);
                  setScheduleAt(now.toISOString().slice(0, 16));
                  setShowScheduleModal(true);
                }}>{t('studio.schedule')}</button>
              </div>
              {currentOutput.word_count && (
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 10 }}>
                  {t('studio.words', { count: currentOutput.word_count })}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {publishResults && publishResults.length > 0 && (
        <div className="card" style={{ marginTop: 20 }}>
          <div className="card-header">
            <h3>{t('studio.publish_package', { count: publishResults.length })}</h3>
            <button className="btn-icon" onClick={() => setPublishResults(null)} title={t('common.close')}>✕</button>
          </div>
          <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '0 0 14px' }}>
            {t('studio.publish_note')}
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: 12 }}>
            {publishResults.map(r => (
              <div key={r.platform} className="card" style={{ padding: 14, border: '1px solid var(--border)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', marginBottom: 8 }}>
                  <span className="badge badge-purple" style={{ fontSize: 11, textTransform: 'capitalize' }}>{r.platform}</span>
                  <span style={{ fontSize: 11, color: r.char_count > (r.char_limit || Infinity) ? 'var(--danger)' : 'var(--text-muted)' }}>
                    {r.char_count}{r.char_limit ? ` / ${r.char_limit}` : ''}
                  </span>
                </div>
                {r.error ? (
                  <div style={{ color: 'var(--danger)', fontSize: 12 }}>{r.error}</div>
                ) : (
                  <>
                    <div style={{
                      fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.5,
                      background: 'var(--bg-input)', padding: 10, borderRadius: 6,
                      maxHeight: 120, overflow: 'auto', whiteSpace: 'pre-wrap',
                      marginBottom: 8,
                    }}>
                      {r.text}
                    </div>
                    {r.tweets && r.tweets.length > 1 && (
                      <details style={{ marginBottom: 8, fontSize: 11 }}>
                        <summary style={{ color: 'var(--text-muted)', cursor: 'pointer' }}>
                          {t('studio.full_thread', { count: r.tweets.length })}
                        </summary>
                        <ol style={{ paddingLeft: 20, marginTop: 6 }}>
                          {r.tweets.map((tw, i) => (
                            <li key={i} style={{ marginBottom: 6, color: 'var(--text-secondary)' }}>{tw}</li>
                          ))}
                        </ol>
                      </details>
                    )}
                    {r.warnings && r.warnings.length > 0 && (
                      <div style={{ fontSize: 11, color: 'var(--warning)', marginBottom: 8 }}>
                        ⚠ {r.warnings.join(' ')}
                      </div>
                    )}
                    <div style={{ display: 'flex', gap: 6 }}>
                      <a
                        className="btn btn-primary btn-sm"
                        href={r.intent_url}
                        target="_blank"
                        rel="noreferrer"
                        style={{ flex: 1, textAlign: 'center', textDecoration: 'none' }}
                      >
                        {t('studio.open_in', { platform: r.platform })}
                      </a>
                      <button
                        className="btn btn-secondary btn-sm"
                        onClick={() => {
                          navigator.clipboard.writeText(r.text);
                          toast.success(t('studio.copied_platform', { platform: r.platform }));
                        }}
                      >
                        📋
                      </button>
                    </div>
                  </>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="card" style={{ marginTop: 20 }}>
        <h3 style={{ marginBottom: 14 }}>{t('studio.library', { count: pieces.length })}</h3>
        {pieces.length === 0 ? (
          <div className="empty-state"><p>{t('studio.library_empty')}</p></div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 12 }}>
            {pieces.map(p => (
              <div key={p.id} className="card" style={{ padding: 14, border: '1px solid var(--border)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', marginBottom: 6 }}>
                  <span className="badge badge-gray" style={{ fontSize: 10 }}>{p.type}</span>
                  <button className="btn-icon" onClick={() => handleDelete(p.id)} style={{ padding: 4 }}>🗑</button>
                </div>
                {p.type === 'image' && p.body ? (
                  <a href={p.body} target="_blank" rel="noreferrer">
                    <img
                      src={p.body}
                      alt={p.title || 'Image'}
                      style={{ width: '100%', height: 160, objectFit: 'cover', borderRadius: 6, marginBottom: 6, background: 'var(--bg-input)' }}
                      onError={e => { e.currentTarget.style.display = 'none'; }}
                    />
                  </a>
                ) : null}
                {p.title && <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 4 }}>{p.title}</div>}
                {p.type !== 'image' && (
                  <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.4, maxHeight: 80, overflow: 'hidden' }}>
                    {(p.body || '').slice(0, 160)}
                    {(p.body || '').length > 160 && '…'}
                  </div>
                )}
                <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 8 }}>
                  {new Date(p.created_at).toLocaleDateString()} · {p.status}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {showScheduleModal && (
        <div className="modal-overlay" onClick={() => setShowScheduleModal(false)}>
          <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 480 }}>
            <div className="modal-header">
              <h3>{t('studio.schedule_publish')}</h3>
              <button className="btn-icon" onClick={() => setShowScheduleModal(false)}>✕</button>
            </div>
            <div className="modal-body">
              <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 12 }}>
                {t('studio.schedule_note')}
                <strong>{defaultPlatformsFor(format).join(', ')}</strong>
              </p>
              <label className="form-label">{t('studio.scheduled_time')}</label>
              <input
                type="datetime-local"
                className="form-input"
                value={scheduleAt}
                onChange={e => setScheduleAt(e.target.value)}
              />
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setShowScheduleModal(false)}>{t('common.cancel')}</button>
              <button className="btn btn-primary" onClick={handleSchedule} disabled={!scheduleAt}>
                {t('common.schedule')}
              </button>
            </div>
          </div>
        </div>
      )}

      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.4; }
        }
        .loading-pulse { animation: pulse 1.2s ease-in-out infinite; }
      `}</style>
    </div>
  );
}

function defaultPlatformsFor(format) {
  const map = {
    twitter: ['twitter'],
    linkedin: ['linkedin'],
    blog: ['linkedin', 'twitter'],
    email: [],
    caption: ['twitter', 'bluesky', 'threads'],
    'youtube-short': ['twitter', 'threads'],
    image: ['twitter', 'linkedin', 'pinterest', 'bluesky'],
  };
  return map[format] || ['twitter', 'linkedin'];
}
