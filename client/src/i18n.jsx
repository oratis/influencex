/**
 * Minimal i18n with persistent language selection.
 *
 * Zero dependencies. Supports nested keys ("nav.pipeline") and {{variable}}
 * interpolation. Missing keys fall back to the key itself (visible in UI,
 * making them easy to spot during translation).
 */

import React, { createContext, useContext, useState, useCallback, useMemo } from 'react';

const STORAGE_KEY = 'influencex_lang';

const MESSAGES = {
  en: {
    nav: {
      pipeline: 'Pipeline',
      campaigns: 'Campaigns',
      contacts: 'Contacts',
      data: 'Data',
      kol_database: 'KOL Database',
      roi: 'ROI',
      users: 'Users',
    },
    common: {
      loading: 'Loading...',
      save: 'Save',
      cancel: 'Cancel',
      delete: 'Delete',
      edit: 'Edit',
      confirm: 'Confirm',
      close: 'Close',
      refresh: 'Refresh',
      export_csv: 'Export CSV',
      search: 'Search',
      error: 'Error',
      success: 'Success',
      no_data: 'No data',
      back: 'Back',
    },
    auth: {
      sign_in: 'Sign In',
      sign_up: 'Sign Up',
      sign_out: 'Sign Out',
      email: 'Email',
      password: 'Password',
      name: 'Name',
      invalid_credentials: 'Invalid email or password',
    },
    roles: {
      admin: 'Admin',
      editor: 'Editor',
      viewer: 'Viewer',
      member: 'Member',
    },
    roi: {
      title: 'ROI Dashboard',
      no_campaign: 'No campaign selected',
      budget_utilization: 'Budget Utilization',
      total_views: 'Total Content Views',
      engagement_rate: 'Engagement Rate',
      effective_cpm: 'Effective CPM',
      funnel: 'Conversion Funnel',
      reply_rate: 'Reply Rate',
      contract_rate: 'Contract Rate',
      completion_rate: 'Completion Rate',
      payment_rate: 'Payment Rate',
      kols_by_status: 'KOLs by Status',
      cost_efficiency: 'Cost Efficiency',
    },
  },
  zh: {
    nav: {
      pipeline: '流水线',
      campaigns: '活动',
      contacts: '联系人',
      data: '数据',
      kol_database: '达人库',
      roi: 'ROI',
      users: '用户',
    },
    common: {
      loading: '加载中...',
      save: '保存',
      cancel: '取消',
      delete: '删除',
      edit: '编辑',
      confirm: '确认',
      close: '关闭',
      refresh: '刷新',
      export_csv: '导出 CSV',
      search: '搜索',
      error: '错误',
      success: '成功',
      no_data: '暂无数据',
      back: '返回',
    },
    auth: {
      sign_in: '登录',
      sign_up: '注册',
      sign_out: '退出',
      email: '邮箱',
      password: '密码',
      name: '姓名',
      invalid_credentials: '邮箱或密码错误',
    },
    roles: {
      admin: '管理员',
      editor: '编辑',
      viewer: '访客',
      member: '成员',
    },
    roi: {
      title: 'ROI 看板',
      no_campaign: '未选择活动',
      budget_utilization: '预算使用率',
      total_views: '内容总播放',
      engagement_rate: '互动率',
      effective_cpm: '有效 CPM',
      funnel: '转化漏斗',
      reply_rate: '回复率',
      contract_rate: '签约率',
      completion_rate: '完成率',
      payment_rate: '付款率',
      kols_by_status: '达人状态分布',
      cost_efficiency: '成本效率',
    },
  },
};

function resolve(dict, key) {
  const parts = key.split('.');
  let node = dict;
  for (const p of parts) {
    if (node && typeof node === 'object' && p in node) node = node[p];
    else return null;
  }
  return typeof node === 'string' ? node : null;
}

function interpolate(str, vars) {
  if (!str) return '';
  return str.replace(/\{\{(\w+)\}\}/g, (_, k) => (vars && vars[k] !== undefined ? String(vars[k]) : ''));
}

const I18nContext = createContext(null);

export function I18nProvider({ children }) {
  const [lang, setLangState] = useState(() => {
    const stored = typeof localStorage !== 'undefined' && localStorage.getItem(STORAGE_KEY);
    if (stored && MESSAGES[stored]) return stored;
    // Auto-detect browser language, default to English
    if (typeof navigator !== 'undefined') {
      const browserLang = (navigator.language || '').toLowerCase();
      if (browserLang.startsWith('zh')) return 'zh';
    }
    return 'en';
  });

  const setLang = useCallback((newLang) => {
    if (!MESSAGES[newLang]) return;
    setLangState(newLang);
    try { localStorage.setItem(STORAGE_KEY, newLang); } catch {}
  }, []);

  const t = useCallback((key, vars) => {
    const messages = MESSAGES[lang] || MESSAGES.en;
    const str = resolve(messages, key);
    if (str === null) {
      // Fallback to English, then to key itself
      const enStr = resolve(MESSAGES.en, key);
      return interpolate(enStr || key, vars);
    }
    return interpolate(str, vars);
  }, [lang]);

  const value = useMemo(() => ({
    lang,
    setLang,
    t,
    availableLangs: Object.keys(MESSAGES),
  }), [lang, setLang, t]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error('useI18n must be used within I18nProvider');
  return ctx;
}
