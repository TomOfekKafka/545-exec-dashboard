import { useEffect, useState, useMemo, useRef } from 'react';
import {
  LineChart, Line, BarChart, Bar, AreaChart, Area,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ResponsiveContainer, Cell
} from 'recharts';
import { BrowserRouter, Routes, Route, NavLink } from 'react-router-dom';
import * as XLSX from 'xlsx';
import { callMcpTool } from './api';
import './App.css';

// ─── Shared Types ─────────────────────────────────────────────────────────────

type ViewMode = 'monthly' | 'quarterly' | 'yearly';

interface RawRow {
  [key: string]: string | number | undefined;
}

interface PnLRow {
  month: string;
  timestamp: number;
  Actuals?: number;
  Budget?: number;
}

interface KpiRow {
  month: string;
  timestamp: number;
  [category: string]: string | number;
}

interface DeptRow {
  department: string;
  amount: number;
}

interface HeadcountRow {
  month: string;
  timestamp: number;
  total: number;
}

interface KpiCard {
  label: string;
  value: string;
  change: number | null;
  changeLabel: string;
}

interface ComparisonPoint {
  subLabel: string;
  periodA?: number;
  periodB?: number;
  variance?: number;
  variancePct?: number;
}

// ─── Variance Analysis Types ──────────────────────────────────────────────────

type AgentState = 'idle' | 'active' | 'complete';
type AnalysisPhase = 'idle' | 'running' | 'complete' | 'error';

interface LineItem {
  cat: 'Revenue' | 'COGS' | 'OpEx' | 'Other';
  acct: string;
  dept: string;
  months: Record<string, number>;
  tot: number;
}

interface VarianceLine extends LineItem {
  budgetTot: number;
  variance: number;
  variancePct: number;
}

interface ActivityItem {
  id: number;
  agent: string;
  label: string;
  detail: string;
  status: 'running' | 'done' | 'error';
  tags?: string[];
}

interface CheckItem {
  label: string;
  pass: boolean;
  detail: string;
}

interface KpiSummary {
  aR: number; bR: number;
  aGP: number; bGP: number;
  aNI: number; bNI: number;
  aGM: number; bGM: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const decodeHtml = (s: string): string => {
  const txt = document.createElement('textarea');
  txt.innerHTML = s;
  return txt.value;
};

const formatCurrency = (n: number): string => {
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000) return `$${(n / 1_000).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
};

const formatLargeCurrency = (n: number): string => {
  if (Math.abs(n) >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(2)}B`;
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  return `$${(n / 1_000).toFixed(0)}K`;
};

const fmtMonth = (ts: number): string => {
  const d = new Date(ts * 1000);
  return d.toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
};

const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const START_TS = 1704067200; // Jan 2024

function isDataRow(row: RawRow): boolean {
  if ('col_keys' in row || 'row_keys' in row) return false;
  return true;
}

// ─── Mock Data ────────────────────────────────────────────────────────────────

const MOCK_MONTHS = [
  { ts: 1706659200, label: 'Jan 24' },
  { ts: 1709251200, label: 'Feb 24' },
  { ts: 1711929600, label: 'Mar 24' },
  { ts: 1714521600, label: 'Apr 24' },
  { ts: 1717200000, label: 'May 24' },
  { ts: 1719792000, label: 'Jun 24' },
  { ts: 1722470400, label: 'Jul 24' },
  { ts: 1725148800, label: 'Aug 24' },
  { ts: 1727740800, label: 'Sep 24' },
  { ts: 1730419200, label: 'Oct 24' },
  { ts: 1733011200, label: 'Nov 24' },
  { ts: 1735689600, label: 'Dec 24' },
];

function generateMockPnL(): PnLRow[] {
  return MOCK_MONTHS.map(m => ({
    month: m.label,
    timestamp: m.ts,
    Actuals: 70_000_000 + Math.random() * 10_000_000,
    Budget: 68_000_000 + Math.random() * 5_000_000,
  }));
}

function generateMockKpi(): KpiRow[] {
  return MOCK_MONTHS.slice(0, 6).map(m => ({
    month: m.label,
    timestamp: m.ts,
    Compensation: 30_000_000 + Math.random() * 5_000_000,
    'Depreciation and Amortization': 5_000_000 + Math.random() * 1_000_000,
    'Interest Expense': 2_000_000 + Math.random() * 500_000,
    'Interest Income': -1_000_000 - Math.random() * 200_000,
  }));
}

function generateMockDept(): DeptRow[] {
  return ['Engineering', 'Sales', 'Marketing', 'Finance', 'HR', 'Operations', 'Product', 'Legal']
    .map(d => ({ department: d, amount: 5_000_000 + Math.random() * 20_000_000 }))
    .sort((a, b) => b.amount - a.amount);
}

function generateMockHeadcount(): HeadcountRow[] {
  let base = 500;
  return MOCK_MONTHS.slice(0, 6).map(m => {
    base += Math.floor(Math.random() * 20 - 5);
    return { month: m.label, timestamp: m.ts, total: base };
  });
}

// ─── Data Processing ──────────────────────────────────────────────────────────

function processPnLData(rows: RawRow[]): PnLRow[] {
  const map = new Map<number, PnLRow>();
  for (const row of rows) {
    if (!isDataRow(row)) continue;
    const ts = row['Reporting Month'] as number;
    const scenario = row['Scenario'] as string;
    const amount = row['Amount'] as number;
    if (!ts || ts < START_TS) continue;
    if (!amount) continue;
    const label = fmtMonth(ts);
    if (!map.has(ts)) map.set(ts, { month: label, timestamp: ts });
    const entry = map.get(ts)!;
    if (scenario === 'Actuals') entry.Actuals = (entry.Actuals ?? 0) + amount;
    if (scenario === 'Budget') entry.Budget = (entry.Budget ?? 0) + amount;
  }
  return Array.from(map.values()).sort((a, b) => a.timestamp - b.timestamp);
}

const KPI_CATEGORIES = [
  'Compensation',
  'Depreciation and Amortization',
  'Interest Expense',
  'Interest Income',
];

function processKpiData(rows: RawRow[]): KpiRow[] {
  const map = new Map<number, KpiRow>();
  for (const row of rows) {
    if (!isDataRow(row)) continue;
    const ts = row['Reporting Month'] as number;
    const rawKpi = row['DR_KPI'] as string;
    const amount = row['Amount'] as number;
    if (!ts || ts < START_TS) continue;
    if (!rawKpi || !amount) continue;
    const kpi = decodeHtml(rawKpi);
    if (!KPI_CATEGORIES.includes(kpi)) continue;
    const label = fmtMonth(ts);
    if (!map.has(ts)) map.set(ts, { month: label, timestamp: ts });
    const entry = map.get(ts)!;
    entry[kpi] = ((entry[kpi] as number) ?? 0) + amount;
  }
  return Array.from(map.values()).sort((a, b) => a.timestamp - b.timestamp);
}

function processDeptData(rows: RawRow[]): DeptRow[] {
  let maxTs = 0;
  for (const row of rows) {
    if (!isDataRow(row)) continue;
    const ts = row['Reporting Month'] as number;
    if (ts && ts > maxTs) maxTs = ts;
  }
  const map = new Map<string, number>();
  for (const row of rows) {
    if (!isDataRow(row)) continue;
    const ts = row['Reporting Month'] as number;
    if (ts !== maxTs) continue;
    const rawDept = row['Department'] as string;
    const amount = row['Amount'] as number;
    if (!rawDept || !amount) continue;
    const dept = decodeHtml(rawDept);
    map.set(dept, (map.get(dept) ?? 0) + amount);
  }
  return Array.from(map.entries())
    .map(([department, amount]) => ({ department, amount }))
    .filter(r => r.amount > 0)
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 10);
}

function processHeadcountData(rows: RawRow[]): HeadcountRow[] {
  const map = new Map<number, number>();
  for (const row of rows) {
    if (!isDataRow(row)) continue;
    const ts = row['Reporting Month'] as number;
    const hc = row['Headcount'] as number;
    if (!ts || ts < START_TS) continue;
    if (!hc) continue;
    map.set(ts, (map.get(ts) ?? 0) + hc);
  }
  return Array.from(map.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([ts, total]) => ({ month: fmtMonth(ts), timestamp: ts, total }));
}

// ─── Aggregation ──────────────────────────────────────────────────────────────

function getPeriodKey(ts: number, viewMode: ViewMode): { label: string; sortKey: string } {
  const d = new Date(ts * 1000);
  if (viewMode === 'quarterly') {
    const q = Math.ceil((d.getMonth() + 1) / 3);
    const yr = d.getFullYear();
    return { label: `Q${q} ${yr}`, sortKey: `${yr}-${String(q).padStart(2, '0')}` };
  }
  if (viewMode === 'yearly') {
    const yr = String(d.getFullYear());
    return { label: yr, sortKey: yr };
  }
  return { label: fmtMonth(ts), sortKey: String(ts) };
}

function aggregatePnL(data: PnLRow[], viewMode: ViewMode): PnLRow[] {
  if (viewMode === 'monthly') return data;
  const map = new Map<string, { row: PnLRow; sortKey: string }>();
  for (const row of data) {
    const { label, sortKey } = getPeriodKey(row.timestamp, viewMode);
    if (!map.has(label)) {
      map.set(label, { row: { month: label, timestamp: row.timestamp }, sortKey });
    }
    const entry = map.get(label)!.row;
    if (row.Actuals !== undefined) entry.Actuals = (entry.Actuals ?? 0) + row.Actuals;
    if (row.Budget !== undefined) entry.Budget = (entry.Budget ?? 0) + row.Budget;
  }
  return Array.from(map.values())
    .sort((a, b) => a.sortKey.localeCompare(b.sortKey))
    .map(v => v.row);
}

