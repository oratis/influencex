import React, { useState } from 'react';
import { api } from '../api/client';
import { useToast } from '../components/Toast';
import { useI18n } from '../i18n';

/**
 * Translate — batched localization workbench.
 */

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

export default function TranslatePage() {
  const toast = useToast();
  const { t } = useI18n();
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

  const FORMAT_OPTIONS = [
    { value: '',              label: t('translate.format_none') },
    { value: 'twitter',       label: 'Twitter / X (280 chars)' },
    { value: 'linkedin',      label: 'LinkedIn (150–300 words)' },
    { value: 'blog',          label: 'Blog (±20% of source)' },
    { value: 'email',         label: 'Email (subject + body)' },
    { value: 'caption',       label: 'IG / TikTok caption' },
    { value: 'youtube-short', label: 'YouTube Short (≤60s TTS)' },
  ];

  function toggleLang(code) {
    setTargets(ts => ts.includes(code) ? ts.filter(c => c !== code) : [...ts, code]);
  }

  function addCustomLang() {
    const code = customLang.trim();
    if (!code) return;
    if (!/^[a-z]{2,3}(-[A-Z]{2,4})?$/.test(code)) {
      toast.error(t('translate.invalid_locale'));
      return;
    }
    if (!targets.includes(code)) setTargets(ts => [...ts, code]);
    setCustomLang('');
  }

  async function handleTranslate() {
    if (!content.trim()) return toast.error(t('translate.source_required'));
    if (targets.length === 0) return toast.error(t('translate.pick_at_least_one'));
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
      toast.success(t('translate.ready', { count: r.translations?.length || 0 }));
    } catch (e) {
      toast.error(e.message);
    }
    setBusy(false);
  }

  function copy(text) {
    navigator.clipboard?.writeText(text).then(
      () => toast.success(t('translate.copied')),
      () => toast.error(t('translate.copy_failed')),
    );
  }

  function langLabel(code) {
    return LANG_PRESETS.find(l => l.code === code)?.label || code;
  }

  const runLabel = targets.length === 1 ? t('translate.run_one') : t('translate.run', { count: targets.length });

  return (
    <div className="page-container fade-in">
      <div className="page-header">
        <div>
          <h2>{t('translate.title')}</h2>
          <p>{t('translate.subtitle')}</p>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '420px 1fr', gap: 16 }}>
        <div className="card">
          <h3 style={{ marginTop: 0 }}>{t('translate.source')}</h3>

          <Field label={t('translate.source_title')}>
            <input className="input" value={title} onChange={e => setTitle(e.target.value)} placeholder={t('translate.title_placeholder')} />
          </Field>

          <Field label={t('translate.source_content')}>
            <textarea
              className="input" rows={7} value={content}
              onChange={e => setContent(e.target.value)}
              placeholder={t('translate.source_content_placeholder')}
            />
          </Field>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <Field label={t('translate.source_language')}>
              <input
                className="input" value={sourceLang}
                onChange={e => setSourceLang(e.target.value)}
                placeholder={t('translate.source_auto')}
              />
            </Field>
            <Field label={t('translate.format')}>
              <select className="input" value={format} onChange={e => setFormat(e.target.value)}>
                {FORMAT_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </Field>
          </div>

          <Field label={t('translate.tone_words')}>
            <input
              className="input" value={toneWords}
              onChange={e => setToneWords(e.target.value)}
              placeholder={t('translate.tone_placeholder')}
            />
          </Field>

          <Field label={t('translate.preserve_terms')}>
            <input
              className="input" value={preserveTerms}
              onChange={e => setPreserveTerms(e.target.value)}
              placeholder={t('translate.preserve_placeholder')}
            />
          </Field>

          <h3 style={{ marginTop: 20 }}>{t('translate.target_languages', { count: targets.length })}</h3>
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
              placeholder={t('translate.custom_locale_placeholder')}
              style={{ flex: 1 }}
            />
            <button type="button" className="btn btn-ghost" onClick={addCustomLang}>{t('translate.custom_add')}</button>
          </div>

          {targets.filter(c => !LANG_PRESETS.some(p => p.code === c)).length > 0 && (
            <div style={{ marginTop: 8, fontSize: 12, color: 'var(--text-muted)' }}>
              {t('translate.custom_list')}{' '}
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
              {busy ? t('translate.translating') : runLabel}
            </button>
          </div>
        </div>

        {/* Right: results */}
        <div>
          {!result && !busy && (
            <div className="card" style={{ textAlign: 'center', padding: 48, color: 'var(--text-muted)' }}>
              <p>{t('translate.empty_state')}</p>
            </div>
          )}

          {busy && (
            <div className="card" style={{ textAlign: 'center', padding: 48 }}>
              <p>{t('translate.translating_msg', { count: targets.length })}</p>
            </div>
          )}

          {result && (
            <div>
              <div className="card" style={{ marginBottom: 12 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <strong>{t('translate.source')}:</strong>{' '}
                    <span style={{ color: 'var(--text-muted)' }}>
                      {result.source_language || t('translate.source_auto_detected')} · {t('translate.outputs', { count: result.translations?.length || 0 })}
                    </span>
                  </div>
                  {result.cost?.usdCents != null && (
                    <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                      {t('translate.cost', { usd: (result.cost.usdCents / 100).toFixed(3) })}
                      {result.cost.inputTokens ? ` · ${t('translate.tokens', { count: result.cost.inputTokens + (result.cost.outputTokens || 0) })}` : ''}
                    </span>
                  )}
                </div>
              </div>

              {(result.translations || []).map((item, i) => (
                <div key={i} className="card" style={{ marginBottom: 10 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 }}>
                    <div>
                      <strong>{item.language}</strong>
                      <span style={{ color: 'var(--text-muted)', marginLeft: 6, fontSize: 12 }}>
                        {langLabel(item.language)}
                      </span>
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                      {t('translate.chars', { count: item.char_count ?? (item.content?.length || 0) })}
                      <button
                        className="btn btn-ghost"
                        style={{ marginLeft: 8, padding: '2px 8px', fontSize: 11 }}
                        onClick={() => copy([item.title, item.content].filter(Boolean).join('\n\n'))}
                      >
                        {t('translate.copy')}
                      </button>
                    </div>
                  </div>
                  {item.title && <div style={{ fontWeight: 600, marginBottom: 6 }}>{item.title}</div>}
                  <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>{item.content}</div>
                  {item.hashtags?.length > 0 && (
                    <div style={{ marginTop: 6, fontSize: 12, color: 'var(--text-accent, #4c6ef5)' }}>
                      {item.hashtags.join(' ')}
                    </div>
                  )}
                  {item.notes && (
                    <div style={{ marginTop: 8, fontSize: 12, color: 'var(--text-muted)', borderTop: '1px solid var(--border-muted, #eee)', paddingTop: 6 }}>
                      <em>{t('translate.notes')}</em> {item.notes}
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
