import React, { useMemo } from 'react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts';
import { useI18n } from '../i18n';
import { chartPalette, token } from '../utils/chartTokens';

/**
 * Monthly spend, stacked by agent.
 *
 * Lazy-loaded from AnalyticsPage: that page is imported eagerly in App.jsx, so
 * a top-level `recharts` import here would drag the whole charting library into
 * the main bundle. Splitting it out puts recharts in a chunk shared with the
 * (already lazy) ROI dashboard instead.
 *
 * Form: part-to-whole over time → stacked columns, one measure on one axis.
 * The month × agent table below the chart is its table-view twin, so every
 * value is readable without hovering.
 */

// Categorical hues cap at 8 (design.md §12). Past the top 6 agents the tail
// folds into a single de-emphasised "Other" — never a generated 9th hue.
const MAX_SERIES = 6;
const OTHER = '__other__';

export default function UsageChart({ report }) {
  const { t } = useI18n();

  const { data, series } = useMemo(() => {
    const ranked = (report.byAgent || []).map(a => a.agent_id);
    const top = ranked.slice(0, MAX_SERIES);
    const hasTail = ranked.length > top.length;

    const palette = chartPalette();
    const built = top.map((agentId, i) => ({
      key: agentId,
      label: agentId,
      color: palette[i % palette.length],
    }));
    if (hasTail) {
      built.push({ key: OTHER, label: t('usage.other_agents'), color: token('--text-muted') });
    }

    const byMonth = new Map((report.months || []).map(m => [m, { month: m }]));
    for (const cell of report.rows || []) {
      const bucket = byMonth.get(cell.month);
      if (!bucket) continue;
      const key = top.includes(cell.agent_id) ? cell.agent_id : OTHER;
      bucket[key] = (bucket[key] || 0) + cell.usd_cents;
    }

    return { data: [...byMonth.values()], series: built };
  }, [report, t]);

  // recharts wants literal colours; the surface colour doubles as the 2px gap
  // between stacked segments (a gap, not a contrasting border).
  const surface = token('--bg-card');
  const grid = token('--border');
  const ink = token('--text-muted');

  const dollars = (cents) => `$${((cents || 0) / 100).toFixed(2)}`;

  return (
    <div style={{ width: '100%', height: 260 }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="0" stroke={grid} vertical={false} />
          <XAxis dataKey="month" tick={{ fill: ink, fontSize: 12 }} stroke={grid} tickLine={false} />
          <YAxis tickFormatter={dollars} tick={{ fill: ink, fontSize: 12 }} stroke={grid} tickLine={false} width={64} />
          <Tooltip
            formatter={(value, name) => [dollars(value), name]}
            labelFormatter={(m) => t('usage.chart_tooltip_month', { month: m })}
            contentStyle={{
              background: surface,
              border: `1px solid ${grid}`,
              borderRadius: 8,
              fontSize: 12,
            }}
            cursor={{ fill: token('--bg-card-hover'), opacity: 0.4 }}
          />
          {/* One series needs no legend box — the card title names it. */}
          {series.length > 1 && (
            <Legend wrapperStyle={{ fontSize: 12, color: ink }} iconType="circle" iconSize={8} />
          )}
          {series.map((s, i) => (
            <Bar
              key={s.key}
              dataKey={s.key}
              name={s.label}
              stackId="spend"
              fill={s.color}
              stroke={surface}
              strokeWidth={2}
              radius={i === series.length - 1 ? [4, 4, 0, 0] : 0}
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
