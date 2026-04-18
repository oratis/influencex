import React, { useState, useEffect, useRef } from 'react';
import { api } from '../api/client';
import { useToast } from '../components/Toast';
import { useConfirm } from '../components/ConfirmDialog';

const FORMATS = [
  { id: 'twitter', label: 'Twitter / X', emoji: '𝕏', hint: 'Single tweet or thread' },
  { id: 'linkedin', label: 'LinkedIn', emoji: 'in', hint: '150–300 word post' },
  { id: 'blog', label: 'Blog post', emoji: '✎', hint: '600–1200 word article' },
  { id: 'email', label: 'Email', emoji: '✉', hint: 'Subject + body' },
  { id: 'caption', label: 'Caption', emoji: '#', hint: '<150 chars + hashtags' },
  { id: 'youtube-short', label: 'YouTube Short', emoji: '▷', hint: '60s video script' },
];

export default function ContentStudio() {
  const [format, setFormat] = useState('twitter');
  const [brief, setBrief] = useState('');
  const [audience, setAudience] = useState('');
  const [keywords, setKeywords] = useState('');
  const [cta, setCta] = useState('');
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

  useEffect(() => {
    loadVoices();
    loadPieces();
    return () => { if (srcRef.current) srcRef.current.close(); };
  }, []);

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
      toast.error('Describe what you want written (the "brief")');
      return;
    }
    setIsGenerating(true);
    setCurrentOutput(null);
    setEvents([{ type: 'started', data: { agent: 'content-text' } }]);

    const voice = voices.find(v => v.id === voiceId);
    const input = {
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
      const r = await api.runAgent('content-text', input);
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
              toast.error(parsed.data?.message || 'Agent failed');
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
      toast.success('Saved to your library');
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
    toast.success('Copied to clipboard');
  }

  async function handleDelete(pieceId) {
    const ok = await confirmDialog('Delete this piece?', { danger: true, confirmText: 'Delete' });
    if (!ok) return;
    try {
      await api.deleteContentPiece(pieceId);
      toast.success('Deleted');
      loadPieces();
    } catch (e) {
      toast.error(e.message);
    }
  }

  return (
    <div className="page-container fade-in">
      <div className="page-header">
        <div>
          <h2>Content Studio</h2>
          <p>Describe what you want written. AI writes. You polish.</p>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
        {/* Left: input form */}
        <div className="card">
          <h3 style={{ marginBottom: 14 }}>Brief</h3>

          <label className="form-label">Format</label>
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

          <div className="form-group">
            <label className="form-label">What should this say?</label>
            <textarea
              className="form-textarea"
              placeholder="e.g. Announce our new AI agents feature. Focus on how it saves solo founders 20 hours/week. Include a self-deprecating hook."
              value={brief}
              onChange={e => setBrief(e.target.value)}
              style={{ minHeight: 110 }}
            />
          </div>

          <div className="form-row">
            <div className="form-group">
              <label className="form-label">Audience (optional)</label>
              <input className="form-input" placeholder="SaaS founders" value={audience} onChange={e => setAudience(e.target.value)} />
            </div>
            <div className="form-group">
              <label className="form-label">Keywords (comma-sep)</label>
              <input className="form-input" placeholder="ai, marketing, automation" value={keywords} onChange={e => setKeywords(e.target.value)} />
            </div>
          </div>

          <div className="form-row">
            <div className="form-group">
              <label className="form-label">Call to action (optional)</label>
              <input className="form-input" placeholder="Sign up for early access" value={cta} onChange={e => setCta(e.target.value)} />
            </div>
            <div className="form-group">
              <label className="form-label">Brand voice</label>
              <select className="form-select" value={voiceId} onChange={e => setVoiceId(e.target.value)}>
                <option value="">None (default)</option>
                {voices.map(v => <option key={v.id} value={v.id}>{v.name}{v.is_default ? ' (default)' : ''}</option>)}
              </select>
            </div>
          </div>

          <button
            className="btn btn-primary"
            onClick={handleGenerate}
            disabled={isGenerating || !brief.trim()}
            style={{ width: '100%', fontSize: 15, padding: 12 }}
          >
            {isGenerating ? '⏳ Writing…' : '✨ Generate'}
          </button>
        </div>

        {/* Right: output */}
        <div className="card">
          <h3 style={{ marginBottom: 14 }}>Output</h3>

          {isGenerating && (
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, fontSize: 13, color: 'var(--accent)' }}>
                <div className="loading-pulse" style={{ width: 8, height: 8, borderRadius: 4, background: 'var(--accent)' }} />
                Writing with Claude…
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
              <p>Fill in the brief on the left and click Generate.</p>
            </div>
          )}

          {currentOutput && (
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
                  <summary style={{ fontSize: 12, color: 'var(--text-muted)', cursor: 'pointer' }}>Reasoning</summary>
                  <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 6, lineHeight: 1.5 }}>
                    {currentOutput.reasoning}
                  </div>
                </details>
              )}
              <div className="btn-group">
                <button className="btn btn-primary btn-sm" onClick={handleSave}>💾 Save</button>
                <button className="btn btn-secondary btn-sm" onClick={handleCopy}>📋 Copy</button>
                <button className="btn btn-secondary btn-sm" onClick={handleGenerate}>🔄 Regenerate</button>
              </div>
              {currentOutput.word_count && (
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 10 }}>
                  {currentOutput.word_count} words
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Recent library */}
      <div className="card" style={{ marginTop: 20 }}>
        <h3 style={{ marginBottom: 14 }}>Your library ({pieces.length})</h3>
        {pieces.length === 0 ? (
          <div className="empty-state"><p>Save a piece with the 💾 button above to build your library.</p></div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 12 }}>
            {pieces.map(p => (
              <div key={p.id} className="card" style={{ padding: 14, border: '1px solid var(--border)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', marginBottom: 6 }}>
                  <span className="badge badge-gray" style={{ fontSize: 10 }}>{p.type}</span>
                  <button className="btn-icon" onClick={() => handleDelete(p.id)} style={{ padding: 4 }}>🗑</button>
                </div>
                {p.title && <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 4 }}>{p.title}</div>}
                <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.4, maxHeight: 80, overflow: 'hidden' }}>
                  {(p.body || '').slice(0, 160)}
                  {(p.body || '').length > 160 && '…'}
                </div>
                <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 8 }}>
                  {new Date(p.created_at).toLocaleDateString()} · {p.status}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

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
