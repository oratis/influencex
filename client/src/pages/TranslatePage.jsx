import React, { useState } from 'react';
import { api } from '../api/client';
import { useToast } from '../components/Toast';

/**
 * Translate — batched localization workbench. Pick target languages, paste
 * source content, get back per-language output with char counts + cultural
 * notes. Backed by `POST /api/translate` (Translate agent, single LLM call).
 */

// BCP-47 codes the Translate agent is tuned for. Ordered roughly by market size
// for influencer marketing use-cases. Users can still paste any BCP-47 code
// into the "custom" input if the target isn't in this list.
const LANG_PRESETS = [
  { code: 'es',    label: 'Spanish' },
  { code: 'fr',    label: 'French' },
  { code: 'de',    label: 'German' },
  { code: 'pt-BR', label: 'Portuguese (Brazil)' },
  { code: 'ja',    label: 'Japanese' },
  { code: 'ko',    label: 'Korean' },
  { code: 'zh-CN', label: 'Chinese (Simplified)' },
  { code: 'zh-TW', label: 'Chinese (Traditional)' },
  { code: 'ar',    label: 'Arabic' },
  { code: 'hi',    label: 'Hindi' },
  { code: 'id',    label: 'Indonesian' },
  { code: 'it',    label: 'Italian' },
  { code: 'nl',    label: 'Dutch' },
  { code: 'pl',    label: 'Polish' },
  { code: 'tr',    label: 'Turkish' },
  { code: 'ru',    label: 'Russian' },
];

const FORMAT_OPTIONS = [
  { value: '',              label: '— no format constraint —' },
  { value: 'twitter',       label: 'Twitter / X (280 chars)' },
  { value: 'linkedin',      label: 'LinkedIn (150–300 words)' },
  { value: 'blog',          label: 'Blog (±20% of source)' },
  { value: 'email',         label: 'Email (subject + body)' },
  { value: 'caption',       label: 'IG / TikTok caption' },
  { value: 'youtube-short', label: 'YouTube Short (≤60s TTS)' },
];

