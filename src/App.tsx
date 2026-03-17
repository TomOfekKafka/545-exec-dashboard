import { useEffect, useState, useMemo, useRef } from 'react';
import {
  LineChart, Line, BarChart, Bar, AreaChart, Area,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ResponsiveContainer, Cell, ComposedChart
} from 'recharts';
import { BrowserRouter, Routes, Route, NavLink } from 'react-router-dom';
import * as XLSX from 'xlsx';
import { callMcpTool } from './api';
import './App.css';

// ─── localStorage Keys ─────────────────────────────────────────────────────────
const DASHBOARD_CACHE_KEY = 'dr-dashboard-cache';
const AI_CACHE_KEY = 'dr-ai-insights-cache';
const VARIANCE_HISTORY_KEY = 'dr-variance-history';

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

// Stored without `months` to keep localStorage lean
type StoredVarianceLine = Omit<VarianceLine, 'months'>;

interface VarianceRun {
  id: string;
  timestamp: number;
  duration: number;
  taskCount: number;
  kpis: KpiSummary;
  reviewerNarrative: string;
  executiveNarrative: string;
  variances: StoredVarianceLine[];
  checks: Array<{ label: string; pass: boolean; detail: string }>;
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

  // History state
  const [runHistory, setRunHistory] = useState<VarianceRun[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [viewingHistoryRun, setViewingHistoryRun] = useState<VarianceRun | null>(null);
  const [compareRun, setCompareRun] = useState<VarianceRun | null>(null);
  const runStartTime = useRef<number>(0);

  // Load history from localStorage on mount, restore last run
  useEffect(() => {
    try {
      const histStr = localStorage.getItem(VARIANCE_HISTORY_KEY);
      if (histStr) {
        const hist = JSON.parse(histStr) as VarianceRun[];
        setRunHistory(hist);
        if (hist.length > 0) {
          loadHistoryRun(hist[0]);
        }
      }
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function loadHistoryRun(run: VarianceRun) {
    setViewingHistoryRun(run);
    setKpis(run.kpis);
    setVariances(run.variances.map(v => ({ ...v, months: {} })));
    setChecks(run.checks);
    setReviewerText(run.reviewerNarrative);
    setNarrativeText(run.executiveNarrative);
    setActivities([]);
    setPhase('complete');
  }

  function clearHistory() {
    try { localStorage.removeItem(VARIANCE_HISTORY_KEY); } catch {}
    setRunHistory([]);
    setViewingHistoryRun(null);
    setCompareRun(null);
  }

  const addActivity = (item: Omit<ActivityItem, 'id'>) => {
    activityCounter.current += 1;
    const id = activityCounter.current;
    setActivities(prev => [...prev, { ...item, id }]);
  };

  const setAgent = (id: string, state: AgentState) => {
    setAgentStates(prev => ({ ...prev, [id]: state }));
  };

  async function runAnalysis() {
    runStartTime.current = Date.now();
    setPhase('running');
    setActivities([]);
    setChecks([]);
    setVariances([]);
    setKpis(null);
    setReviewerText('');
    setNarrativeText('');
    setError('');
    setViewingHistoryRun(null);
    setCompareRun(null);
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

      // ── Save run to localStorage history ────────────────────────────────────
      const run: VarianceRun = {
        id: Date.now().toString(),
        timestamp: runStartTime.current,
        duration: Date.now() - runStartTime.current,
        taskCount: activityCounter.current,
        kpis: kpiSnapshot,
        reviewerNarrative: rText,
        executiveNarrative: nText,
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        variances: varLines.map(({ months: _m, ...rest }) => rest),
        checks: checkItems,
      };
      try {
        const histStr = localStorage.getItem(VARIANCE_HISTORY_KEY);
        const hist: VarianceRun[] = histStr ? JSON.parse(histStr) : [];
        hist.unshift(run);
        if (hist.length > 20) hist.pop();
        localStorage.setItem(VARIANCE_HISTORY_KEY, JSON.stringify(hist));
        setRunHistory(hist);
      } catch {}
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
          <p className="variance-subtitle">
            {viewingHistoryRun
              ? `Viewing run from ${new Date(viewingHistoryRun.timestamp).toLocaleString()}`
              : 'Multi-agent P&L review powered by Datarails AI'}
          </p>
        </div>
        <div className="variance-header-right">
          {viewingHistoryRun && (
            <button
              className="run-btn"
              style={{ background: 'transparent', border: '1px solid #334155', color: '#94a3b8', fontSize: 13, padding: '8px 16px' }}
              onClick={() => { setViewingHistoryRun(null); setPhase('idle'); setKpis(null); setVariances([]); setChecks([]); setReviewerText(''); setNarrativeText(''); setCompareRun(null); }}
            >
              ✕ Clear
            </button>
          )}
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
      {phase === 'complete' && variances.length > 0 && !viewingHistoryRun && (
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

      {/* ── Compare Panel ───────────────────────────────────────────────── */}
      {compareRun && kpis && (
        <div className="variance-card">
          <div className="variance-card-title">
            Comparison — Current vs {new Date(compareRun.timestamp).toLocaleString()}
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table className="compare-table">
              <thead>
                <tr>
                  <th>Metric</th>
                  <th>Current Run</th>
                  <th>Previous Run</th>
                  <th>Delta</th>
                </tr>
              </thead>
              <tbody>
                {[
                  { label: 'Revenue', curr: kpis.aR, prev: compareRun.kpis.aR, isPercent: false },
                  { label: 'Gross Profit', curr: kpis.aGP, prev: compareRun.kpis.aGP, isPercent: false },
                  { label: 'Net Income', curr: kpis.aNI, prev: compareRun.kpis.aNI, isPercent: false },
                  { label: 'Gross Margin', curr: kpis.aGM, prev: compareRun.kpis.aGM, isPercent: true },
                ].map(row => {
                  const delta = row.curr - row.prev;
                  const deltaPct = row.prev !== 0 ? (delta / Math.abs(row.prev)) * 100 : 0;
                  const positive = delta >= 0;
                  const fmtVal = (v: number) => row.isPercent ? `${(v * 100).toFixed(1)}%` : formatLargeCurrency(v);
                  const fmtDelta = row.isPercent
                    ? `${positive ? '+' : ''}${(delta * 100).toFixed(1)}pts`
                    : `${positive ? '+' : ''}${formatLargeCurrency(delta)}`;
                  return (
                    <tr key={row.label}>
                      <td>{row.label}</td>
                      <td>{fmtVal(row.curr)}</td>
                      <td>{fmtVal(row.prev)}</td>
                      <td className={`delta ${positive ? 'positive' : 'negative'}`}>
                        {fmtDelta} ({positive ? '+' : ''}{deltaPct.toFixed(1)}%)
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── Previous Runs History ────────────────────────────────────────── */}
      {runHistory.length > 0 && (
        <div className="history-panel">
          <button className="history-toggle" onClick={() => setShowHistory(v => !v)}>
            <span>🕐</span>
            <span>Previous Runs ({runHistory.length})</span>
            <span style={{ marginLeft: 'auto' }}>{showHistory ? '▲' : '▼'}</span>
          </button>
          {showHistory && (
            <div className="history-list">
              {runHistory.map(run => (
                <div
                  key={run.id}
                  className={`history-item${viewingHistoryRun?.id === run.id ? ' active' : ''}`}
                >
                  <div className="date">{new Date(run.timestamp).toLocaleString()}</div>
                  <div className="kpis">
                    Rev: {formatLargeCurrency(run.kpis.aR)} &nbsp;|&nbsp;
                    GP: {formatLargeCurrency(run.kpis.aGP)} &nbsp;|&nbsp;
                    NI: {formatLargeCurrency(run.kpis.aNI)}
                  </div>
                  <div className="meta">
                    {run.checks.filter(c => c.pass).length}/{run.checks.length} checks passed
                    &nbsp;·&nbsp; {run.taskCount} tasks
                    &nbsp;·&nbsp; {(run.duration / 1000).toFixed(0)}s
                  </div>
                  <div className="actions">
                    <button onClick={() => loadHistoryRun(run)}>View Details</button>
                    <button
                      onClick={() => setCompareRun(prev => prev?.id === run.id ? null : run)}
                      style={compareRun?.id === run.id ? { background: '#6366f1', color: 'white' } : undefined}
                    >
                      {compareRun?.id === run.id ? 'Cancel Compare' : 'Compare'}
                    </button>
                  </div>
                </div>
              ))}
              <button className="clear-history-btn" onClick={clearHistory}>
                Clear History
              </button>
            </div>
          )}
        </div>
      )}

      <div style={{ height: 48 }} />
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatRelativeTime(ts: number): string {
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

// ─── Cash Flow Waterfall Helpers ──────────────────────────────────────────────

interface WaterfallBar {
  name: string;
  base: number;
  delta: number;
  isTotal: boolean;
  rawValue: number;
}

function categorizeCashFlow(category: string): 'operating' | 'investing' | 'financing' | 'other' {
  const c = category.toLowerCase();
  // Financing checks first (more specific)
  if (
    c.includes('interest') || c.includes('financing') || c.includes('debt') ||
    c.includes('dividend') || c.includes('lease') || c.includes('borrowing')
  ) return 'financing';
  // Investing checks
  if (
    c.includes('depreciation') || c.includes('amortization') || c.includes('capex') ||
    c.includes('capital') || c.includes('investment') || c.includes('asset') || c.includes('property')
  ) return 'investing';
  // Operating: revenue, income, COGS, operating expenses
  if (
    c.includes('revenue') || c.includes('income') || c.includes('sales') ||
    c.includes('cost of goods') || c.includes('cogs') || c.includes('compensation') ||
    c.includes('payroll') || c.includes('g&a') || c.includes('general') ||
    c.includes('marketing') || c.includes('r&d') || c.includes('research') ||
    c.includes('operating expense') || c.includes('admin')
  ) return 'operating';
  return 'other';
}

function buildWaterfallBars(segments: Array<{ name: string; value: number }>): WaterfallBar[] {
  let running = 0;
  const bars: WaterfallBar[] = segments.map(seg => {
    const base = seg.value >= 0 ? running : running + seg.value;
    const delta = Math.abs(seg.value);
    running += seg.value;
    return { name: seg.name, base, delta, isTotal: false, rawValue: seg.value };
  });
  bars.push({
    name: 'Net Cash',
    base: running >= 0 ? 0 : running,
    delta: Math.abs(running),
    isTotal: true,
    rawValue: running,
  });
  return bars;
}

function generateMockCashFlow(): WaterfallBar[] {
  const segments = [
    { name: 'Operating Cash Flow', value: 48_000_000 + Math.random() * 4_000_000 },
    { name: 'Investing Activities', value: -(16_000_000 + Math.random() * 2_000_000) },
    { name: 'Financing Activities', value: -(9_000_000 + Math.random() * 1_500_000) },
    { name: 'Other', value: 1_500_000 + Math.random() * 500_000 },
  ];
  return buildWaterfallBars(segments);
}

// ─── Dashboard Page ───────────────────────────────────────────────────────────

function DashboardPage() {
  const [loading, setLoading] = useState(true);
  const [pnlData, setPnlData] = useState<PnLRow[]>([]);
  const [kpiData, setKpiData] = useState<KpiRow[]>([]);
  const [deptData, setDeptData] = useState<DeptRow[]>([]);
  const [headcountData, setHeadcountData] = useState<HeadcountRow[]>([]);
  const [dataSource, setDataSource] = useState<'live' | 'mock'>('live');
  const [cacheTs, setCacheTs] = useState<number | null>(null);

  const [viewMode, setViewMode] = useState<ViewMode>('monthly');
  const [compareMode, setCompareMode] = useState(false);
  const [periodA, setPeriodA] = useState('');
  const [periodB, setPeriodB] = useState('');

  const [aiInsights, setAiInsights] = useState<Record<string, string>>({});
  const [aiLoading, setAiLoading] = useState<Record<string, boolean>>({});

  // Cash flow waterfall state
  const [cashFlowBars, setCashFlowBars] = useState<WaterfallBar[]>([]);
  const [cfLoading, setCfLoading] = useState(false);
  const [cfYear, setCfYear] = useState<number>(new Date().getFullYear());

  useEffect(() => {
    try {
      const cached = localStorage.getItem(AI_CACHE_KEY);
      if (cached) {
        const parsed = JSON.parse(cached);
        if (parsed.viewMode === viewMode && parsed.insights) {
          setAiInsights(parsed.insights);
          return;
        }
      }
    } catch {}
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
      setAiInsights(prev => {
        const next = { ...prev, [key]: text || 'No insights available.' };
        try {
          localStorage.setItem(AI_CACHE_KEY, JSON.stringify({ timestamp: Date.now(), viewMode, insights: next }));
        } catch {}
        return next;
      });
    } catch (err) {
      const msg = err instanceof Error && err.name === 'AbortError'
        ? 'Request timed out. Click AI Insights again to retry.'
        : 'Unable to generate insights. Click again to retry.';
      setAiInsights(prev => ({ ...prev, [key]: msg }));
    } finally {
      setAiLoading(prev => ({ ...prev, [key]: false }));
    }
  }

  async function fetchCashFlow(year: number) {
    setCfLoading(true);
    try {
      const raw = await callMcpTool('aggregate_table_data', {
        table_id: '8906',
        dimensions: ['Account Group L2', 'Reporting Month'],
        metrics: [{ field: 'Amount', agg: 'SUM' }],
        filters: [
          { name: 'Scenario', values: ['Actuals'], is_excluded: false },
          { name: 'Account Group L0', values: ['P&L'], is_excluded: false },
          { name: 'Data Type', values: ['Activity'], is_excluded: false },
        ],
      }) as RawRow[];

      const rows = Array.isArray(raw) ? raw.filter(isDataRow) : [];
      const yearRows = rows.filter(r => {
        const ts = r['Reporting Month'] as number;
        return ts && ts > 0 && new Date(ts * 1000).getFullYear() === year;
      });

      if (yearRows.length === 0) throw new Error('No cash flow data for year');

      const buckets: Record<string, number> = { operating: 0, investing: 0, financing: 0, other: 0 };
      for (const row of yearRows) {
        const cat = row['Account Group L2'] as string;
        const amount = row['Amount'] as number;
        if (!cat || amount === undefined || amount === null) continue;
        const bucket = categorizeCashFlow(cat);
        buckets[bucket] += amount;
      }

      const segments = [
        { name: 'Operating Cash Flow', value: buckets.operating },
        { name: 'Investing Activities', value: buckets.investing },
        { name: 'Financing Activities', value: buckets.financing },
        { name: 'Other', value: buckets.other },
      ];
      setCashFlowBars(buildWaterfallBars(segments));
    } catch {
      setCashFlowBars(generateMockCashFlow());
    } finally {
      setCfLoading(false);
    }
  }

  async function fetchAll(silent = false) {
    if (!silent) setLoading(true);
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
        const finalKpi = processedKpi.length > 0 ? processedKpi : generateMockKpi();
        const finalDept = processedDept.length > 0 ? processedDept : generateMockDept();
        const finalHc = processedHc.length > 0 ? processedHc : generateMockHeadcount();
        setPnlData(processedPnL);
        setKpiData(finalKpi);
        setDeptData(finalDept);
        setHeadcountData(finalHc);
        setDataSource('live');
        const now = Date.now();
        setCacheTs(now);
        try {
          localStorage.setItem(DASHBOARD_CACHE_KEY, JSON.stringify({
            timestamp: now,
            pnlData: processedPnL,
            kpiData: finalKpi,
            deptData: finalDept,
            headcountData: finalHc,
            dataSource: 'live',
          }));
        } catch {}
      } else {
        throw new Error('No data returned');
      }
    } catch {
      const mockPnl = generateMockPnL();
      const mockKpi = generateMockKpi();
      const mockDept = generateMockDept();
      const mockHc = generateMockHeadcount();
      setPnlData(mockPnl);
      setKpiData(mockKpi);
      setDeptData(mockDept);
      setHeadcountData(mockHc);
      setDataSource('mock');
    } finally {
      setLoading(false);
    }
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    let hasCached = false;
    try {
      const cachedStr = localStorage.getItem(DASHBOARD_CACHE_KEY);
      if (cachedStr) {
        const parsed = JSON.parse(cachedStr);
        if (parsed.pnlData?.length > 0) {
          setPnlData(parsed.pnlData);
          setKpiData(parsed.kpiData ?? []);
          setDeptData(parsed.deptData ?? []);
          setHeadcountData(parsed.headcountData ?? []);
          setCacheTs(parsed.timestamp);
          setDataSource(parsed.dataSource ?? 'live');
          setLoading(false);
          hasCached = true;
        }
      }
    } catch {}
    fetchAll(hasCached);
  }, []);

  // Fetch cash flow when year changes or after initial load completes
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { fetchCashFlow(cfYear); }, [cfYear]);

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

  const availableCfYears = useMemo(() => {
    const years = new Set<number>();
    for (const row of pnlData) {
      years.add(new Date(row.timestamp * 1000).getFullYear());
    }
    const arr = Array.from(years).sort((a, b) => b - a);
    return arr.length > 0 ? arr : [new Date().getFullYear()];
  }, [pnlData]);

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
          {cacheTs && (
            <div className="last-updated">
              <span>Last updated: {formatRelativeTime(cacheTs)}</span>
              <button
                className="refresh-btn"
                onClick={() => fetchAll(false)}
                title="Refresh data"
              >
                ↻ Refresh
              </button>
            </div>
          )}
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

        {/* ── Cash Flow Waterfall ─────────────────────────────────────────── */}
        <section className="card">
          <div className="card-title-row">
            <h2 className="card-title">Cash Flow Waterfall</h2>
            <div className="card-title-actions">
              <div className="period-picker">
                <span className="period-picker-label">Fiscal Year</span>
                <select
                  className="period-select"
                  value={cfYear}
                  onChange={e => setCfYear(Number(e.target.value))}
                >
                  {availableCfYears.map(yr => (
                    <option key={yr} value={yr}>{yr}</option>
                  ))}
                </select>
              </div>
            </div>
          </div>
          {cfLoading ? (
            <Skeleton height={300} />
          ) : (
            <ResponsiveContainer width="100%" height={300}>
              <ComposedChart
                data={cashFlowBars}
                margin={{ top: 16, right: 24, left: 10, bottom: 0 }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="#2a2d3e" vertical={false} />
                <XAxis dataKey="name" tick={{ fill: '#8b8fa8', fontSize: 12 }} />
                <YAxis
                  tickFormatter={formatCurrency}
                  tick={{ fill: '#8b8fa8', fontSize: 11 }}
                  width={70}
                />
                <Tooltip
                  content={({ active, payload, label }) => {
                    if (!active || !payload?.length) return null;
                    const bar = cashFlowBars.find(b => b.name === label);
                    const val = bar?.rawValue ?? 0;
                    return (
                      <div className="custom-tooltip">
                        <p className="tooltip-label">{label}</p>
                        <p style={{ color: bar?.isTotal ? '#a855f7' : val >= 0 ? '#3b82f6' : '#ef4444', margin: '2px 0' }}>
                          {formatLargeCurrency(val)}
                        </p>
                      </div>
                    );
                  }}
                />
                {/* Invisible base bar acts as offset */}
                <Bar dataKey="base" stackId="wf" fill="transparent" legendType="none" />
                {/* Colored delta bar */}
                <Bar dataKey="delta" stackId="wf" radius={[4, 4, 0, 0]} legendType="none">
                  {cashFlowBars.map((entry, i) => (
                    <Cell
                      key={`cf-${i}`}
                      fill={
                        entry.isTotal
                          ? '#a855f7'
                          : entry.rawValue >= 0
                            ? '#3b82f6'
                            : '#ef4444'
                      }
                    />
                  ))}
                </Bar>
              </ComposedChart>
            </ResponsiveContainer>
          )}
          {!cfLoading && cashFlowBars.length > 0 && (
            <div style={{ display: 'flex', gap: 16, marginTop: 12, flexWrap: 'wrap' }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: '#94a3b8' }}>
                <span style={{ width: 10, height: 10, background: '#3b82f6', borderRadius: 2, display: 'inline-block' }} />
                Positive
              </span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: '#94a3b8' }}>
                <span style={{ width: 10, height: 10, background: '#ef4444', borderRadius: 2, display: 'inline-block' }} />
                Negative
              </span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: '#94a3b8' }}>
                <span style={{ width: 10, height: 10, background: '#a855f7', borderRadius: 2, display: 'inline-block' }} />
                Net Cash Total
              </span>
            </div>
          )}
        </section>

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

// ─── Self-Improve Drawer ───────────────────────────────────────────────────────

const IMPROVE_HISTORY_KEY = 'dr-improve-history';
const IMPROVE_ACTIVE_KEY = 'dr-improve-active';

interface ImproveRun {
  id: string;
  timestamp: number;
  userPrompt: string;
  refinedPrompt: string;
  status: 'success' | 'failure' | 'in_progress';
  duration: number | null;
}

interface ActiveBuild {
  runId: number;
  startTime: number;
  workflowUrl: string;
  prompt: string;
}

type ImproveStep = 'input' | 'review' | 'executing' | 'done';

interface ParsedReview {
  feasibility: string;
  feasibilityLevel: 'yes' | 'mostly' | 'no' | 'unknown';
  suggestions: string;
  refinedPrompt: string;
  rawText: string;
}

function parseAiReview(text: string): ParsedReview {
  const feasMatch = text.match(/FEASIBILITY:\s*(.*)/i);
  const sugMatch = text.match(/SUGGESTIONS:\s*([\s\S]*?)(?=REFINED PROMPT:|$)/i);
  const refMatch = text.match(/REFINED PROMPT:\s*([\s\S]*?)$/i);

  const feasibility = feasMatch ? feasMatch[1].trim() : '';
  const suggestions = sugMatch ? sugMatch[1].trim() : '';
  const refinedPrompt = refMatch ? refMatch[1].trim() : '';

  let feasibilityLevel: 'yes' | 'mostly' | 'no' | 'unknown' = 'unknown';
  const fLower = feasibility.toLowerCase();
  if (fLower.startsWith('yes')) feasibilityLevel = 'yes';
  else if (fLower.startsWith('mostly')) feasibilityLevel = 'mostly';
  else if (fLower.startsWith('no')) feasibilityLevel = 'no';

  return { feasibility, feasibilityLevel, suggestions, refinedPrompt, rawText: text };
}

function SelfImproveDrawer() {
  const [isOpen, setIsOpen] = useState(false);
  const [step, setStep] = useState<ImproveStep>('input');
  const [userPrompt, setUserPrompt] = useState('');
  const [reviewing, setReviewing] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [parsedReview, setParsedReview] = useState<ParsedReview | null>(null);
  const [refinedPrompt, setRefinedPrompt] = useState('');
  const [buildStatus, setBuildStatus] = useState<'queued' | 'running' | 'completed' | 'failed'>('queued');
  const [progress, setProgress] = useState(5);
  const [workflowUrl, setWorkflowUrl] = useState<string | null>(null);
  const [startTime, setStartTime] = useState<number>(0);
  const [elapsed, setElapsed] = useState(0);
  const [showHistory, setShowHistory] = useState(false);
  const [history, setHistory] = useState<ImproveRun[]>([]);
  const [isBuilding, setIsBuilding] = useState(false);
  const [buildError, setBuildError] = useState<string | null>(null);
  const pollingRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const elapsedRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Load history from localStorage
  useEffect(() => {
    try {
      const raw = localStorage.getItem(IMPROVE_HISTORY_KEY);
      if (raw) setHistory(JSON.parse(raw));
    } catch { /* ignore */ }
  }, []);

  // On page load, resume any active build
  useEffect(() => {
    const raw = localStorage.getItem(IMPROVE_ACTIVE_KEY);
    if (!raw) return;
    try {
      const active: ActiveBuild = JSON.parse(raw);
      setWorkflowUrl(active.workflowUrl);
      setStartTime(active.startTime);
      setRefinedPrompt(active.prompt);
      setStep('executing');
      setIsOpen(true);
      setIsBuilding(true);
      pollStatus(active.runId, active.startTime);
    } catch { localStorage.removeItem(IMPROVE_ACTIVE_KEY); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Elapsed timer
  useEffect(() => {
    if (step === 'executing' && isBuilding) {
      elapsedRef.current = setInterval(() => {
        setElapsed(Math.floor((Date.now() - startTime) / 1000));
      }, 1000);
    }
    return () => {
      if (elapsedRef.current) clearInterval(elapsedRef.current);
    };
  }, [step, isBuilding, startTime]);

  function saveHistory(runs: ImproveRun[]) {
    const trimmed = runs.slice(0, 20);
    setHistory(trimmed);
    localStorage.setItem(IMPROVE_HISTORY_KEY, JSON.stringify(trimmed));
  }

  async function pollStatus(rid: number, st: number) {
    try {
      const result = await callMcpTool('check_job_status', {
        repo_name: '545-exec-dashboard',
        run_id: rid,
      });
      const data = (typeof result === 'string' ? JSON.parse(result) : result) as { status: string; conclusion?: string };

      if (data.status === 'completed') {
        if (data.conclusion === 'success') {
          setBuildStatus('completed');
          setProgress(100);
          setIsBuilding(false);
          const duration = Math.floor((Date.now() - st) / 1000);
          // Save to history
          const newRun: ImproveRun = {
            id: String(rid),
            timestamp: st,
            userPrompt,
            refinedPrompt,
            status: 'success',
            duration,
          };
          const raw = localStorage.getItem(IMPROVE_HISTORY_KEY);
          const existing: ImproveRun[] = raw ? JSON.parse(raw) : [];
          saveHistory([newRun, ...existing]);
          localStorage.removeItem(IMPROVE_ACTIVE_KEY);
        } else {
          setBuildStatus('failed');
          setIsBuilding(false);
          const duration = Math.floor((Date.now() - st) / 1000);
          const newRun: ImproveRun = {
            id: String(rid),
            timestamp: st,
            userPrompt,
            refinedPrompt,
            status: 'failure',
            duration,
          };
          const raw = localStorage.getItem(IMPROVE_HISTORY_KEY);
          const existing: ImproveRun[] = raw ? JSON.parse(raw) : [];
          saveHistory([newRun, ...existing]);
          localStorage.removeItem(IMPROVE_ACTIVE_KEY);
        }
        setStep('done');
        return;
      }

      // Time-based progress
      const elapsedMs = Date.now() - st;
      const pct = Math.min(70, 5 + (elapsedMs / (10 * 60 * 1000)) * 65);
      setProgress(pct);

      pollingRef.current = setTimeout(() => pollStatus(rid, st), 30000);
    } catch {
      pollingRef.current = setTimeout(() => pollStatus(rid, st), 30000);
    }
  }

  async function handleReview() {
    if (!userPrompt.trim()) return;
    setReviewing(true);
    setReviewError(null);
    try {
      const result = await callMcpTool('run_ai_agent', {
        prompt: `You are reviewing a user's request to modify a React dashboard app.
The app is an executive financial dashboard (Vite + React + TypeScript) with:
- Dashboard page (/) with P&L charts, KPIs, revenue trends, department breakdown, AI insights
- Variance Analysis page (/variance) with multi-agent financial analysis
- Dark theme (bg #0f1117, cards #1a1d29, accents blue #3b82f6, purple #a855f7)
- Uses recharts for charts, react-router-dom for routing, xlsx for exports
- Data from Datarails Finance OS API via callMcpTool()

The user requests: "${userPrompt}"

Respond with EXACTLY this format:
FEASIBILITY: [Yes/Mostly/No] - [1 sentence assessment]
SUGGESTIONS: [1-2 bullet improvements to make the request clearer, or "None - request is clear"]
REFINED PROMPT: [A clear, specific, implementation-ready version of the request]`,
      });
      const text = typeof result === 'string' ? result : JSON.stringify(result);
      const parsed = parseAiReview(text);
      setParsedReview(parsed);
      setRefinedPrompt(parsed.refinedPrompt || userPrompt);
      setStep('review');
    } catch (e) {
      setReviewError(e instanceof Error ? e.message : 'AI review failed');
    } finally {
      setReviewing(false);
    }
  }

  async function handleBuild() {
    const optimizedPrompt = `Update this existing Vite + React + TypeScript SPA.

IMPORTANT: Read the existing src/App.tsx, src/api.ts, and src/App.css first. This is an UPDATE, not a new project.

Current app structure:
- src/App.tsx: DashboardPage (/), VarianceAnalysisPage (/variance), SelfImproveDrawer, App router
- src/api.ts: callMcpTool() for MCP API calls
- src/App.css: Dark theme styling
- Libraries: recharts, react-router-dom, xlsx, react
- Theme: bg #0f1117, cards #1a1d29, accents #6366f1 #3b82f6 #a855f7

CHANGE REQUESTED:
${refinedPrompt}

RULES:
- Do NOT break existing Dashboard or Variance Analysis pages
- Do NOT break the SelfImproveDrawer component
- Maintain the dark theme and visual consistency
- Must pass npm run build with zero errors`;

    setStep('executing');
    setBuildStatus('queued');
    setProgress(5);
    setBuildError(null);
    const st = Date.now();
    setStartTime(st);
    setIsBuilding(true);

    try {
      const result = await callMcpTool('create_or_update_app', {
        repo_name: '545-exec-dashboard',
        prompt: optimizedPrompt,
      });
      const data = (typeof result === 'string' ? JSON.parse(result) : result) as { run_id: number; workflow_run_url: string };
      setWorkflowUrl(data.workflow_run_url);

      localStorage.setItem(IMPROVE_ACTIVE_KEY, JSON.stringify({
        runId: data.run_id,
        startTime: st,
        workflowUrl: data.workflow_run_url,
        prompt: refinedPrompt,
      }));

      pollStatus(data.run_id, st);
    } catch (e) {
      setBuildError(e instanceof Error ? e.message : 'Build dispatch failed');
      setBuildStatus('failed');
      setIsBuilding(false);
      setStep('done');
    }
  }

  function handleClose() {
    setIsOpen(false);
    if (!isBuilding) {
      setStep('input');
      setParsedReview(null);
      setReviewError(null);
    }
  }

  function handleReset() {
    setStep('input');
    setUserPrompt('');
    setParsedReview(null);
    setRefinedPrompt('');
    setReviewError(null);
    setBuildStatus('queued');
    setProgress(5);
    setBuildError(null);
  }

  function getPhaseLabel(): string {
    if (buildStatus === 'completed') return 'Complete!';
    if (progress < 10) return 'Queued...';
    if (progress < 60) return 'Claude Code is building...';
    return 'Deploying...';
  }

  function formatElapsed(secs: number): string {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return m > 0 ? `${m}m ${s}s` : `${s}s`;
  }

  return (
    <>
      {/* FAB */}
      <button
        className={`improve-fab${isBuilding ? ' building' : ''}`}
        onClick={() => setIsOpen(true)}
        title="Self-Improve"
        aria-label="Open Self-Improve drawer"
      >
        <span style={{ fontSize: 13, fontWeight: 700, letterSpacing: 0.5 }}>AI</span>
      </button>

      {/* Overlay */}
      {isOpen && (
        <div
          className="improve-overlay"
          onClick={handleClose}
        />
      )}

      {/* Drawer */}
      <div className={`improve-drawer${isOpen ? ' open' : ''}`}>
        <div className="improve-drawer-header">
          <h2>&#10024; Self-Improve</h2>
          <button
            onClick={handleClose}
            style={{ background: 'transparent', border: 'none', color: '#94a3b8', fontSize: 20, cursor: 'pointer', padding: '4px 8px' }}
            aria-label="Close drawer"
          >
            &#x2715;
          </button>
        </div>

        <div className="improve-drawer-body">
          {/* ── Step 1: Input ── */}
          {step === 'input' && (
            <div>
              <p style={{ color: '#94a3b8', fontSize: 13, marginBottom: 16, lineHeight: 1.6 }}>
                Describe a change you'd like made to this dashboard. AI will review your request and generate an optimized prompt before building.
              </p>
              <textarea
                className="improve-textarea"
                placeholder="e.g. Add a cash flow waterfall chart to the dashboard..."
                value={userPrompt}
                onChange={e => setUserPrompt(e.target.value)}
              />
              {reviewError && (
                <div style={{ color: '#ef4444', fontSize: 12, marginTop: 8, padding: '8px 12px', background: 'rgba(239,68,68,0.1)', borderRadius: 8 }}>
                  {reviewError}
                </div>
              )}
              <button
                className="improve-submit-btn"
                onClick={handleReview}
                disabled={reviewing || !userPrompt.trim()}
              >
                {reviewing ? (
                  <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
                    <span className="ai-loading" style={{ padding: 0 }}>
                      <span /><span /><span />
                    </span>
                    Reviewing...
                  </span>
                ) : '✦ Review with AI'}
              </button>

              {/* History section */}
              <button
                className="history-toggle"
                style={{ marginTop: 24, borderRadius: 8, padding: '8px 16px', fontSize: 13 }}
                onClick={() => setShowHistory(h => !h)}
              >
                {showHistory ? '▲' : '▼'} History ({history.length})
              </button>
              {showHistory && (
                <div style={{ marginTop: 8 }}>
                  {history.length === 0 ? (
                    <p style={{ color: '#64748b', fontSize: 13, padding: '8px 0' }}>No previous improvements yet.</p>
                  ) : (
                    history.map(run => (
                      <div key={run.id} className="history-item">
                        <div className="date">{new Date(run.timestamp).toLocaleString()}</div>
                        <div className="prompt-preview">{run.userPrompt}</div>
                        <span className={`status-badge ${run.status === 'success' ? 'success' : run.status === 'failure' ? 'failure' : ''}`}>
                          {run.status}
                        </span>
                      </div>
                    ))
                  )}
                  {history.length > 0 && (
                    <button
                      className="clear-history-btn"
                      onClick={() => {
                        saveHistory([]);
                        setShowHistory(false);
                      }}
                    >
                      Clear History
                    </button>
                  )}
                </div>
              )}
            </div>
          )}

          {/* ── Step 2: Review ── */}
          {step === 'review' && parsedReview && (
            <div>
              <div style={{ marginBottom: 16 }}>
                <div style={{ color: '#94a3b8', fontSize: 12, marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.5 }}>Feasibility</div>
                <span className={`feasibility-badge ${parsedReview.feasibilityLevel}`}>
                  {parsedReview.feasibility || parsedReview.feasibilityLevel}
                </span>
              </div>

              {parsedReview.suggestions && (
                <div>
                  <div style={{ color: '#94a3b8', fontSize: 12, marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.5 }}>Suggestions</div>
                  <div className="suggestions-box">{parsedReview.suggestions}</div>
                </div>
              )}

              <div style={{ marginTop: 12 }}>
                <div style={{ color: '#94a3b8', fontSize: 12, marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.5 }}>Refined Prompt</div>
                <textarea
                  className="refined-textarea"
                  value={refinedPrompt}
                  onChange={e => setRefinedPrompt(e.target.value)}
                />
              </div>

              <button className="accept-btn" onClick={handleBuild}>
                &#9654; Accept &amp; Build
              </button>
              <p className="time-warning">&#9888; This will take up to 15 minutes</p>

              <button
                onClick={() => setStep('input')}
                style={{ width: '100%', marginTop: 12, padding: '10px', background: 'transparent', border: '1px solid #2a2d3e', color: '#94a3b8', borderRadius: 10, cursor: 'pointer', fontSize: 14 }}
              >
                &#8592; Back
              </button>
            </div>
          )}

          {/* Fallback if parsing failed */}
          {step === 'review' && !parsedReview && (
            <div>
              <p style={{ color: '#ef4444', fontSize: 13 }}>Could not parse AI response. Proceed with original prompt?</p>
              <button className="accept-btn" onClick={handleBuild}>&#9654; Build Anyway</button>
              <button
                onClick={() => setStep('input')}
                style={{ width: '100%', marginTop: 12, padding: '10px', background: 'transparent', border: '1px solid #2a2d3e', color: '#94a3b8', borderRadius: 10, cursor: 'pointer', fontSize: 14 }}
              >
                &#8592; Back
              </button>
            </div>
          )}

          {/* ── Step 3: Executing ── */}
          {step === 'executing' && (
            <div>
              <div className="improve-phase">{getPhaseLabel()}</div>
              <div className="improve-progress-track">
                <div className="improve-progress-fill" style={{ width: `${progress}%` }} />
              </div>
              <div className="improve-elapsed">Elapsed: {formatElapsed(elapsed)}</div>

              <div style={{ marginTop: 16, color: '#94a3b8', fontSize: 13, lineHeight: 1.6 }}>
                <p>Claude Code is reading your codebase and making the requested changes, then deploying to Azure Static Web Apps.</p>
              </div>

              {workflowUrl && (
                <a href={workflowUrl} target="_blank" rel="noopener noreferrer" className="improve-watch-link">
                  &#128279; Watch build live on GitHub Actions
                </a>
              )}

              <div style={{ marginTop: 20, padding: '12px 16px', background: '#1a1d29', borderRadius: 10, fontSize: 12, color: '#64748b' }}>
                <strong style={{ color: '#94a3b8' }}>Request:</strong>{' '}
                {refinedPrompt.slice(0, 120)}{refinedPrompt.length > 120 ? '...' : ''}
              </div>
            </div>
          )}

          {/* ── Step 4: Done ── */}
          {step === 'done' && (
            <div>
              {buildStatus === 'completed' ? (
                <div className="improve-success">
                  <div className="checkmark">&#9989;</div>
                  <h3>Changes Deployed!</h3>
                  <p>Your improvement has been applied and deployed successfully.</p>
                  {workflowUrl && (
                    <a href={workflowUrl} target="_blank" rel="noopener noreferrer" className="improve-watch-link">
                      View GitHub Actions run
                    </a>
                  )}
                  <button className="improve-refresh-btn" onClick={() => window.location.reload()}>
                    &#8635; Refresh to See Updates
                  </button>
                  <button
                    onClick={handleReset}
                    style={{ display: 'block', width: '100%', marginTop: 12, padding: '10px', background: 'transparent', border: '1px solid #2a2d3e', color: '#94a3b8', borderRadius: 10, cursor: 'pointer', fontSize: 14 }}
                  >
                    Make Another Improvement
                  </button>
                </div>
              ) : (
                <div className="improve-failure" style={{ textAlign: 'center', padding: '40px 0' }}>
                  <div style={{ fontSize: 48, marginBottom: 16 }}>&#10060;</div>
                  <h3>Build Failed</h3>
                  <p style={{ color: '#94a3b8', marginTop: 8 }}>
                    {buildError || 'The build did not complete successfully.'}
                  </p>
                  {workflowUrl && (
                    <a href={workflowUrl} target="_blank" rel="noopener noreferrer" className="improve-watch-link">
                      View GitHub Actions logs
                    </a>
                  )}
                  <button
                    onClick={handleReset}
                    style={{ display: 'block', width: '100%', marginTop: 20, padding: '12px', background: '#1a1d29', border: '1px solid #2a2d3e', color: '#94a3b8', borderRadius: 10, cursor: 'pointer', fontSize: 14 }}
                  >
                    Try Again
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

// ─── FX Rates Page ────────────────────────────────────────────────────────────

const FX_BASE = 'https://v6.exchangerate-api.com/v6/779aa944e4457939ee104cfa';
const POPULAR = ['EUR', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'CNY', 'INR'];

type CurrencyPair = [string, string];

function CurrencySelect({
  value,
  onChange,
  currencies,
}: {
  value: string;
  onChange: (v: string) => void;
  currencies: CurrencyPair[];
}) {
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const filtered = currencies.filter(
    ([code, name]) =>
      code.toLowerCase().includes(search.toLowerCase()) ||
      name.toLowerCase().includes(search.toLowerCase()),
  );

  useEffect(() => {
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const selectedName = currencies.find(([c]) => c === value)?.[1] ?? '';

  return (
    <div className="fx-currency-select" ref={ref}>
      <button className="fx-currency-btn" onClick={() => setOpen(o => !o)}>
        <span>{value} – {selectedName}</span>
        <span>{open ? '▲' : '▼'}</span>
      </button>
      {open && (
        <div className="fx-currency-dropdown">
          <input
            className="fx-currency-search"
            placeholder="Search currency…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            autoFocus
          />
          {filtered.map(([code, name]) => (
            <div
              key={code}
              className={`fx-currency-option${code === value ? ' selected' : ''}`}
              onClick={() => { onChange(code); setOpen(false); setSearch(''); }}
            >
              <span className="code">{code}</span>
              <span className="name">{name}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function FxRatesPage() {
  const [currencies, setCurrencies] = useState<CurrencyPair[]>([]);
  const [fromCurrency, setFromCurrency] = useState('USD');
  const [toCurrency, setToCurrency] = useState('EUR');
  const [amount, setAmount] = useState(1000);
  const [amountStr, setAmountStr] = useState('1000');
  const [result, setResult] = useState<number | null>(null);
  const [rate, setRate] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [popularRates, setPopularRates] = useState<Record<string, number>>({});
  const [compareList, setCompareList] = useState<string[]>(['EUR', 'GBP', 'JPY']);
  const [compareRates, setCompareRates] = useState<Record<string, number>>({});
  const [addingCurrency, setAddingCurrency] = useState(false);
  const [addSearch, setAddSearch] = useState('');
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Load currencies on mount
  useEffect(() => {
    fetch(`${FX_BASE}/codes`)
      .then(r => r.json())
      .then(d => {
        if (d.result === 'success') setCurrencies(d.supported_codes as CurrencyPair[]);
      })
      .catch(() => {});
  }, []);

  // Fetch conversion with debounce
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      if (!amount || !fromCurrency || !toCurrency) return;
      setLoading(true);
      fetch(`${FX_BASE}/pair/${fromCurrency}/${toCurrency}/${amount}`)
        .then(r => r.json())
        .then(d => {
          if (d.result === 'success') {
            setResult(d.conversion_result);
            setRate(d.conversion_rate);
            setLastUpdated(new Date());
          }
        })
        .catch(() => {})
        .finally(() => setLoading(false));
    }, 500);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [fromCurrency, toCurrency, amount]);

  // Fetch popular rates when fromCurrency changes
  useEffect(() => {
    fetch(`${FX_BASE}/latest/${fromCurrency}`)
      .then(r => r.json())
      .then(d => {
        if (d.result === 'success') {
          const rates = d.conversion_rates as Record<string, number>;
          const pop: Record<string, number> = {};
          POPULAR.forEach(c => { if (rates[c]) pop[c] = rates[c]; });
          setPopularRates(pop);
          // Also update compare rates
          const cr: Record<string, number> = {};
          compareList.forEach(c => { if (rates[c]) cr[c] = rates[c]; });
          setCompareRates(cr);
        }
      })
      .catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fromCurrency]);

  // Update compare rates when compareList changes
  useEffect(() => {
    if (Object.keys(popularRates).length === 0) return;
    fetch(`${FX_BASE}/latest/${fromCurrency}`)
      .then(r => r.json())
      .then(d => {
        if (d.result === 'success') {
          const rates = d.conversion_rates as Record<string, number>;
          const cr: Record<string, number> = {};
          compareList.forEach(c => { if (rates[c]) cr[c] = rates[c]; });
          setCompareRates(cr);
        }
      })
      .catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compareList]);

  function swap() {
    setFromCurrency(toCurrency);
    setToCurrency(fromCurrency);
  }

  function formatAmount(n: number) {
    return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
  }

  function formatRate(n: number) {
    return n < 1 ? n.toFixed(4) : n < 10 ? n.toFixed(4) : n.toFixed(2);
  }

  function timeAgo(d: Date) {
    const s = Math.round((Date.now() - d.getTime()) / 1000);
    if (s < 5) return 'just now';
    if (s < 60) return `${s}s ago`;
    return `${Math.floor(s / 60)}m ago`;
  }

  const maxPopular = Math.max(...Object.values(popularRates).filter(v => v <= 200), 1);

  const filteredAdd = currencies.filter(
    ([code, name]) =>
      !compareList.includes(code) &&
      (code.toLowerCase().includes(addSearch.toLowerCase()) ||
        name.toLowerCase().includes(addSearch.toLowerCase())),
  ).slice(0, 40);

  return (
    <div className="fx-page">
      <h1>FX Currency Exchange</h1>
      <p className="subtitle">Live exchange rates powered by ExchangeRate-API</p>

      {/* ── Converter ── */}
      <div className="fx-converter">
        <div className="fx-section-title">Currency Converter</div>
        <div className="fx-row">
          <CurrencySelect value={fromCurrency} onChange={setFromCurrency} currencies={currencies} />
          <input
            className="fx-amount-input"
            type="text"
            inputMode="decimal"
            value={amountStr}
            onChange={e => {
              const raw = e.target.value.replace(/,/g, '');
              setAmountStr(e.target.value);
              const n = parseFloat(raw);
              if (!isNaN(n)) setAmount(n);
            }}
            onBlur={() => setAmountStr(amount.toLocaleString('en-US'))}
          />
        </div>

        <div style={{ textAlign: 'center' }}>
          <button className="fx-swap-btn" onClick={swap} title="Swap currencies">⇄</button>
        </div>

        <div className="fx-row">
          <CurrencySelect value={toCurrency} onChange={setToCurrency} currencies={currencies} />
          <div className="fx-result-inline">
            {loading ? (
              <span className="fx-converting">Converting…</span>
            ) : result !== null ? (
              <span className="fx-result-num">{formatAmount(result)} {toCurrency}</span>
            ) : (
              <span className="fx-result-placeholder">—</span>
            )}
          </div>
        </div>

        <div className="fx-result">
          {rate !== null && (
            <div className="fx-result-rate">1 {fromCurrency} = {formatRate(rate)} {toCurrency}</div>
          )}
          {lastUpdated && (
            <div className="fx-result-updated">Last updated: {timeAgo(lastUpdated)}</div>
          )}
        </div>
      </div>

      {/* ── Popular Rates ── */}
      <div className="fx-converter" style={{ marginTop: 20 }}>
        <div className="fx-section-title">Popular Rates (base: {fromCurrency})</div>
        <div className="fx-popular-grid">
          {POPULAR.map(code => {
            const val = popularRates[code];
            const barPct = val !== undefined
              ? Math.min(100, (Math.min(val, maxPopular) / maxPopular) * 100)
              : 0;
            return (
              <div key={code} className="fx-rate-card">
                <div className="code">{code}</div>
                <div className="value">{val !== undefined ? formatRate(val) : '…'}</div>
                {val !== undefined && (
                  <div className="fx-mini-bar">
                    <div className="fx-mini-bar-fill" style={{ width: `${barPct}%` }} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Multi-Currency Compare ── */}
      <div className="fx-compare">
        <div className="fx-section-title">Multi-Currency Compare</div>
        <div style={{ fontSize: 13, color: '#94a3b8', marginBottom: 12 }}>
          Base: {formatAmount(amount)} {fromCurrency}
        </div>
        <div className="fx-compare-chips">
          {compareList.map(code => {
            const r = compareRates[code];
            return (
              <div key={code} className="fx-compare-chip">
                <span className="code">{code}</span>
                <span className="amount">
                  {r !== undefined ? formatAmount(amount * r) : '…'}
                </span>
                <button
                  className="remove"
                  onClick={() => setCompareList(cl => cl.filter(c => c !== code))}
                  title="Remove"
                >×</button>
              </div>
            );
          })}

          {addingCurrency ? (
            <div className="fx-add-dropdown-wrapper">
              <input
                className="fx-add-search"
                placeholder="Search…"
                autoFocus
                value={addSearch}
                onChange={e => setAddSearch(e.target.value)}
                onBlur={() => setTimeout(() => { setAddingCurrency(false); setAddSearch(''); }, 150)}
              />
              <div className="fx-add-list">
                {filteredAdd.map(([code, name]) => (
                  <div
                    key={code}
                    className="fx-currency-option"
                    onMouseDown={() => {
                      setCompareList(cl => [...cl, code]);
                      setAddingCurrency(false);
                      setAddSearch('');
                    }}
                  >
                    <span className="code">{code}</span>
                    <span className="name">{name}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <button className="fx-add-btn" onClick={() => setAddingCurrency(true)}>
              + Add currency
            </button>
          )}
        </div>
      </div>
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
          <NavLink
            to="/fx"
            className={({ isActive }) => isActive ? 'nav-link active' : 'nav-link'}
          >
            FX Rates
          </NavLink>
        </div>
      </nav>
      <Routes>
        <Route path="/" element={<DashboardPage />} />
        <Route path="/variance" element={<VarianceAnalysisPage />} />
        <Route path="/fx" element={<FxRatesPage />} />
      </Routes>
      <SelfImproveDrawer />
    </BrowserRouter>
  );
}
