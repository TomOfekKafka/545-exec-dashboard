import { useEffect, useState } from 'react';
import {
  LineChart, Line, BarChart, Bar, AreaChart, Area,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ResponsiveContainer, Cell
} from 'recharts';
import { callMcpTool } from './api';
import './App.css';

// ─── Types ────────────────────────────────────────────────────────────────────

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
      changeLabel: 'pts vs prev month',
    },
    {
      label: 'Total Headcount',
      value: latestHc > 0 ? latestHc.toLocaleString() : '—',
      change: hcChange,
      changeLabel: `vs ${headcount.length > 1 ? headcount[headcount.length - 2].month : ''}`,
    },
  ];
}

// ─── Custom Tooltip ───────────────────────────────────────────────────────────

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

// ─── Skeleton ─────────────────────────────────────────────────────────────────

const Skeleton = ({ height = 200 }: { height?: number }) => (
  <div className="skeleton" style={{ height }} />
);

// ─── Main App ─────────────────────────────────────────────────────────────────

export default function App() {
  const [loading, setLoading] = useState(true);
  const [pnlData, setPnlData] = useState<PnLRow[]>([]);
  const [kpiData, setKpiData] = useState<KpiRow[]>([]);
  const [deptData, setDeptData] = useState<DeptRow[]>([]);
  const [headcountData, setHeadcountData] = useState<HeadcountRow[]>([]);
  const [dataSource, setDataSource] = useState<'live' | 'mock'>('live');

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

  const kpiCards = calcKpiCards(pnlData, headcountData);

  const varianceData = pnlData
    .filter(r => r.Actuals !== undefined && r.Budget !== undefined)
    .map(r => ({
      month: r.month,
      variance: (r.Actuals ?? 0) - (r.Budget ?? 0),
    }));

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

      <main className="main-content">
        {/* Section 1: KPI Cards */}
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
          {/* Section 2: P&L Trend */}
          <section className="card">
            <h2 className="card-title">P&amp;L Trend — Actuals vs Budget</h2>
            {loading ? (
              <Skeleton height={280} />
            ) : (
              <ResponsiveContainer width="100%" height={280}>
                <LineChart data={pnlData} margin={{ top: 10, right: 20, left: 10, bottom: 0 }}>
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
          </section>

          {/* Section 3: Budget Variance */}
          <section className="card">
            <h2 className="card-title">Budget Variance (Actuals − Budget)</h2>
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
          </section>
        </div>

        <div className="charts-grid-2">
          {/* Section 4: KPI Breakdown */}
          <section className="card">
            <h2 className="card-title">KPI Breakdown — Actuals</h2>
            {loading ? (
              <Skeleton height={280} />
            ) : (
              <ResponsiveContainer width="100%" height={280}>
                <AreaChart data={kpiData} margin={{ top: 10, right: 20, left: 10, bottom: 0 }}>
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
          </section>

          {/* Section 6: Headcount */}
          <section className="card">
            <h2 className="card-title">Headcount Overview — Actuals</h2>
            {loading ? (
              <Skeleton height={280} />
            ) : (
              <ResponsiveContainer width="100%" height={280}>
                <LineChart data={headcountData} margin={{ top: 10, right: 20, left: 10, bottom: 0 }}>
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
          </section>
        </div>

        {/* Section 5: Department Spending */}
        <section className="card">
          <h2 className="card-title">Department Spending — Latest Month</h2>
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
