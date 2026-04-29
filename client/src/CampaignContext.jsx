import React, { createContext, useContext, useState, useEffect } from 'react';
import { api } from './api/client';
import { useAuth } from './AuthContext';

// Exported so tests can mock the provider value (see CampaignContext usage
// in OnboardingTour.test.jsx). Production code should keep importing
// `useCampaign` instead.
export const CampaignContext = createContext(null);

export function CampaignProvider({ children }) {
  const { user } = useAuth();
  const [campaigns, setCampaigns] = useState([]);
  const [selectedCampaignId, setSelectedCampaignId] = useState(
    localStorage.getItem('influencex_campaign') || ''
  );
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user) { setCampaigns([]); setLoading(false); return; }
    api.getCampaigns()
      .then(data => {
        setCampaigns(data);
        // Default to hakko-q1-all if no selection or selection not found
        if (!selectedCampaignId || !data.find(c => c.id === selectedCampaignId)) {
          const hakko = data.find(c => c.id === 'hakko-q1-all') || data[0];
          if (hakko) selectCampaign(hakko.id);
        }
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [user]);

  const selectCampaign = (id) => {
    setSelectedCampaignId(id);
    localStorage.setItem('influencex_campaign', id);
  };

  const refreshCampaigns = async () => {
    const data = await api.getCampaigns();
    setCampaigns(data);
    return data;
  };

  const selectedCampaign = campaigns.find(c => c.id === selectedCampaignId) || null;

  return (
    <CampaignContext.Provider value={{
      campaigns, selectedCampaignId, selectedCampaign,
      selectCampaign, refreshCampaigns, loading
    }}>
      {children}
    </CampaignContext.Provider>
  );
}

export function useCampaign() {
  const ctx = useContext(CampaignContext);
  if (!ctx) throw new Error('useCampaign must be used within CampaignProvider');
  return ctx;
}