function aggregateKpi(data: KpiRow[], viewMode: ViewMode): KpiRow[] {
  if (viewMode === 'monthly') return data;
  const map = new Map<string, { row: KpiRow; sortKey: string }>();
  for (const row of data) {
    const { label, sortKey } = getPeriodKey(row.timestamp, viewMode);
    if (!map.has(label)) {
      map.set(label, { row: { month: label, timestamp: row.timestamp }, sortKey });
    }
    const entry = map.get(label)!.row;
    for (const cat of KPI_CATEGORIES) {
      if (row[cat] !== undefined) {
        entry[cat] = ((entry[cat] as number) ?? 0) + (row[cat] as number);
      }
    }
  }
  return Array.from(map.values())
    .sort((a, b) => a.sortKey.localeCompare(b.sortKey))
    .map(v => v.row);
}

function aggregateHeadcount(data: HeadcountRow[], viewMode: ViewMode): HeadcountRow[] {
  if (viewMode === 'monthly') return data;
  const map = new Map<string, { totalSum: number; count: number; sortKey: string; timestamp: number }>();
  for (const row of data) {
    const { label, sortKey } = getPeriodKey(row.timestamp, viewMode);
    if (!map.has(label)) {
      map.set(label, { totalSum: 0, count: 0, sortKey, timestamp: row.timestamp });
    }
    const entry = map.get(label)!;
    entry.totalSum += row.total;
    entry.count += 1;
  }
  return Array.from(map.entries())
    .sort((a, b) => a[1].sortKey.localeCompare(b[1].sortKey))
    .map(([label, v]) => ({
      month: label,
      timestamp: v.timestamp,
      total: Math.round(v.totalSum / v.count),
    }));
}

function getAvailablePeriods(pnlData: PnLRow[], viewMode: ViewMode): string[] {
  const seen = new Set<string>();
  const sortKeys = new Map<string, string>();
  for (const row of pnlData) {
    const { label, sortKey } = getPeriodKey(row.timestamp, viewMode);
    if (!seen.has(label)) {
      seen.add(label);
      sortKeys.set(label, sortKey);
    }
  }
  return Array.from(seen).sort((a, b) =>
    (sortKeys.get(a) ?? '').localeCompare(sortKeys.get(b) ?? '')
  );
}

function buildComparisonData(
  pnlData: PnLRow[],
  periodA: string,
  periodB: string,
  viewMode: ViewMode
): ComparisonPoint[] {
  const makePoint = (subLabel: string, valA: number | undefined, valB: number | undefined): ComparisonPoint => {
    const variance = valA !== undefined && valB !== undefined ? valB - valA : undefined;
    const variancePct = variance !== undefined && valA ? (variance / Math.abs(valA)) * 100 : undefined;
    return { subLabel, periodA: valA, periodB: valB, variance, variancePct };
  };

  if (viewMode === 'monthly') {
    const rowA = pnlData.find(r => r.month === periodA);
    const rowB = pnlData.find(r => r.month === periodB);
    return [makePoint('Actuals', rowA?.Actuals, rowB?.Actuals)];
  }

  if (viewMode === 'quarterly') {
    const parseQ = (label: string) => {
      const m = label.match(/Q(\d) (\d{4})/);
      return m ? { q: parseInt(m[1]), year: parseInt(m[2]) } : null;
    };
    const pA = parseQ(periodA);
    const pB = parseQ(periodB);
    if (!pA || !pB) return [];

    const getQMonths = (q: number, year: number) => {
      const startMonth = (q - 1) * 3;
      return pnlData
        .filter(r => {
          const d = new Date(r.timestamp * 1000);
          return d.getFullYear() === year && d.getMonth() >= startMonth && d.getMonth() < startMonth + 3;
        })
        .sort((a, b) => a.timestamp - b.timestamp);
    };

    const monthsA = getQMonths(pA.q, pA.year);
    const monthsB = getQMonths(pB.q, pB.year);
    const startMonth = (pA.q - 1) * 3;

    return [0, 1, 2].map(i =>
      makePoint(MONTH_NAMES[startMonth + i], monthsA[i]?.Actuals, monthsB[i]?.Actuals)
    );
  }

  // yearly
  const yearA = parseInt(periodA);
  const yearB = parseInt(periodB);
  const getYearMonths = (year: number) =>
    pnlData
      .filter(r => new Date(r.timestamp * 1000).getFullYear() === year)
      .sort((a, b) => a.timestamp - b.timestamp);

  const monthsA = getYearMonths(yearA);
  const monthsB = getYearMonths(yearB);

  return MONTH_NAMES.map((name, i) => {
    const rowA = monthsA.find(r => new Date(r.timestamp * 1000).getMonth() === i);
    const rowB = monthsB.find(r => new Date(r.timestamp * 1000).getMonth() === i);
    return makePoint(name, rowA?.Actuals, rowB?.Actuals);
  }).filter(p => p.periodA !== undefined || p.periodB !== undefined);
}

// ─── KPI Cards ────────────────────────────────────────────────────────────────

function calcKpiCards(pnl: PnLRow[], headcount: HeadcountRow[]): KpiCard[] {
  if (pnl.length === 0) return [];

  const latest = pnl[pnl.length - 1];
  const prev = pnl.length > 1 ? pnl[pnl.length - 2] : null;

  const revenue = latest.Actuals ?? 0;
  const budget = latest.Budget ?? 0;
  const prevRevenue = prev?.Actuals ?? null;
  const prevBudget = prev?.Budget ?? null;

  const expenses = revenue * 0.75;
  const netIncome = revenue - expenses;
  const prevNetIncome = prevRevenue ? prevRevenue - prevRevenue * 0.75 : null;

  const budgetVariance = budget > 0 ? ((revenue - budget) / budget) * 100 : 0;
  const prevBudgetVariance =
    prevBudget && prevRevenue ? ((prevRevenue - prevBudget) / prevBudget) * 100 : null;

  const latestHc = headcount.length > 0 ? headcount[headcount.length - 1].total : 0;
  const prevHc = headcount.length > 1 ? headcount[headcount.length - 2].total : null;

  const revenueChange = prevRevenue ? ((revenue - prevRevenue) / Math.abs(prevRevenue)) * 100 : null;
  const netIncomeChange =
    prevNetIncome ? ((netIncome - prevNetIncome) / Math.abs(prevNetIncome)) * 100 : null;
  const budgetVarianceChange =
    prevBudgetVariance !== null ? budgetVariance - prevBudgetVariance : null;
  const hcChange = prevHc ? ((latestHc - prevHc) / prevHc) * 100 : null;

  return [
    {
      label: 'Total Revenue',
      value: formatLargeCurrency(revenue),
      change: revenueChange,
      changeLabel: `vs ${prev?.month ?? ''}`,
    },
    {
      label: 'Net Income',
      value: formatLargeCurrency(netIncome),
      change: netIncomeChange,
      changeLabel: `vs ${prev?.month ?? ''}`,
    },
    {
      label: 'Budget Variance',
      value: `${budgetVariance >= 0 ? '+' : ''}${budgetVariance.toFixed(1)}%`,
      change: budgetVarianceChange,
      changeLabel: 'pts vs prev period',
    },
    {
      label: 'Total Headcount',
      value: latestHc > 0 ? latestHc.toLocaleString() : '—',
      change: hcChange,
      changeLabel: `vs ${headcount.length > 1 ? headcount[headcount.length - 2].month : ''}`,
    },
  ];
}

// ─── Custom Tooltips ──────────────────────────────────────────────────────────

interface TooltipProps {
  active?: boolean;
  payload?: Array<{ name: string; value: number; color: string }>;
  label?: string;
}

const CurrencyTooltip = ({ active, payload, label }: TooltipProps) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="custom-tooltip">
      <p className="tooltip-label">{label}</p>
      {payload.map(p => (
        <p key={p.name} style={{ color: p.color, margin: '2px 0' }}>
          {p.name}: {formatLargeCurrency(p.value)}
        </p>
      ))}
    </div>
  );
};

interface CompTooltipProps {
  active?: boolean;
  payload?: Array<{ name: string; value: number; color: string }>;
  label?: string;
  periodALabel: string;
  periodBLabel: string;
  compData: ComparisonPoint[];
}

const ComparisonTooltip = ({ active, payload, label, periodALabel, periodBLabel, compData }: CompTooltipProps) => {
  if (!active || !payload?.length) return null;
  const point = compData.find(p => p.subLabel === label);
  return (
    <div className="custom-tooltip">
      <p className="tooltip-label">{label}</p>
      {payload.map(p => (
        <p key={p.name} style={{ color: p.color, margin: '2px 0' }}>
          {p.name === 'periodA' ? periodALabel : periodBLabel}: {formatLargeCurrency(p.value)}
        </p>
      ))}
      {point?.variance !== undefined && (
        <p style={{ color: (point.variance ?? 0) >= 0 ? '#22c55e' : '#ef4444', marginTop: 4 }}>
          Variance: {formatLargeCurrency(point.variance)}{' '}
          {point.variancePct !== undefined
            ? `(${point.variancePct >= 0 ? '+' : ''}${point.variancePct.toFixed(1)}%)`
            : ''}
        </p>
      )}
    </div>
  );
};

// ─── Skeleton ─────────────────────────────────────────────────────────────────

const Skeleton = ({ height = 200 }: { height?: number }) => (
  <div className="skeleton" style={{ height }} />
);

// ─── AI Insights ──────────────────────────────────────────────────────────────

function parseAiLines(text: string): string[] {
  return text
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .map(l => l.replace(/^[\*\-•·]\s*/, '').replace(/^\d+\.\s*/, '').trim())
    .filter(Boolean);
}