export default function TranslatePage() {
  const toast = useToast();
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [sourceLang, setSourceLang] = useState('');
  const [format, setFormat] = useState('');
  const [targets, setTargets] = useState(['es', 'fr', 'de', 'ja', 'zh-CN']);
  const [customLang, setCustomLang] = useState('');
  const [toneWords, setToneWords] = useState('');
  const [preserveTerms, setPreserveTerms] = useState('');
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);

  function toggleLang(code) {
    setTargets(t => t.includes(code) ? t.filter(c => c !== code) : [...t, code]);
  }

  function addCustomLang() {
    const code = customLang.trim();
    if (!code) return;
    if (!/^[a-z]{2,3}(-[A-Z]{2,4})?$/.test(code)) {
      toast.error('Use BCP-47 format, e.g. "vi" or "pt-PT"');
      return;
    }
    if (!targets.includes(code)) setTargets(t => [...t, code]);
    setCustomLang('');
  }

  async function handleTranslate() {
    if (!content.trim()) return toast.error('Source content is required');
    if (targets.length === 0) return toast.error('Pick at least one target language');
    setBusy(true);
    setResult(null);
    try {
      const body = {
        content,
        target_languages: targets,
      };
      if (title) body.title = title;
      if (sourceLang) body.source_language = sourceLang;
      if (format) body.format = format;
      if (toneWords.trim()) {
        body.brand_voice = { tone_words: toneWords.split(',').map(s => s.trim()).filter(Boolean) };
      }
      if (preserveTerms.trim()) {
        body.preserve_terms = preserveTerms.split(',').map(s => s.trim()).filter(Boolean);
      }
      const r = await api.translate(body);
      setResult(r);
      toast.success(`${r.translations?.length || 0} translations ready`);
    } catch (e) {
      toast.error(e.message);
    }
    setBusy(false);
  }

  function copy(text) {
    navigator.clipboard?.writeText(text).then(
      () => toast.success('Copied'),
      () => toast.error('Copy failed — select manually'),
    );
  }

  function langLabel(code) {
    return LANG_PRESETS.find(l => l.code === code)?.label || code;
  }

  return (
    <div className="page-container fade-in">
      <div className="page-header">
        <div>
          <h2>Translate</h2>
          <p>Localize one piece of content into 12+ languages in a single pass. Keeps brand voice, respects per-format length limits, preserves glossary terms verbatim.</p>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '420px 1fr', gap: 16 }}>
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Source</h3>

          <Field label="Title / headline (optional)">
            <input className="input" value={title} onChange={e => setTitle(e.target.value)} placeholder="The headline, if any" />
          </Field>

          <Field label="Source content *">
            <textarea
              className="input" rows={7} value={content}
              onChange={e => setContent(e.target.value)}
              placeholder="Paste the text to translate…"
            />
          </Field>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <Field label="Source language">
              <input
                className="input" value={sourceLang}
                onChange={e => setSourceLang(e.target.value)}
                placeholder="auto-detect"
              />
            </Field>
            <Field label="Format">
              <select className="input" value={format} onChange={e => setFormat(e.target.value)}>
                {FORMAT_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </Field>
          </div>

          <Field label="Brand tone words (comma-separated)">
            <input
              className="input" value={toneWords}
              onChange={e => setToneWords(e.target.value)}
              placeholder="witty, confident, plainspoken"
            />
          </Field>

          <Field label="Preserve verbatim (product names, trademarks)">
            <input
              className="input" value={preserveTerms}
              onChange={e => setPreserveTerms(e.target.value)}
              placeholder="Acme Cloud, Snapforge"
            />
          </Field>

          <h3 style={{ marginTop: 20 }}>Target languages ({targets.length})</h3>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
            {LANG_PRESETS.map(l => {
              const on = targets.includes(l.code);
              return (
                <button
                  key={l.code}
                  type="button"
                  onClick={() => toggleLang(l.code)}
                  className={on ? 'btn btn-primary' : 'btn btn-ghost'}
                  style={{ padding: '4px 10px', fontSize: 12 }}
                >
                  {l.code} · {l.label}
                </button>
              );
            })}
          </div>

          <div style={{ display: 'flex', gap: 6 }}>
            <input
              className="input" value={customLang}
              onChange={e => setCustomLang(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addCustomLang(); } }}
              placeholder="BCP-47 code (e.g. vi, th, pt-PT)"
              style={{ flex: 1 }}
            />
            <button type="button" className="btn btn-ghost" onClick={addCustomLang}>+ Add</button>
          </div>

          {targets.filter(c => !LANG_PRESETS.some(p => p.code === c)).length > 0 && (
            <div style={{ marginTop: 8, fontSize: 12, color: 'var(--text-muted)' }}>
              Custom:{' '}
              {targets.filter(c => !LANG_PRESETS.some(p => p.code === c)).map(c => (
                <span key={c} style={{ marginRight: 6 }}>
                  {c}
                  <button type="button" onClick={() => toggleLang(c)} style={{ background: 'none', border: 0, color: 'var(--text-muted)', cursor: 'pointer' }}>×</button>
                </span>
              ))}
            </div>
          )}

          <div style={{ marginTop: 16 }}>
            <button
              className="btn btn-primary"
              disabled={busy || !content.trim() || targets.length === 0}
              onClick={handleTranslate}
              style={{ width: '100%' }}
            >
              {busy ? 'Translating…' : `Translate into ${targets.length} language${targets.length === 1 ? '' : 's'}`}
            </button>
          </div>
        </div>

        {/* Right: results */}
        <div>
          {!result && !busy && (
            <div className="card" style={{ textAlign: 'center', padding: 48, color: 'var(--text-muted)' }}>
              <p>Fill in the source and hit Translate. Output will appear here grouped by language.</p>
            </div>
          )}

          {busy && (
            <div className="card" style={{ textAlign: 'center', padding: 48 }}>
              <p>Translating into {targets.length} language{targets.length === 1 ? '' : 's'}… this usually takes 10–30s.</p>
            </div>
          )}

          {result && (
            <div>
              <div className="card" style={{ marginBottom: 12 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <strong>Source:</strong>{' '}
                    <span style={{ color: 'var(--text-muted)' }}>
                      {result.source_language || 'auto-detected'} · {result.translations?.length || 0} outputs
                    </span>
                  </div>
                  {result.cost?.usdCents != null && (
                    <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                      Cost: ${(result.cost.usdCents / 100).toFixed(3)}
                      {result.cost.inputTokens ? ` · ${result.cost.inputTokens + (result.cost.outputTokens || 0)} tokens` : ''}
                    </span>
                  )}
                </div>
              </div>

              {(result.translations || []).map((t, i) => (
                <div key={i} className="card" style={{ marginBottom: 10 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 }}>
                    <div>
                      <strong>{t.language}</strong>
                      <span style={{ color: 'var(--text-muted)', marginLeft: 6, fontSize: 12 }}>
                        {langLabel(t.language)}
                      </span>
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                      {t.char_count ?? (t.content?.length || 0)} chars
                      <button
                        className="btn btn-ghost"
                        style={{ marginLeft: 8, padding: '2px 8px', fontSize: 11 }}
                        onClick={() => copy([t.title, t.content].filter(Boolean).join('\n\n'))}
                      >
                        Copy
                      </button>
                    </div>
                  </div>
                  {t.title && <div style={{ fontWeight: 600, marginBottom: 6 }}>{t.title}</div>}
                  <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>{t.content}</div>
                  {t.hashtags?.length > 0 && (
                    <div style={{ marginTop: 6, fontSize: 12, color: 'var(--text-accent, #4c6ef5)' }}>
                      {t.hashtags.join(' ')}
                    </div>
                  )}
                  {t.notes && (
                    <div style={{ marginTop: 8, fontSize: 12, color: 'var(--text-muted)', borderTop: '1px solid var(--border-muted, #eee)', paddingTop: 6 }}>
                      <em>Notes:</em> {t.notes}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <label style={{ display: 'block', fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>{label}</label>
      {children}
    </div>
  );
}
