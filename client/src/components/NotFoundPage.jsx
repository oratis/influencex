import React from 'react';
import { useNavigate } from 'react-router-dom';

export default function NotFoundPage() {
  const navigate = useNavigate();
  return (
    <div className="page-container fade-in" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '60vh' }}>
      <div className="empty-state">
        <div style={{ fontSize: '64px', marginBottom: '12px', opacity: 0.3 }}>404</div>
        <h4 style={{ fontSize: '20px', marginBottom: '8px' }}>Page Not Found</h4>
        <p>The page you're looking for doesn't exist or has been moved.</p>
        <div className="btn-group" style={{ marginTop: '16px', justifyContent: 'center' }}>
          <button className="btn btn-primary" onClick={() => navigate('/pipeline')}>Go to Pipeline</button>
          <button className="btn btn-secondary" onClick={() => navigate(-1)}>Go Back</button>
        </div>
      </div>
    </div>
  );
}