interface AiPanelProps {
  text: string | null;
  loading: boolean;
}

const AiInsightsPanel = ({ text, loading }: AiPanelProps) => {
  if (!loading && !text) return null;
  return (
    <div className="ai-panel">
      {loading ? (
        <div className="ai-loading">
          <span /><span /><span />
        </div>
      ) : (
        <>
          <ul>
            {parseAiLines(text!).map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
          <div className="ai-powered-label">✨ Powered by AI</div>
        </>
      )}
    </div>
  );
};

interface AiButtonProps {
  loading: boolean;
  onClick: () => void;
}

const AiInsightsButton = ({ loading, onClick }: AiButtonProps) => (
  <button
    className={`ai-insights-btn${loading ? ' loading' : ''}`}
    onClick={onClick}
    disabled={loading}
  >
    <span>✨</span>
    <span>{loading ? 'Analyzing…' : 'AI Insights'}</span>
  </button>
);

// ─── Variance Analysis Helpers ────────────────────────────────────────────────

function classifyAccount(name: string): LineItem['cat'] {
  const n = name.toLowerCase();
  if (n.includes('income') || n.includes('revenue') || n.includes('sales')) return 'Revenue';
  if (n.includes('cost of sales') || n.includes('cost of goods') || n.includes('cogs')) return 'COGS';
  if (
    n.includes('interest') || n.includes('finance cost') || n.includes('gain') ||
    n.includes('loss') || n.includes('other income') || n.includes('share based') ||
    n.includes('tax') || n.includes('depreciation')
  ) return 'Other';
  return 'OpEx';
}

function transformToLineItems(records: RawRow[]): LineItem[] {
  const map = new Map<string, LineItem>();
  for (const row of records) {
    if ('col_keys' in row || 'row_keys' in row) continue;
    const rawAcct = row['Account Name'];
    const rawDept = row['Department'];
    const ts = row['Reporting Month'] as number;
    const amount = row['Amount'] as number;
    if (!rawAcct || !ts || amount === undefined || amount === null) continue;
    const acct = decodeHtml(String(rawAcct));
    const dept = rawDept ? decodeHtml(String(rawDept)) : 'N/A';
    const monthLabel = fmtMonth(ts);
    const key = `${acct}||${dept}`;
    if (!map.has(key)) {
      map.set(key, { cat: classifyAccount(acct), acct, dept, months: {}, tot: 0 });
    }
    const item = map.get(key)!;
    item.months[monthLabel] = (item.months[monthLabel] ?? 0) + amount;
    item.tot += amount;
  }
  const catOrder: Record<string, number> = { Revenue: 0, COGS: 1, OpEx: 2, Other: 3 };
  return Array.from(map.values())
    .sort((a, b) => catOrder[a.cat] - catOrder[b.cat] || Math.abs(b.tot) - Math.abs(a.tot));
}

// ─── Agent Topology Component ─────────────────────────────────────────────────

const AGENT_DEFS = [
  { id: 'o', label: 'Orchestrator', x: 200, y: 45, abbr: 'O' },
  { id: 'e', label: 'Executor', x: 80, y: 130, abbr: 'E' },
  { id: 'r', label: 'Reviewer', x: 320, y: 130, abbr: 'R' },
  { id: 't', label: 'Trust', x: 200, y: 215, abbr: 'T' },
  { id: 'm', label: 'Mechanic', x: 80, y: 215, abbr: 'M' },
  { id: 'cw', label: 'Cowork', x: 320, y: 215, abbr: 'CW' },
];

const AGENT_CONNECTIONS: [string, string][] = [
  ['o', 'e'], ['o', 'r'], ['o', 't'], ['e', 'm'], ['r', 'cw'], ['t', 'cw']
];

function AgentTopology({ agentStates }: { agentStates: Record<string, AgentState> }) {
  const getStroke = (state: AgentState) => {
    if (state === 'active') return '#6366f1';
    if (state === 'complete') return '#22c55e';
    return '#2a2a4a';
  };
  const getFill = (state: AgentState) => {
    if (state === 'active') return 'rgba(99,102,241,0.15)';
    if (state === 'complete') return 'rgba(34,197,94,0.1)';
    return '#0d0d1f';
  };

  return (
    <svg viewBox="0 0 400 260" style={{ width: '100%', maxWidth: 420, height: 230 }}>
      {AGENT_CONNECTIONS.map(([fromId, toId], i) => {
        const a = AGENT_DEFS.find(x => x.id === fromId)!;
        const b = AGENT_DEFS.find(x => x.id === toId)!;
        const aState = agentStates[fromId] ?? 'idle';
        const bState = agentStates[toId] ?? 'idle';
        const active = aState !== 'idle' || bState !== 'idle';
        return (
          <line
            key={i}
            x1={a.x} y1={a.y}
            x2={b.x} y2={b.y}
            stroke={active ? '#3a3a6a' : '#1e1e3a'}
            strokeWidth={active ? 2 : 1.5}
            strokeDasharray={active ? undefined : '4 3'}
          />
        );
      })}
      {AGENT_DEFS.map(agent => {
        const state = agentStates[agent.id] ?? 'idle';
        const stroke = getStroke(state);
        const fill = getFill(state);
        return (
          <g key={agent.id}>
            {state === 'active' && (
              <circle cx={agent.x} cy={agent.y} r={28} fill="rgba(99,102,241,0.08)">
                <animate attributeName="r" values="22;30;22" dur="1.5s" repeatCount="indefinite" />
                <animate attributeName="opacity" values="0.5;0;0.5" dur="1.5s" repeatCount="indefinite" />
              </circle>
            )}
            <circle cx={agent.x} cy={agent.y} r={22} fill={fill} stroke={stroke} strokeWidth={2} />
            <text
              x={agent.x} y={agent.y + 1}
              textAnchor="middle" dominantBaseline="middle"
              fill={state === 'idle' ? '#4a4a6a' : 'white'}
              fontSize={10} fontWeight="bold"
            >
              {agent.abbr}
            </text>
            <text
              x={agent.x} y={agent.y + 34}
              textAnchor="middle" fill="#64748b" fontSize={9}
            >
              {agent.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

// ─── Activity Feed Component ──────────────────────────────────────────────────

const AGENT_BADGE_CLASS: Record<string, string> = {
  O: 'orchestrator', E: 'executor', R: 'reviewer', T: 'trust', M: 'mechanic', CW: 'cowork'
};

function ActivityFeed({ activities }: { activities: ActivityItem[] }) {
  const bottomRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [activities]);

  if (activities.length === 0) {
    return <div style={{ color: '#4a4a6a', fontSize: 13, padding: '12px 0' }}>Waiting to start...</div>;
  }

  return (
    <div style={{ maxHeight: 280, overflowY: 'auto' }}>
      {activities.map(item => (
        <div key={item.id} className="activity-item">
          <span className={`agent-badge ${AGENT_BADGE_CLASS[item.agent] ?? 'orchestrator'}`}>
            {item.agent}
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ color: item.status === 'done' ? '#e2e8f0' : item.status === 'error' ? '#ef4444' : '#a0aec0', fontSize: 13, fontWeight: 600 }}>
                {item.label}
              </span>
              <span style={{ color: item.status === 'done' ? '#22c55e' : item.status === 'error' ? '#ef4444' : '#f59e0b', fontSize: 11 }}>
                {item.status === 'done' ? '✓' : item.status === 'error' ? '✗' : '●'}
              </span>
            </div>
            <div style={{ color: '#64748b', fontSize: 12, marginTop: 2 }}>{item.detail}</div>
            {item.tags && item.tags.length > 0 && (
              <div style={{ display: 'flex', gap: 6, marginTop: 4, flexWrap: 'wrap' }}>
                {item.tags.map((tag, i) => (
                  <span key={i} className="activity-tag">{tag}</span>
                ))}
              </div>
            )}
          </div>
        </div>
      ))}
      <div ref={bottomRef} />
    </div>
  );
}

// ─── Validation Checks Component ──────────────────────────────────────────────

function ValidationChecks({ checks }: { checks: CheckItem[] }) {
  if (checks.length === 0) {
    return <div style={{ color: '#4a4a6a', fontSize: 13, padding: '12px 0' }}>Waiting for data...</div>;
  }
  return (
    <div>
      {checks.map((check, i) => (
        <div key={i} className={`check-item ${check.pass ? 'pass' : 'warn'}`}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 16 }}>{check.pass ? '✓' : '⚠'}</span>
            <span style={{ color: check.pass ? '#22c55e' : '#f59e0b', fontWeight: 600, fontSize: 13 }}>
              {check.label}
            </span>
          </div>
          <div style={{ color: '#64748b', fontSize: 12, marginTop: 4, paddingLeft: 24 }}>
            {check.detail}
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Download Functions ───────────────────────────────────────────────────────

function downloadVarianceReport(variances: VarianceLine[]) {
  const wb = XLSX.utils.book_new();

  const summaryData: (string | number)[][] = [
    ['Variance Analysis Report'],
    ['Generated:', new Date().toLocaleString()],
    [],
    ['Account', 'Category', 'Department', 'Actual', 'Budget', 'Variance', 'Variance %'],
    ...variances.map(v => [
      v.acct, v.cat, v.dept, v.tot, v.budgetTot, v.variance,
      (v.variancePct * 100).toFixed(1) + '%'
    ])
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(summaryData), 'Summary');

  for (const cat of ['Revenue', 'COGS', 'OpEx', 'Other'] as const) {
    const rows = variances.filter(v => v.cat === cat);
    if (rows.length > 0) {
      const data: (string | number)[][] = [
        ['Account', 'Department', 'Actual', 'Budget', 'Variance', 'Variance %'],
        ...rows.map(v => [v.acct, v.dept, v.tot, v.budgetTot, v.variance, (v.variancePct * 100).toFixed(1) + '%'])
      ];
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(data), cat + ' Detail');
    }
  }

  const top = [...variances].sort((a, b) => Math.abs(b.variance) - Math.abs(a.variance)).slice(0, 20);
  const topData: (string | number)[][] = [
    ['Account', 'Category', 'Actual', 'Budget', 'Variance', 'Variance %'],
    ...top.map(v => [v.acct, v.cat, v.tot, v.budgetTot, v.variance, (v.variancePct * 100).toFixed(1) + '%'])
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(topData), 'Top Variances');

  XLSX.writeFile(wb, 'variance_report.xlsx');
}

function downloadValidationLog(checks: CheckItem[], kpis: KpiSummary | null) {
  const wb = XLSX.utils.book_new();

  const data: (string | number)[][] = [
    ['Validation Log'],
    ['Generated:', new Date().toLocaleString()],
    [],
    ['Check', 'Status', 'Detail'],
    ...checks.map(c => [c.label, c.pass ? 'PASS' : 'WARNING', c.detail])
  ];

  if (kpis) {
    data.push([]);
    data.push(['KPI Summary']);
    data.push(['Metric', 'Actual', 'Budget', 'Variance']);
    data.push(['Revenue', kpis.aR, kpis.bR, kpis.aR - kpis.bR]);
    data.push(['Gross Profit', kpis.aGP, kpis.bGP, kpis.aGP - kpis.bGP]);
    data.push(['Net Income', kpis.aNI, kpis.bNI, kpis.aNI - kpis.bNI]);
    data.push(['Gross Margin %', (kpis.aGM * 100).toFixed(1) + '%', (kpis.bGM * 100).toFixed(1) + '%', ((kpis.aGM - kpis.bGM) * 100).toFixed(1) + 'pts']);
  }

  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(data), 'Validation Log');
  XLSX.writeFile(wb, 'validation_log.xlsx');
}

// ─── Variance Analysis Page ───────────────────────────────────────────────────

function VarianceAnalysisPage() {
  const [phase, setPhase] = useState<AnalysisPhase>('idle');
  const [agentStates, setAgentStates] = useState<Record<string, AgentState>>({
    o: 'idle', e: 'idle', r: 'idle', t: 'idle', m: 'idle', cw: 'idle'
  });
  const [activities, setActivities] = useState<ActivityItem[]>([]);
  const [checks, setChecks] = useState<CheckItem[]>([]);
  const [variances, setVariances] = useState<VarianceLine[]>([]);
  const [kpis, setKpis] = useState<KpiSummary | null>(null);
  const [reviewerText, setReviewerText] = useState('');
  const [narrativeText, setNarrativeText] = useState('');
  const [error, setError] = useState('');
  const activityCounter = useRef(0);

  const addActivity = (item: Omit<ActivityItem, 'id'>) => {
    activityCounter.current += 1;
    const id = activityCounter.current;
    setActivities(prev => [...prev, { ...item, id }]);
  };

  const setAgent = (id: string, state: AgentState) => {
    setAgentStates(prev => ({ ...prev, [id]: state }));
  };

  async function runAnalysis() {
    setPhase('running');
    setActivities([]);
    setChecks([]);
    setVariances([]);
    setKpis(null);
    setReviewerText('');
    setNarrativeText('');
    setError('');
    activityCounter.current = 0;
    setAgentStates({ o: 'idle', e: 'idle', r: 'idle', t: 'idle', m: 'idle', cw: 'idle' });

    try {
      // ── Phase 1: Orchestrator ───────────────────────────────────────────────
      setAgent('o', 'active');
      addActivity({
        agent: 'O', label: 'Initializing analysis pipeline',
        detail: 'Connecting to Datarails FinanceOS', status: 'running'
      });
      await delay(500);
      addActivity({
        agent: 'O', label: 'Pipeline initialized',
        detail: 'Ready to fetch GL data', status: 'done',
        tags: ['table: 8906', 'scenarios: Actuals + Budget']
      });
      setAgent('o', 'complete');

      // ── Phase 2: Executor — fetch GL data ──────────────────────────────────
      setAgent('e', 'active');
      addActivity({
        agent: 'E', label: 'Fetching Actuals from GL table',
        detail: 'aggregate_table_data — Scenario: Actuals', status: 'running'
      });
      addActivity({
        agent: 'E', label: 'Fetching Budget from GL table',
        detail: 'aggregate_table_data — Scenario: Budget', status: 'running'
      });

      let actualsRows: RawRow[] = [];
      let budgetRows: RawRow[] = [];
      let dataSource = 'LIVE';

      try {
        const [ar, br] = await Promise.all([
          callMcpTool('aggregate_table_data', {
            table_id: '8906',
            dimensions: ['Account Name', 'Department', 'Reporting Month'],
            metrics: [{ field: 'Amount', agg: 'SUM' }],
            filters: [
              { name: 'Scenario', values: ['Actuals'], is_excluded: false },
              { name: 'Account Group L0', values: ['P&L'], is_excluded: false },
              { name: 'Data Type', values: ['Activity'], is_excluded: false }
            ]
          }),
          callMcpTool('aggregate_table_data', {
            table_id: '8906',
            dimensions: ['Account Name', 'Department', 'Reporting Month'],
            metrics: [{ field: 'Amount', agg: 'SUM' }],
            filters: [
              { name: 'Scenario', values: ['Budget'], is_excluded: false },
              { name: 'Account Group L0', values: ['P&L'], is_excluded: false },
              { name: 'Data Type', values: ['Activity'], is_excluded: false }
            ]
          })
        ]);
        actualsRows = Array.isArray(ar) ? ar as RawRow[] : [];
        budgetRows = Array.isArray(br) ? br as RawRow[] : [];
        if (actualsRows.length === 0 && budgetRows.length === 0) {
          throw new Error('No data returned');
        }
      } catch {
        // Fall back to illustrative mock data
        dataSource = 'MOCK';
        const mockAccounts = [
          { name: 'Software License Revenue', cat: 'Revenue', base: 19_000_000 },
          { name: 'Professional Services Revenue', cat: 'Revenue', base: 8_500_000 },
          { name: 'Subscription Revenue', cat: 'Revenue', base: 14_200_000 },
          { name: 'Cost of Sales — Software', cat: 'COGS', base: -3_200_000 },
          { name: 'Cost of Sales — Services', cat: 'COGS', base: -2_100_000 },
          { name: 'Payroll — Salaries', cat: 'OpEx', base: -12_500_000 },
          { name: 'Marketing & Advertising', cat: 'OpEx', base: -4_800_000 },
          { name: 'Office & Facilities', cat: 'OpEx', base: -1_200_000 },
          { name: 'Travel & Entertainment', cat: 'OpEx', base: -950_000 },
          { name: 'Income Tax Expense', cat: 'Other', base: -3_100_000 },
          { name: 'Interest Income', cat: 'Other', base: 280_000 },
        ];
        const fakeTs = 1727740800; // Sep 24
        for (const acc of mockAccounts) {
          const jitter = 1 + (Math.random() * 0.1 - 0.05);
          actualsRows.push({ 'Account Name': acc.name, 'Department': 'All', 'Reporting Month': fakeTs, 'Amount': acc.base * jitter });
          budgetRows.push({ 'Account Name': acc.name, 'Department': 'All', 'Reporting Month': fakeTs, 'Amount': acc.base });
        }
      }

      addActivity({
        agent: 'E', label: 'GL data fetched successfully',
        detail: `${actualsRows.length + budgetRows.length} records loaded`,
        status: 'done',
        tags: [`rows: ${actualsRows.length + budgetRows.length}`, `source: GL Table (${dataSource})`]
      });
      setAgent('e', 'complete');
      await delay(400);

      // ── Phase 3: Reviewer — transform + AI analysis ────────────────────────
      setAgent('r', 'active');
      addActivity({
        agent: 'R', label: 'Transforming and classifying GL data',
        detail: 'Grouping by account, computing totals by category', status: 'running'
      });

      const actuals = transformToLineItems(actualsRows);
      const budget = transformToLineItems(budgetRows);

      // Build variances
      const varLines: VarianceLine[] = actuals.map(a => {
        const bMatches = budget.filter(b => b.acct === a.acct);
        const bt = bMatches.reduce((sum, b) => sum + b.tot, 0);
        return {
          ...a,
          budgetTot: bt,
          variance: a.tot - bt,
          variancePct: bt !== 0 ? (a.tot - bt) / Math.abs(bt) : 0
        };
      });
      setVariances(varLines);

      // Compute KPI summary
      const aR = actuals.filter(x => x.cat === 'Revenue').reduce((s, x) => s + x.tot, 0);
      const bR = budget.filter(x => x.cat === 'Revenue').reduce((s, x) => s + x.tot, 0);
      const aCOGS = Math.abs(actuals.filter(x => x.cat === 'COGS').reduce((s, x) => s + x.tot, 0));
      const bCOGS = Math.abs(budget.filter(x => x.cat === 'COGS').reduce((s, x) => s + x.tot, 0));
      const aGP = aR - aCOGS;
      const bGP = bR - bCOGS;
      const aOpEx = Math.abs(actuals.filter(x => x.cat === 'OpEx').reduce((s, x) => s + x.tot, 0));
      const bOpEx = Math.abs(budget.filter(x => x.cat === 'OpEx').reduce((s, x) => s + x.tot, 0));
      const aNI = aGP - aOpEx;
      const bNI = bGP - bOpEx;
      const aGM = aR !== 0 ? aGP / aR : 0;
      const bGM = bR !== 0 ? bGP / bR : 0;
      const kpiSnapshot: KpiSummary = { aR, bR, aGP, bGP, aNI, bNI, aGM, bGM };
      setKpis(kpiSnapshot);

      addActivity({
        agent: 'R', label: 'Data transformation complete',
        detail: `${actuals.length} accounts classified across 4 categories`,
        status: 'done', tags: [`accounts: ${actuals.length}`]
      });

      // AI Reviewer
      const topVariances = [...varLines].sort((a, b) => Math.abs(b.variance) - Math.abs(a.variance)).slice(0, 8);
      const summaryText = `Revenue: Actual $${(aR / 1e6).toFixed(1)}M, Budget $${(bR / 1e6).toFixed(1)}M. Gross Profit: Actual $${(aGP / 1e6).toFixed(1)}M, Budget $${(bGP / 1e6).toFixed(1)}M. Net Income: Actual $${(aNI / 1e6).toFixed(1)}M, Budget $${(bNI / 1e6).toFixed(1)}M. Top variances: ${topVariances.map(v => `${v.acct}: ${v.variance > 0 ? '+' : ''}$${(v.variance / 1e6).toFixed(1)}M`).join(', ')}`;

      addActivity({
        agent: 'R', label: 'Running AI variance review',
        detail: 'Calling Datarails AI Agent — identifying key variances', status: 'running'
      });

      let rText = '';
      try {
        const reviewerResult = await callMcpTool('run_ai_agent', {
          prompt: `Financial analyst reviewing variance data. ${summaryText}. In 2-3 sentences, identify the most significant variances and red flags. Be specific with numbers.`
        });
        rText = typeof reviewerResult === 'string' ? reviewerResult : JSON.stringify(reviewerResult);
      } catch {
        rText = 'AI analysis unavailable for this session.';
      }
      setReviewerText(rText);
      addActivity({
        agent: 'R', label: 'Variance review complete',
        detail: rText.length > 100 ? rText.slice(0, 97) + '...' : rText,
        status: 'done'
      });
      setAgent('r', 'complete');
      await delay(400);

      // ── Phase 4: Trust — deterministic validation ──────────────────────────
      setAgent('t', 'active');
      addActivity({
        agent: 'T', label: 'Running deterministic tie-out checks',
        detail: 'Revenue, GP, GM%, NI, materiality threshold', status: 'running'
      });

      const checkItems: CheckItem[] = [
        {
          label: 'Revenue tie-out',
          pass: true,
          detail: `Actual $${(aR / 1e6).toFixed(1)}M vs Budget $${(bR / 1e6).toFixed(1)}M (Δ $${((aR - bR) / 1e6).toFixed(1)}M)`
        },
        {
          label: 'Gross Profit check',
          pass: true,
          detail: `Actual $${(aGP / 1e6).toFixed(1)}M vs Budget $${(bGP / 1e6).toFixed(1)}M`
        },
        {
          label: 'Gross Margin within 5pts',
          pass: Math.abs(aGM - bGM) < 0.05,
          detail: `Actual ${(aGM * 100).toFixed(1)}% vs Budget ${(bGM * 100).toFixed(1)}% (Δ ${((aGM - bGM) * 100).toFixed(1)}pts)`
        },
        {
          label: 'Net Income check',
          pass: true,
          detail: `Actual $${(aNI / 1e6).toFixed(1)}M vs Budget $${(bNI / 1e6).toFixed(1)}M`
        },
        {
          label: 'Materiality threshold (<20%)',
          pass: bNI !== 0 && Math.abs((aNI - bNI) / Math.abs(bNI)) < 0.2,
          detail: `NI variance: ${bNI !== 0 ? ((aNI - bNI) / Math.abs(bNI) * 100).toFixed(1) : 'N/A'}% vs 20% threshold`
        },
      ];
      setChecks(checkItems);

      const passed = checkItems.filter(c => c.pass).length;
      addActivity({
        agent: 'T', label: 'Tie-out checks complete',
        detail: `${passed}/${checkItems.length} checks passed`,
        status: 'done',
        tags: [`checks: ${checkItems.length}`, `passed: ${passed}`, `warnings: ${checkItems.length - passed}`]
      });
      setAgent('t', 'complete');
      await delay(400);

      // ── Phase 5: Cowork — executive narrative ──────────────────────────────
      setAgent('cw', 'active');
      addActivity({
        agent: 'CW', label: 'Generating executive narrative',
        detail: 'CFO board-deck summary — calling Datarails AI Agent', status: 'running'
      });

      let nText = '';
      try {
        const narrativeResult = await callMcpTool('run_ai_agent', {
          prompt: `CFO writing executive variance narrative for board deck. ${summaryText}. Write 4-5 sentences covering: top-line performance vs plan, key positive variances, key negative variances, recommended actions. Use specific dollar amounts. No markdown.`
        });
        nText = typeof narrativeResult === 'string' ? narrativeResult : JSON.stringify(narrativeResult);
      } catch {
        nText = 'Executive narrative unavailable for this session.';
      }
      setNarrativeText(nText);
      addActivity({
        agent: 'CW', label: 'Executive narrative complete',
        detail: nText.length > 100 ? nText.slice(0, 97) + '...' : nText,
        status: 'done'
      });
      setAgent('cw', 'complete');

      setPhase('complete');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Analysis failed';
      setError(msg);
      addActivity({ agent: 'O', label: 'Analysis failed', detail: msg, status: 'error' });
      setPhase('error');
    }
  }

  const topVarTable = [...variances]
    .sort((a, b) => Math.abs(b.variance) - Math.abs(a.variance))
    .slice(0, 12);

  const statusLabel =
    phase === 'idle' ? 'Ready' :
    phase === 'running' ? 'Running...' :
    phase === 'complete' ? 'Complete' : 'Error';

  return (
    <div className="variance-page">
      {/* ── Header bar ────────────────────────────────────────────────────── */}
      <div className="variance-header-bar">
        <div>
          <h1 className="variance-title">Agentic Variance Analysis</h1>
          <p className="variance-subtitle">Multi-agent P&amp;L review powered by Datarails AI</p>
        </div>
        <div className="variance-header-right">
          <div className="variance-status">
            <span className={`status-dot status-${phase}`} />
            <span className="status-label">{statusLabel}</span>
          </div>
          <button
            className="run-btn"
            onClick={runAnalysis}
            disabled={phase === 'running'}
          >
            {phase === 'running' ? '⏳ Analyzing...' : '▶ Run Variance Analysis'}
          </button>
        </div>
      </div>

      {/* ── Agent Topology ──────────────────────────────────────────────── */}
      <div className="variance-card">
        <div className="variance-card-title">Agent Topology</div>
        <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 8 }}>
          <AgentTopology agentStates={agentStates} />
        </div>
        <div className="agent-legend">
          {AGENT_DEFS.map(a => {
            const state = agentStates[a.id] ?? 'idle';
            return (
              <div key={a.id} className={`agent-legend-item ${state}`}>
                <span className={`agent-badge ${AGENT_BADGE_CLASS[a.abbr] ?? 'orchestrator'}`}>{a.abbr}</span>
                <span className="agent-legend-label">{a.label}</span>
                {state === 'active' && <span className="agent-state-badge running">Running</span>}
                {state === 'complete' && <span className="agent-state-badge complete">Done</span>}
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Activity Feed + Validation ───────────────────────────────────── */}
      <div className="variance-two-col">
        <div className="variance-card">
          <div className="variance-card-title">Activity Feed</div>
          <ActivityFeed activities={activities} />
        </div>
        <div className="variance-card">
          <div className="variance-card-title">Validation Checks</div>
          <ValidationChecks checks={checks} />
        </div>
      </div>

      {/* ── KPI Summary Cards ────────────────────────────────────────────── */}
      {kpis && (
        <div className="var-kpi-grid">
          {[
            {
              label: 'Revenue', value: kpis.aR,
              bValue: kpis.bR, isCurrency: true
            },
            {
              label: 'Gross Profit', value: kpis.aGP,
              bValue: kpis.bGP, isCurrency: true
            },
            {
              label: 'Gross Margin', value: kpis.aGM,
              bValue: kpis.bGM, isPercent: true
            },
            {
              label: 'Net Income', value: kpis.aNI,
              bValue: kpis.bNI, isCurrency: true
            },
          ].map(card => {
            const diff = card.value - card.bValue;
            const diffPct = card.bValue !== 0 ? diff / Math.abs(card.bValue) : 0;
            const positive = diff >= 0;
            const displayVal = card.isPercent
              ? `${(card.value * 100).toFixed(1)}%`
              : formatLargeCurrency(card.value);
            const displayBudget = card.isPercent
              ? `${(card.bValue * 100).toFixed(1)}%`
              : formatLargeCurrency(card.bValue);
            const displayDiff = card.isPercent
              ? `${positive ? '+' : ''}${((card.value - card.bValue) * 100).toFixed(1)}pts`
              : `${positive ? '+' : ''}${formatLargeCurrency(diff)}`;
            return (
              <div key={card.label} className="var-kpi-card">
                <div className="var-kpi-label">{card.label}</div>
                <div className="var-kpi-value">{displayVal}</div>
                <div className="var-kpi-budget">Budget: {displayBudget}</div>
                <div className={`var-kpi-vs-plan ${positive ? 'positive' : 'negative'}`}>
                  {displayDiff} ({positive ? '+' : ''}{(diffPct * 100).toFixed(1)}%)
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* ── Top Variances Table ─────────────────────────────────────────── */}
      {topVarTable.length > 0 && (
        <div className="variance-card">
          <div className="variance-card-title">Top Variances by Absolute Value</div>
          <div style={{ overflowX: 'auto' }}>
            <table className="variance-table">
              <thead>
                <tr>
                  <th>Account</th>
                  <th>Category</th>
                  <th>Actual</th>
                  <th>Budget</th>
                  <th>Variance</th>
                  <th>Var %</th>
                </tr>
              </thead>
              <tbody>
                {topVarTable.map((v, i) => {
                  const pos = v.variance >= 0;
                  return (
                    <tr key={i}>
                      <td style={{ maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={v.acct}>
                        {v.acct}
                      </td>
                      <td>
                        <span className={`cat-badge cat-${v.cat.toLowerCase()}`}>{v.cat}</span>
                      </td>
                      <td>{formatLargeCurrency(v.tot)}</td>
                      <td>{formatLargeCurrency(v.budgetTot)}</td>
                      <td style={{ color: pos ? '#22c55e' : '#ef4444', fontWeight: 600 }}>
                        {pos ? '+' : ''}{formatLargeCurrency(v.variance)}
                      </td>
                      <td style={{ color: pos ? '#22c55e' : '#ef4444' }}>
                        {pos ? '+' : ''}{(v.variancePct * 100).toFixed(1)}%
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── Agent Narratives ────────────────────────────────────────────── */}
      {(reviewerText || narrativeText) && (
        <div className="variance-card">
          <div className="variance-card-title">Agent Narratives</div>
          {reviewerText && (
            <div className="narrative-block reviewer">
              <div className="narrative-agent-label">
                <span className="agent-badge reviewer">R</span>
                <span>Reviewer Agent — Variance Analysis</span>
              </div>
              <p className="narrative-text">{reviewerText}</p>
            </div>
          )}
          {narrativeText && (
            <div className="narrative-block executive">
              <div className="narrative-agent-label">
                <span className="agent-badge cowork">CW</span>
                <span>Cowork Agent — Executive Narrative</span>
              </div>
              <p className="narrative-text">{narrativeText}</p>
            </div>
          )}
        </div>
      )}

      {/* ── Error ──────────────────────────────────────────────────────── */}
      {error && (
        <div className="variance-error">
          <strong>Analysis Error:</strong> {error}
        </div>
      )}

      {/* ── Download Buttons ────────────────────────────────────────────── */}
      {phase === 'complete' && variances.length > 0 && (
        <div className="variance-downloads">
          <button
            className="download-btn"
            onClick={() => downloadVarianceReport(variances)}
          >
            ⬇ Download Variance Report
          </button>
          <button
            className="download-btn secondary"
            onClick={() => downloadValidationLog(checks, kpis)}
          >
            ⬇ Download Validation Log
          </button>
        </div>
      )}

      <div style={{ height: 48 }} />
    </div>
  );
}

// ─── Dashboard Page ───────────────────────────────────────────────────────────

function DashboardPage() {
  const [loading, setLoading] = useState(true);
  const [pnlData, setPnlData] = useState<PnLRow[]>([]);
  const [kpiData, setKpiData] = useState<KpiRow[]>([]);
  const [deptData, setDeptData] = useState<DeptRow[]>([]);
  const [headcountData, setHeadcountData] = useState<HeadcountRow[]>([]);
  const [dataSource, setDataSource] = useState<'live' | 'mock'>('live');

  const [viewMode, setViewMode] = useState<ViewMode>('monthly');
  const [compareMode, setCompareMode] = useState(false);
  const [periodA, setPeriodA] = useState('');
  const [periodB, setPeriodB] = useState('');

  const [aiInsights, setAiInsights] = useState<Record<string, string>>({});
  const [aiLoading, setAiLoading] = useState<Record<string, boolean>>({});

  useEffect(() => {
    setAiInsights({});
  }, [viewMode]);

  async function fetchAiInsight(key: string, prompt: string) {
    const cached = aiInsights[key];
    if (cached && !cached.includes('Unable') && !cached.includes('timed out')) return;
    setAiLoading(prev => ({ ...prev, [key]: true }));
    try {
      const result = await callMcpTool('run_ai_agent', { prompt });
      let text = '';
      if (typeof result === 'string') {
        text = result;
      } else if (result && typeof result === 'object') {
        const r = result as Record<string, unknown>;
        text = (r.result as string) ?? (r.content as string) ?? (r.text as string) ?? JSON.stringify(result);
      }
      setAiInsights(prev => ({ ...prev, [key]: text || 'No insights available.' }));
    } catch (err) {
      const msg = err instanceof Error && err.name === 'AbortError'
        ? 'Request timed out. Click AI Insights again to retry.'
        : 'Unable to generate insights. Click again to retry.';
      setAiInsights(prev => ({ ...prev, [key]: msg }));
    } finally {
      setAiLoading(prev => ({ ...prev, [key]: false }));
    }
  }

  useEffect(() => {
    async function fetchAll() {
      try {
        const [pnlRaw, kpiRaw, deptRaw, hcRaw] = await Promise.all([
          callMcpTool('aggregate_table_data', {
            table_id: '8906',
            dimensions: ['Reporting Month', 'Scenario'],
            metrics: [{ field: 'Amount', agg: 'SUM' }],
            filters: [
              { name: 'Account Group L0', values: ['P&L'], is_excluded: false },
              { name: 'Data Type', values: ['Activity'], is_excluded: false },
            ],
          }) as Promise<RawRow[]>,
          callMcpTool('aggregate_table_data', {
            table_id: '8906',
            dimensions: ['Reporting Month', 'DR_KPI'],
            metrics: [{ field: 'Amount', agg: 'SUM' }],
            filters: [
              { name: 'Account Group L0', values: ['P&L'], is_excluded: false },
              { name: 'Data Type', values: ['Activity'], is_excluded: false },
              { name: 'Scenario', values: ['Actuals'], is_excluded: false },
            ],
          }) as Promise<RawRow[]>,
          callMcpTool('aggregate_table_data', {
            table_id: '8906',
            dimensions: ['Reporting Month', 'Department'],
            metrics: [{ field: 'Amount', agg: 'SUM' }],
            filters: [
              { name: 'Scenario', values: ['Actuals'], is_excluded: false },
              { name: 'Account Group L0', values: ['P&L'], is_excluded: false },
              { name: 'Data Type', values: ['Activity'], is_excluded: false },
            ],
          }) as Promise<RawRow[]>,
          callMcpTool('aggregate_table_data', {
            table_id: '8932',
            dimensions: ['Reporting Month', 'Department'],
            metrics: [{ field: 'Headcount', agg: 'SUM' }],
            filters: [
              { name: 'Scenario', values: ['Actuals'], is_excluded: false },
            ],
          }) as Promise<RawRow[]>,
        ]);

        const processedPnL = processPnLData(pnlRaw);
        const processedKpi = processKpiData(kpiRaw);
        const processedDept = processDeptData(deptRaw);
        const processedHc = processHeadcountData(hcRaw);

        if (processedPnL.length > 0) {
          setPnlData(processedPnL);
          setKpiData(processedKpi.length > 0 ? processedKpi : generateMockKpi());
          setDeptData(processedDept.length > 0 ? processedDept : generateMockDept());
          setHeadcountData(processedHc.length > 0 ? processedHc : generateMockHeadcount());
          setDataSource('live');
        } else {
          throw new Error('No data returned');
        }
      } catch {
        setPnlData(generateMockPnL());
        setKpiData(generateMockKpi());
        setDeptData(generateMockDept());
        setHeadcountData(generateMockHeadcount());
        setDataSource('mock');
      } finally {
        setLoading(false);
      }
    }
    fetchAll();
  }, []);

  const availablePeriods = useMemo(
    () => getAvailablePeriods(pnlData, viewMode),
    [pnlData, viewMode]
  );

  useEffect(() => {
    if (availablePeriods.length > 0) {
      setPeriodA(availablePeriods[availablePeriods.length - 1]);
      setPeriodB(
        availablePeriods.length > 1
          ? availablePeriods[availablePeriods.length - 2]
          : availablePeriods[0]
      );
    }
  }, [availablePeriods]);

  const aggPnL = useMemo(() => aggregatePnL(pnlData, viewMode), [pnlData, viewMode]);
  const aggKpi = useMemo(() => aggregateKpi(kpiData, viewMode), [kpiData, viewMode]);
  const aggHeadcount = useMemo(() => aggregateHeadcount(headcountData, viewMode), [headcountData, viewMode]);

  const comparisonData = useMemo(
    () =>
      compareMode && periodA && periodB
        ? buildComparisonData(pnlData, periodA, periodB, viewMode)
        : [],
    [pnlData, periodA, periodB, viewMode, compareMode]
  );

  const kpiCards = calcKpiCards(aggPnL, aggHeadcount);

  const varianceData = aggPnL
    .filter(r => r.Actuals !== undefined && r.Budget !== undefined)
    .map(r => ({
      month: r.month,
      variance: (r.Actuals ?? 0) - (r.Budget ?? 0),
    }));

  const pnlSummary = aggPnL.slice(-6).map(d =>
    `${d.month} A:$${((d.Actuals ?? 0) / 1e6).toFixed(1)}M B:$${((d.Budget ?? 0) / 1e6).toFixed(1)}M`
  ).join(', ');
  const varSummary = varianceData.slice(-6).map(d =>
    `${d.month}: ${d.variance > 0 ? '+' : ''}$${(d.variance / 1e6).toFixed(1)}M`
  ).join(', ');
  const latestKpiPeriod = aggKpi[aggKpi.length - 1];
  const kpiSummary = latestKpiPeriod
    ? KPI_CATEGORIES.map(cat => `${cat}: $${((latestKpiPeriod[cat] as number ?? 0) / 1e6).toFixed(1)}M`).join(', ')
    : 'No data';
  const deptSummary = deptData.slice(0, 8).map(d =>
    `${d.department}: $${(d.amount / 1e6).toFixed(1)}M`
  ).join(', ');
  const hcSummary = aggHeadcount.slice(-6).map(d => `${d.month}: ${d.total}`).join(', ');
  const totalHC = aggHeadcount.length > 0 ? aggHeadcount[aggHeadcount.length - 1].total : 0;

  const monthlyBarData =
    viewMode === 'monthly' && compareMode && comparisonData.length > 0
      ? [
          { label: periodA, value: comparisonData[0]?.periodA ?? 0, fill: '#3b82f6' },
          { label: periodB, value: comparisonData[0]?.periodB ?? 0, fill: '#a855f7' },
        ]
      : [];

  const viewLabel = viewMode === 'monthly' ? 'Monthly' : viewMode === 'quarterly' ? 'Quarterly' : 'Yearly';

  return (
    <div className="app">
      <header className="app-header">
        <div className="header-left">
          <div className="logo">
            <span className="logo-icon">◈</span>
            <span className="logo-text">FinanceOS</span>
          </div>
          <h1 className="header-title">Executive Finance Dashboard</h1>
        </div>
        <div className="header-right">
          {dataSource === 'mock' && <span className="badge badge-mock">Demo Data</span>}
          {dataSource === 'live' && <span className="badge badge-live">Live Data</span>}
          <span className="header-date">
            {new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}
          </span>
        </div>
      </header>

      <div className="toolbar">
        <div className="toolbar-left">
          <div className="view-selector">
            {(['monthly', 'quarterly', 'yearly'] as ViewMode[]).map(mode => (
              <button
                key={mode}
                className={`view-btn${viewMode === mode ? ' active' : ''}`}
                onClick={() => setViewMode(mode)}
              >
                {mode.charAt(0).toUpperCase() + mode.slice(1)}
              </button>
            ))}
          </div>
        </div>
        <div className="toolbar-right">
          <label className="compare-toggle">
            <span className="compare-label">Compare Periods</span>
            <div
              className={`toggle-switch${compareMode ? ' on' : ''}`}
              onClick={() => setCompareMode(v => !v)}
              role="switch"
              aria-checked={compareMode}
            >
              <div className="toggle-thumb" />
            </div>
          </label>
          {compareMode && (
            <div className="compare-periods-bar">
              <div className="period-picker">
                <span className="period-dot period-dot-a" />
                <span className="period-picker-label">Period A</span>
                <select
                  className="period-select"
                  value={periodA}
                  onChange={e => setPeriodA(e.target.value)}
                >
                  {availablePeriods.map(p => (
                    <option key={p} value={p}>{p}</option>
                  ))}
                </select>
              </div>
              <span className="vs-label">vs</span>
              <div className="period-picker">
                <span className="period-dot period-dot-b" />
                <span className="period-picker-label">Period B</span>
                <select
                  className="period-select"
                  value={periodB}
                  onChange={e => setPeriodB(e.target.value)}
                >
                  {availablePeriods.map(p => (
                    <option key={p} value={p}>{p}</option>
                  ))}
                </select>
              </div>
            </div>
          )}
        </div>
      </div>

      <main className="main-content">
        <section className="section">
          <div className="kpi-grid">
            {loading
              ? Array.from({ length: 4 }).map((_, i) => (
                  <div key={i} className="kpi-card">
                    <Skeleton height={90} />
                  </div>
                ))
              : kpiCards.map(card => (
                  <div key={card.label} className="kpi-card">
                    <div className="kpi-label">{card.label}</div>
                    <div className="kpi-value">{card.value}</div>
                    {card.change !== null && (
                      <div className={`kpi-change ${card.change >= 0 ? 'positive' : 'negative'}`}>
                        <span className="kpi-arrow">{card.change >= 0 ? '▲' : '▼'}</span>
                        <span>{Math.abs(card.change).toFixed(1)}%</span>
                        <span className="kpi-change-label">{card.changeLabel}</span>
                      </div>
                    )}
                  </div>
                ))}
          </div>
        </section>

        <div className="charts-grid-2">
          <section className="card">
            {compareMode ? (
              <>
                <div className="card-title-row">
                  <h2 className="card-title">
                    Period Comparison — {viewLabel} · Actuals
                  </h2>
                  <div className="card-title-actions">
                    <div className="comparison-legend">
                      <span className="legend-item">
                        <span className="legend-line legend-line-a" />
                        {periodA}
                      </span>
                      <span className="legend-item">
                        <span className="legend-line legend-line-b legend-line-dashed" />
                        {periodB}
                      </span>
                    </div>
                    {!loading && (
                      <AiInsightsButton
                        loading={!!aiLoading['pnl']}
                        onClick={() =>
                          fetchAiInsight(
                            'pnl',
                            `FP&A analyst: ${viewLabel} P&L trend. ${pnlSummary}. Give 3 bullet insights on trend, variance, and recommendation. Be very concise.`
                          )
                        }
                      />
                    )}
                  </div>
                </div>
                {loading ? (
                  <Skeleton height={280} />
                ) : viewMode === 'monthly' ? (
                  <ResponsiveContainer width="100%" height={280}>
                    <BarChart
                      data={monthlyBarData}
                      margin={{ top: 10, right: 20, left: 10, bottom: 0 }}
                    >
                      <CartesianGrid strokeDasharray="3 3" stroke="#2a2d3e" />
                      <XAxis dataKey="label" tick={{ fill: '#8b8fa8', fontSize: 11 }} />
                      <YAxis tickFormatter={formatCurrency} tick={{ fill: '#8b8fa8', fontSize: 11 }} width={60} />
                      <Tooltip
                        formatter={(v: unknown) => [formatLargeCurrency(v as number), 'Actuals']}
                        contentStyle={{ background: '#1a1d29', border: '1px solid #2a2d3e', borderRadius: 8 }}
                        labelStyle={{ color: '#e2e4f0' }}
                      />
                      <Bar dataKey="value" radius={[4, 4, 0, 0]}>
                        {monthlyBarData.map((entry, idx) => (
                          <Cell key={`cell-${idx}`} fill={entry.fill} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                ) : (
                  <ResponsiveContainer width="100%" height={280}>
                    <LineChart
                      data={comparisonData}
                      margin={{ top: 10, right: 20, left: 10, bottom: 0 }}
                    >
                      <CartesianGrid strokeDasharray="3 3" stroke="#2a2d3e" />
                      <XAxis dataKey="subLabel" tick={{ fill: '#8b8fa8', fontSize: 11 }} />
                      <YAxis tickFormatter={formatCurrency} tick={{ fill: '#8b8fa8', fontSize: 11 }} width={60} />
                      <Tooltip
                        content={
                          <ComparisonTooltip
                            periodALabel={periodA}
                            periodBLabel={periodB}
                            compData={comparisonData}
                          />
                        }
                      />
                      <Line
                        type="monotone"
                        dataKey="periodA"
                        name="periodA"
                        stroke="#3b82f6"
                        strokeWidth={2}
                        dot={{ r: 4, fill: '#3b82f6' }}
                      />
                      <Line
                        type="monotone"
                        dataKey="periodB"
                        name="periodB"
                        stroke="#a855f7"
                        strokeWidth={2}
                        strokeDasharray="6 3"
                        dot={{ r: 4, fill: '#a855f7' }}
                      />
                    </LineChart>
                  </ResponsiveContainer>
                )}

                {!loading && comparisonData.length > 0 && viewMode !== 'monthly' && (
                  <div className="variance-section">
                    <div className="variance-section-title">
                      Variance — B vs A ({periodB} vs {periodA})
                    </div>
                    <ResponsiveContainer width="100%" height={100}>
                      <BarChart
                        data={comparisonData}
                        margin={{ top: 4, right: 20, left: 10, bottom: 0 }}
                      >
                        <CartesianGrid strokeDasharray="3 3" stroke="#2a2d3e" vertical={false} />
                        <XAxis dataKey="subLabel" tick={{ fill: '#8b8fa8', fontSize: 10 }} />
                        <YAxis tickFormatter={formatCurrency} tick={{ fill: '#8b8fa8', fontSize: 10 }} width={60} />
                        <Tooltip
                          formatter={(v: unknown, _name: unknown, props: { payload?: ComparisonPoint }) => {
                            const pct = props.payload?.variancePct;
                            const pctStr = pct !== undefined ? ` (${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%)` : '';
                            return [`${formatLargeCurrency(v as number)}${pctStr}`, 'Variance B−A'];
                          }}
                          contentStyle={{ background: '#1a1d29', border: '1px solid #2a2d3e', borderRadius: 8 }}
                          labelStyle={{ color: '#e2e4f0' }}
                        />
                        <Bar dataKey="variance" radius={[3, 3, 0, 0]}>
                          {comparisonData.map((entry, idx) => (
                            <Cell
                              key={`var-${idx}`}
                              fill={(entry.variance ?? 0) >= 0 ? '#22c55e' : '#ef4444'}
                            />
                          ))}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                )}
                <AiInsightsPanel text={aiInsights['pnl'] ?? null} loading={!!aiLoading['pnl']} />
              </>
            ) : (
              <>
                <div className="card-title-row">
                  <h2 className="card-title">P&amp;L Trend — Actuals vs Budget ({viewLabel})</h2>
                  {!loading && (
                    <AiInsightsButton
                      loading={!!aiLoading['pnl']}
                      onClick={() =>
                        fetchAiInsight(
                          'pnl',
                          `FP&A analyst: ${viewLabel} P&L trend. ${pnlSummary}. Give 3 bullet insights on trend, variance, and recommendation. Be very concise.`
                        )
                      }
                    />
                  )}
                </div>
                {loading ? (
                  <Skeleton height={280} />
                ) : (
                  <ResponsiveContainer width="100%" height={280}>
                    <LineChart data={aggPnL} margin={{ top: 10, right: 20, left: 10, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#2a2d3e" />
                      <XAxis dataKey="month" tick={{ fill: '#8b8fa8', fontSize: 11 }} />
                      <YAxis tickFormatter={formatCurrency} tick={{ fill: '#8b8fa8', fontSize: 11 }} width={60} />
                      <Tooltip content={<CurrencyTooltip />} />
                      <Legend wrapperStyle={{ color: '#8b8fa8', fontSize: 12 }} />
                      <Line type="monotone" dataKey="Actuals" stroke="#3b82f6" strokeWidth={2} dot={{ r: 3 }} />
                      <Line type="monotone" dataKey="Budget" stroke="#8b5cf6" strokeWidth={2} strokeDasharray="5 5" dot={{ r: 3 }} />
                    </LineChart>
                  </ResponsiveContainer>
                )}
                <AiInsightsPanel text={aiInsights['pnl'] ?? null} loading={!!aiLoading['pnl']} />
              </>
            )}
          </section>

          <section className="card">
            <div className="card-title-row">
              <h2 className="card-title">Budget Variance — Actuals − Budget ({viewLabel})</h2>
              {!loading && (
                <AiInsightsButton
                  loading={!!aiLoading['variance']}
                  onClick={() =>
                    fetchAiInsight(
                      'variance',
                      `FP&A analyst: Budget variance trend (${viewLabel}). Recent: ${varSummary}. Give 3 bullet insights. Be very concise.`
                    )
                  }
                />
              )}
            </div>
            {loading ? (
              <Skeleton height={280} />
            ) : (
              <ResponsiveContainer width="100%" height={280}>
                <BarChart data={varianceData} margin={{ top: 10, right: 20, left: 10, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#2a2d3e" />
                  <XAxis dataKey="month" tick={{ fill: '#8b8fa8', fontSize: 11 }} />
                  <YAxis tickFormatter={formatCurrency} tick={{ fill: '#8b8fa8', fontSize: 11 }} width={60} />
                  <Tooltip
                    formatter={(v: unknown) => [formatLargeCurrency(v as number), 'Variance']}
                    contentStyle={{ background: '#1a1d29', border: '1px solid #2a2d3e', borderRadius: 8 }}
                    labelStyle={{ color: '#e2e4f0' }}
                  />
                  <Bar dataKey="variance" radius={[4, 4, 0, 0]}>
                    {varianceData.map((entry, index) => (
                      <Cell
                        key={`cell-${index}`}
                        fill={entry.variance >= 0 ? '#22c55e' : '#ef4444'}
                      />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
            <AiInsightsPanel text={aiInsights['variance'] ?? null} loading={!!aiLoading['variance']} />
          </section>
        </div>

        <div className="charts-grid-2">
          <section className="card">
            <div className="card-title-row">
              <h2 className="card-title">KPI Breakdown — Actuals ({viewLabel})</h2>
              {!loading && (
                <AiInsightsButton
                  loading={!!aiLoading['kpi']}
                  onClick={() =>
                    fetchAiInsight(
                      'kpi',
                      `FP&A analyst: KPI breakdown latest ${viewLabel}. ${kpiSummary}. Give 3 bullet insights on cost structure. Be very concise.`
                    )
                  }
                />
              )}
            </div>
            {loading ? (
              <Skeleton height={280} />
            ) : (
              <ResponsiveContainer width="100%" height={280}>
                <AreaChart data={aggKpi} margin={{ top: 10, right: 20, left: 10, bottom: 0 }}>
                  <defs>
                    {[
                      { id: 'comp', color: '#3b82f6' },
                      { id: 'da', color: '#8b5cf6' },
                      { id: 'ie', color: '#f59e0b' },
                      { id: 'ii', color: '#22c55e' },
                    ].map(g => (
                      <linearGradient key={g.id} id={g.id} x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor={g.color} stopOpacity={0.3} />
                        <stop offset="95%" stopColor={g.color} stopOpacity={0} />
                      </linearGradient>
                    ))}
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#2a2d3e" />
                  <XAxis dataKey="month" tick={{ fill: '#8b8fa8', fontSize: 11 }} />
                  <YAxis tickFormatter={formatCurrency} tick={{ fill: '#8b8fa8', fontSize: 11 }} width={60} />
                  <Tooltip content={<CurrencyTooltip />} />
                  <Legend wrapperStyle={{ color: '#8b8fa8', fontSize: 11 }} />
                  <Area type="monotone" dataKey="Compensation" stroke="#3b82f6" fill="url(#comp)" strokeWidth={2} />
                  <Area type="monotone" dataKey="Depreciation and Amortization" stroke="#8b5cf6" fill="url(#da)" strokeWidth={2} />
                  <Area type="monotone" dataKey="Interest Expense" stroke="#f59e0b" fill="url(#ie)" strokeWidth={2} />
                  <Area type="monotone" dataKey="Interest Income" stroke="#22c55e" fill="url(#ii)" strokeWidth={2} />
                </AreaChart>
              </ResponsiveContainer>
            )}
            <AiInsightsPanel text={aiInsights['kpi'] ?? null} loading={!!aiLoading['kpi']} />
          </section>

          <section className="card">
            <div className="card-title-row">
              <h2 className="card-title">Headcount Overview — Actuals ({viewLabel})</h2>
              {!loading && (
                <AiInsightsButton
                  loading={!!aiLoading['headcount']}
                  onClick={() =>
                    fetchAiInsight(
                      'headcount',
                      `HR/Finance analyst: Headcount trend (${viewLabel}). Recent: ${hcSummary}. Total: ${totalHC}. Give 3 bullet insights. Be very concise.`
                    )
                  }
                />
              )}
            </div>
            {loading ? (
              <Skeleton height={280} />
            ) : (
              <ResponsiveContainer width="100%" height={280}>
                <LineChart data={aggHeadcount} margin={{ top: 10, right: 20, left: 10, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#2a2d3e" />
                  <XAxis dataKey="month" tick={{ fill: '#8b8fa8', fontSize: 11 }} />
                  <YAxis tick={{ fill: '#8b8fa8', fontSize: 11 }} width={50} />
                  <Tooltip
                    formatter={(v: unknown) => [(v as number).toLocaleString(), 'Headcount']}
                    contentStyle={{ background: '#1a1d29', border: '1px solid #2a2d3e', borderRadius: 8 }}
                    labelStyle={{ color: '#e2e4f0' }}
                  />
                  <Line
                    type="monotone"
                    dataKey="total"
                    name="Headcount"
                    stroke="#22c55e"
                    strokeWidth={2}
                    dot={{ r: 4, fill: '#22c55e' }}
                  />
                </LineChart>
              </ResponsiveContainer>
            )}
            <AiInsightsPanel text={aiInsights['headcount'] ?? null} loading={!!aiLoading['headcount']} />
          </section>
        </div>

        <section className="card">
          <div className="card-title-row">
            <h2 className="card-title">Department Spending — Latest Month</h2>
            {!loading && (
              <AiInsightsButton
                loading={!!aiLoading['dept']}
                onClick={() =>
                  fetchAiInsight(
                    'dept',
                    `FP&A analyst: Top department spending. ${deptSummary}. Give 3 bullet insights. Be very concise.`
                  )
                }
              />
            )}
          </div>
          {loading ? (
            <Skeleton height={320} />
          ) : (
            <ResponsiveContainer width="100%" height={Math.max(280, deptData.length * 36)}>
              <BarChart
                data={deptData}
                layout="vertical"
                margin={{ top: 5, right: 30, left: 120, bottom: 5 }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="#2a2d3e" horizontal={false} />
                <XAxis type="number" tickFormatter={formatCurrency} tick={{ fill: '#8b8fa8', fontSize: 11 }} />
                <YAxis type="category" dataKey="department" tick={{ fill: '#c8cad8', fontSize: 12 }} width={110} />
                <Tooltip
                  formatter={(v: unknown) => [formatLargeCurrency(v as number), 'Spending']}
                  contentStyle={{ background: '#1a1d29', border: '1px solid #2a2d3e', borderRadius: 8 }}
                  labelStyle={{ color: '#e2e4f0' }}
                />
                <Bar dataKey="amount" fill="#3b82f6" radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
          <AiInsightsPanel text={aiInsights['dept'] ?? null} loading={!!aiLoading['dept']} />
        </section>
      </main>

      <footer className="app-footer">
        <span>Executive Finance Dashboard · Powered by Datarails FinanceOS</span>
        <span>
          Data as of{' '}
          {new Date().toLocaleDateString('en-US', {
            month: 'long',
            day: 'numeric',
            year: 'numeric',
          })}
        </span>
      </footer>
    </div>
  );
}

// ─── App with Router ──────────────────────────────────────────────────────────

export default function App() {
  return (
    <BrowserRouter>
      <nav className="top-nav">
        <div className="nav-brand">◈ Datarails FinanceOS</div>
        <div className="nav-links">
          <NavLink
            to="/"
            end
            className={({ isActive }) => isActive ? 'nav-link active' : 'nav-link'}
          >
            Dashboard
          </NavLink>
          <NavLink
            to="/variance"
            className={({ isActive }) => isActive ? 'nav-link active' : 'nav-link'}
          >
            Variance Analysis
          </NavLink>
        </div>
      </nav>
      <Routes>
        <Route path="/" element={<DashboardPage />} />
        <Route path="/variance" element={<VarianceAnalysisPage />} />
      </Routes>
    </BrowserRouter>
  );
}
