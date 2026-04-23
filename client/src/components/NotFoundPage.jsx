import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useI18n } from '../i18n';

export default function NotFoundPage() {
  const navigate = useNavigate();
  const { t } = useI18n();
  return (
    <div className="page-container fade-in" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '60vh' }}>
      <div className="empty-state">
        <div style={{ fontSize: '64px', marginBottom: '12px', opacity: 0.3 }}>404</div>
        <h4 style={{ fontSize: '20px', marginBottom: '8px' }}>{t('not_found.title')}</h4>
        <p>{t('not_found.description')}</p>
        <div className="btn-group" style={{ marginTop: '16px', justifyContent: 'center' }}>
          <button className="btn btn-primary" onClick={() => navigate('/pipeline')}>{t('not_found.go_to_pipeline')}</button>
          <button className="btn btn-secondary" onClick={() => navigate(-1)}>{t('not_found.go_back')}</button>
        </div>
      </div>
    </div>
  );
}
