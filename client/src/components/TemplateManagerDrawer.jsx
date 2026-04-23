import React, { useEffect, useState } from 'react';
import { api } from '../api/client';
import { useToast } from './Toast';
import { useConfirm } from './ConfirmDialog';
import { useI18n } from '../i18n';

const AVAILABLE_VARS = [
  'kol_name', 'kol_handle', 'platform', 'followers', 'category',
  'campaign_name', 'sender_name', 'product_name',
  'cooperation_type', 'price_quote',
];

export default function TemplateManagerDrawer({ onClose }) {
  const { t } = useI18n();
  const toast = useToast();
  const { confirm: confirmDialog } = useConfirm();
  const [templates, setTemplates] = useState({ builtin: [], custom: [] });
  const [editing, setEditing] = useState(null); // null | template object | 'new' | { parentId, mode: 'variant' }
  const [expandedVariantsFor, setExpandedVariantsFor] = useState(null); // parent template id
  const [variantData, setVariantData] = useState({ variants: [], stats: null });
  const [loading, setLoading] = useState(true);

  useEffect(() => { load(); }, []);

  async function load() {
    setLoading(true);
    try {
      const r = await api.listAllEmailTemplates();
      setTemplates({ builtin: r.builtin || [], custom: r.custom || [] });
    } catch (e) { toast.error(e.message); }
    setLoading(false);
  }

  async function handleSave(form) {
    try {
      if (form.mode === 'variant') {
        await api.createTemplateVariant(form.parentId, {
          variant_label: form.variant_label || 'variant',
          subject: form.subject,
          body: form.body,
          variables: form.variables || [],
        });
        toast.success(t('templates.variant_created'));
        // Refresh variants panel if we were showing this parent
        if (expandedVariantsFor === form.parentId) {
          await loadVariants(form.parentId);
        }
      } else if (form.id && form.id !== 'new') {
        await api.updateEmailTemplate(form.id, {
          name: form.name, language: form.language,
          cooperation_type: form.cooperation_type, subject: form.subject,
          body: form.body, variables: form.variables || [],
        });
        toast.success(t('templates.saved'));
      } else {
        await api.createEmailTemplate({
          name: form.name, language: form.language,
          cooperation_type: form.cooperation_type, subject: form.subject,
          body: form.body, variables: form.variables || [],
        });
        toast.success(t('templates.created'));
      }
      setEditing(null);
      await load();
    } catch (e) { toast.error(e.message); }
  }

  async function loadVariants(parentId) {
    try {
      const [v, s] = await Promise.all([
        api.listTemplateVariants(parentId),
        api.getTemplateStats(parentId),
      ]);
      setVariantData({ variants: v.variants || [], stats: s });
      setExpandedVariantsFor(parentId);
    } catch (e) { toast.error(e.message); }
  }

  async function handleDelete(id) {
    const ok = await confirmDialog(t('templates.confirm_delete'), { title: t('templates.delete_title'), danger: true });
    if (!ok) return;
    try {
      await api.deleteEmailTemplate(id);
      toast.success(t('templates.deleted'));
      await load();
    } catch (e) { toast.error(e.message); }
  }

  return (
    <div style={overlayStyle} onClick={onClose}>
      <div style={drawerStyle} onClick={e => e.stopPropagation()}>
        <div style={headerStyle}>
          <h3 style={{ margin: 0 }}>{t('templates.title')}</h3>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: 20, cursor: 'pointer' }}>×</button>
        </div>

        {editing ? (
          editing?.mode === 'variant' ? (
            <VariantEditor
              parentId={editing.parentId}
              onCancel={() => setEditing(null)}
              onSave={handleSave}
              t={t}
            />
          ) : (
            <TemplateEditor
              template={editing === 'new' ? null : editing}
              onCancel={() => setEditing(null)}
              onSave={handleSave}
              t={t}
            />
          )
        ) : (
          <div style={{ flex: 1, overflowY: 'auto', padding: '16px 22px' }}>
            {loading ? <p style={{ color: 'var(--text-muted)' }}>{t('common.loading')}</p> : (
              <>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                  <div style={{ fontWeight: 600 }}>{t('templates.custom_section')} ({templates.custom.length})</div>
                  <button className="btn btn-primary btn-sm" onClick={() => setEditing('new')}>+ {t('templates.create_new')}</button>
                </div>

                {templates.custom.length === 0 ? (
                  <div className="empty-state" style={{ padding: 16, fontSize: 13 }}>
                    <p>{t('templates.empty_custom')}</p>
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 20 }}>
                    {templates.custom.map(tp => (
                      <div key={tp.id} className="card" style={{ padding: 12 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                          <div>
                            <div style={{ fontWeight: 600 }}>
                              {tp.name}
                              {tp.variant_count > 0 && (
                                <span className="badge badge-purple" style={{ fontSize: 10, marginLeft: 6 }}>
                                  {t('templates.variants_count', { count: tp.variant_count })}
                                </span>
                              )}
                            </div>
                            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                              {tp.language} {tp.cooperation_type ? `· ${tp.cooperation_type}` : ''}
                            </div>
                          </div>
                          <div style={{ display: 'flex', gap: 6 }}>
                            <button className="btn btn-secondary btn-sm" onClick={() => expandedVariantsFor === tp.id ? setExpandedVariantsFor(null) : loadVariants(tp.id)}>
                              {expandedVariantsFor === tp.id ? t('templates.hide_variants') : t('templates.show_variants')}
                            </button>
                            <button className="btn btn-secondary btn-sm" onClick={() => setEditing(tp)}>{t('common.edit')}</button>
                            <button className="btn btn-secondary btn-sm" onClick={() => handleDelete(tp.id)}>{t('common.delete')}</button>
                          </div>
                        </div>
                        <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{tp.subject}</div>

                        {expandedVariantsFor === tp.id && (
                          <div style={{ marginTop: 10, borderTop: '1px solid var(--border)', paddingTop: 10 }}>
                            <VariantsPanel
                              parent={tp}
                              variants={variantData.variants}
                              stats={variantData.stats}
                              onAddVariant={() => setEditing({ mode: 'variant', parentId: tp.id })}
                              onPromoteWinner={async (winnerId) => {
                                try {
                                  await api.promoteTemplateWinner(tp.id, winnerId);
                                  toast.success(winnerId ? t('templates.winner_promoted') : t('templates.winner_cleared'));
                                  await loadVariants(tp.id);
                                } catch (e) { toast.error(e.message); }
                              }}
                              t={t}
                            />
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                <div style={{ fontWeight: 600, marginBottom: 10 }}>{t('templates.builtin_section')} ({templates.builtin.length})</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {templates.builtin.map(tp => (
                    <div key={tp.id} className="card" style={{ padding: 10, opacity: 0.85 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <div>
                          <div style={{ fontWeight: 600 }}>{tp.name}</div>
                          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{tp.language} · {tp.cooperation_type}</div>
                        </div>
                        <span className="badge badge-gray">{t('templates.builtin_tag')}</span>
                      </div>
                      <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4 }}>{tp.subject}</div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function TemplateEditor({ template, onCancel, onSave, t }) {
  const [form, setForm] = useState({
    id: template?.id || 'new',
    name: template?.name || '',
    language: template?.language || 'en',
    cooperation_type: template?.cooperation_type || 'affiliate',
    subject: template?.subject || '',
    body: template?.body || '',
    variables: template?.variables || AVAILABLE_VARS,
  });
  const disabled = !form.name.trim() || !form.subject.trim() || !form.body.trim();

  function insertVar(v) {
    setForm(f => ({ ...f, body: `${f.body}{{${v}}}` }));
  }

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '16px 22px' }}>
      <div style={{ marginBottom: 12 }}>
        <label style={labelStyle}>{t('templates.name')}</label>
        <input className="form-input" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder={t('templates.name_placeholder')} />
      </div>
      <div style={{ display: 'flex', gap: 10, marginBottom: 12 }}>
        <div style={{ flex: 1 }}>
          <label style={labelStyle}>{t('templates.language')}</label>
          <select className="form-select" value={form.language} onChange={e => setForm(f => ({ ...f, language: e.target.value }))}>
            <option value="en">English</option>
            <option value="zh">中文</option>
            <option value="ja">日本語</option>
            <option value="ko">한국어</option>
          </select>
        </div>
        <div style={{ flex: 1 }}>
          <label style={labelStyle}>{t('contacts.coop_type_label')}</label>
          <select className="form-select" value={form.cooperation_type} onChange={e => setForm(f => ({ ...f, cooperation_type: e.target.value }))}>
            <option value="affiliate">{t('contacts.coop_option_affiliate')}</option>
            <option value="paid">{t('contacts.coop_option_paid')}</option>
            <option value="any">{t('templates.coop_any')}</option>
          </select>
        </div>
      </div>
      <div style={{ marginBottom: 12 }}>
        <label style={labelStyle}>{t('contacts.email_subject_label')}</label>
        <input className="form-input" value={form.subject} onChange={e => setForm(f => ({ ...f, subject: e.target.value }))} />
      </div>
      <div style={{ marginBottom: 10 }}>
        <label style={labelStyle}>{t('contacts.email_body_label')}</label>
        <textarea className="form-textarea" style={{ minHeight: 240 }} value={form.body} onChange={e => setForm(f => ({ ...f, body: e.target.value }))} />
      </div>
      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>{t('templates.insert_var_hint')}</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {AVAILABLE_VARS.map(v => (
            <button key={v} type="button" className="btn btn-secondary btn-sm" style={{ fontSize: 11 }} onClick={() => insertVar(v)}>
              {`{{${v}}}`}
            </button>
          ))}
        </div>
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <button className="btn btn-secondary" onClick={onCancel}>{t('common.cancel')}</button>
        <button className="btn btn-primary" disabled={disabled} onClick={() => onSave(form)}>{t('common.save')}</button>
      </div>
    </div>
  );
}

function VariantsPanel({ parent, variants, stats, onAddVariant, onPromoteWinner, t }) {
  const rows = stats?.variants || [];
  const winnerId = stats?.winner_variant_id || null;
  const suggested = stats?.suggested_winner || null;

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <div style={{ fontSize: 12, fontWeight: 600 }}>{t('templates.variants_title')}</div>
        <button className="btn btn-primary btn-sm" style={{ fontSize: 11 }} onClick={onAddVariant}>
          + {t('templates.add_variant')}
        </button>
      </div>

      {(winnerId || suggested) && (
        <div style={{ padding: 8, background: 'var(--bg-elevated)', borderRadius: 4, marginBottom: 8, fontSize: 11 }}>
          {winnerId && (
            <div>
              🏆 {t('templates.winner_active', { label: rows.find(r => r.id === winnerId)?.variant_label || '—' })}
              <button className="btn btn-secondary btn-sm" style={{ fontSize: 10, marginLeft: 8 }} onClick={() => onPromoteWinner?.(null)}>
                {t('templates.winner_clear')}
              </button>
            </div>
          )}
          {!winnerId && suggested && (
            <div>
              ✨ {t('templates.winner_suggest', { label: suggested.variant_label, p: suggested.p_value })}
              <button className="btn btn-primary btn-sm" style={{ fontSize: 10, marginLeft: 8 }} onClick={() => onPromoteWinner?.(suggested.id)}>
                {t('templates.winner_promote')}
              </button>
            </div>
          )}
        </div>
      )}

      {/* Stats table — one row per variant (parent counts as "control") */}
      {rows.length > 0 && (
        <div className="table-container" style={{ marginBottom: 10 }}>
          <table style={{ fontSize: 12 }}>
            <thead>
              <tr>
                <th>{t('templates.stats_variant')}</th>
                <th>{t('templates.stats_sent')}</th>
                <th>{t('templates.stats_opened')}</th>
                <th>{t('templates.stats_replied')}</th>
                <th>{t('templates.stats_open_rate')}</th>
                <th>{t('templates.stats_reply_rate')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.id}>
                  <td>
                    <span className={`badge ${r.isParent ? 'badge-gray' : 'badge-purple'}`} style={{ fontSize: 10 }}>
                      {r.isParent ? t('templates.variant_parent') : r.variant_label}
                    </span>
                  </td>
                  <td>{r.sent}</td>
                  <td>{r.opened}</td>
                  <td>{r.replied}</td>
                  <td style={{ color: r.open_rate > 40 ? 'var(--success)' : 'var(--text-secondary)' }}>{r.open_rate}%</td>
                  <td style={{ color: r.reply_rate > 10 ? 'var(--success)' : 'var(--text-secondary)' }}>{r.reply_rate}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Variant list */}
      {variants.length === 0 ? (
        <div style={{ fontSize: 11, color: 'var(--text-muted)', padding: 8 }}>
          {t('templates.no_variants_yet')}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {variants.map(v => (
            <div key={v.id} style={{ padding: 8, background: 'var(--bg-elevated)', borderRadius: 4, fontSize: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ fontWeight: 600 }}>{v.variant_label || 'variant'}</span>
                <span style={{ color: 'var(--text-muted)' }}>{new Date(v.created_at).toLocaleDateString()}</span>
              </div>
              <div style={{ color: 'var(--text-secondary)', marginTop: 2 }}>{v.subject}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function VariantEditor({ parentId, onCancel, onSave, t }) {
  const [form, setForm] = useState({ mode: 'variant', parentId, variant_label: '', subject: '', body: '' });
  const disabled = !form.variant_label.trim() || !form.subject.trim() || !form.body.trim();

  function insertVar(v) {
    setForm(f => ({ ...f, body: `${f.body}{{${v}}}` }));
  }

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '16px 22px' }}>
      <h4 style={{ margin: '0 0 12px' }}>{t('templates.create_variant_title')}</h4>
      <div style={{ marginBottom: 12 }}>
        <label style={labelStyle}>{t('templates.variant_label')}</label>
        <input className="form-input" placeholder="A / B / shorter / casual..." value={form.variant_label} onChange={e => setForm(f => ({ ...f, variant_label: e.target.value }))} />
      </div>
      <div style={{ marginBottom: 12 }}>
        <label style={labelStyle}>{t('contacts.email_subject_label')}</label>
        <input className="form-input" value={form.subject} onChange={e => setForm(f => ({ ...f, subject: e.target.value }))} />
      </div>
      <div style={{ marginBottom: 10 }}>
        <label style={labelStyle}>{t('contacts.email_body_label')}</label>
        <textarea className="form-textarea" style={{ minHeight: 240 }} value={form.body} onChange={e => setForm(f => ({ ...f, body: e.target.value }))} />
      </div>
      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>{t('templates.insert_var_hint')}</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {AVAILABLE_VARS.map(v => (
            <button key={v} type="button" className="btn btn-secondary btn-sm" style={{ fontSize: 11 }} onClick={() => insertVar(v)}>
              {`{{${v}}}`}
            </button>
          ))}
        </div>
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <button className="btn btn-secondary" onClick={onCancel}>{t('common.cancel')}</button>
        <button className="btn btn-primary" disabled={disabled} onClick={() => onSave(form)}>{t('common.save')}</button>
      </div>
    </div>
  );
}

const overlayStyle = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1000,
  display: 'flex', justifyContent: 'flex-end',
};
const drawerStyle = {
  width: 'min(620px, 100%)', background: 'var(--bg-card)', borderLeft: '1px solid var(--border)',
  height: '100vh', display: 'flex', flexDirection: 'column',
};
const headerStyle = {
  padding: '18px 22px', borderBottom: '1px solid var(--border)',
  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
};
const labelStyle = { display: 'block', fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 };
