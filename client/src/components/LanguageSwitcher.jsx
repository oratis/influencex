import React from 'react';
import { useI18n } from '../i18n';

export default function LanguageSwitcher() {
  const { lang, setLang, availableLangs, t } = useI18n();

  return (
    <select
      className="global-campaign-select"
      value={lang}
      onChange={e => setLang(e.target.value)}
      style={{ padding: '5px 24px 5px 10px', fontSize: '12px' }}
      aria-label={t('language.switch_label')}
      title={t('language.switch_label')}
    >
      {availableLangs.map(l => (
        <option key={l} value={l}>{l.toUpperCase()}</option>
      ))}
    </select>
  );
}
