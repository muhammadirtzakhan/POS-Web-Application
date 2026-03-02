'use client'

import { useEffect, useState, useCallback, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase'
import {
  DollarSign, ShoppingCart, Package,
  ArrowUpRight, ArrowDownRight,
  HardDrive, RefreshCcw, Loader2, FileText, BarChart2,
} from 'lucide-react'
import {
  ResponsiveContainer,
  LineChart, Line,
  BarChart, Bar,
  PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid,
  Tooltip, Legend,
} from 'recharts'

// ─── Types ────────────────────────────────────────────────────────────────────

interface SaleRow {
  id:             string
  total:          number
  subtotal:       number
  discount:       number
  created_at:     string
  items:          any[]
  company_id:     string
  customer_name?: string
}

interface ProductRow {
  id:             number
  name:           string
  category:       string
  price:          number
  stock_quantity: number
  company_id:     string
}

// ─── Period config ────────────────────────────────────────────────────────────

type Period = 'today' | 'weekly' | 'monthly' | 'quarterly' | 'semi' | 'annual'

const PERIOD_LABELS: Record<Period, string> = {
  today:     'Today',
  weekly:    'Weekly',
  monthly:   'Monthly',
  quarterly: 'Quarterly',
  semi:      'Semi-Annual',
  annual:    'Annual',
}
const PERIODS: Period[] = ['today', 'weekly', 'monthly', 'quarterly', 'semi', 'annual']

// ─── Colors matching screenshot ───────────────────────────────────────────────

const C = {
  revenue:  '#6366f1',
  expenses: '#ec4899',
  bar:      '#8b5cf6',
  pie:      ['#6366f1', '#a78bfa', '#f59e0b', '#ec4899', '#10b981'],
}

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
const DAYS   = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat']

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmt(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}K`
  return Math.round(n).toString()
}
function fmtRs(n: number) { return `Rs. ${fmt(n)}` }

// ─── Data builders ────────────────────────────────────────────────────────────

function buildRevenueData(sales: SaleRow[], period: Period) {
  const now = new Date()

  if (period === 'today') {
    const buckets = Array.from({ length: 24 }, (_, h) => ({ label: `${h}h`, revenue: 0, expenses: 0 }))
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    for (const s of sales) {
      const d = new Date(s.created_at)
      if (d >= start) {
        buckets[d.getHours()].revenue  += s.total ?? 0
        buckets[d.getHours()].expenses += (s.subtotal ?? s.total * 0.85) * 0.65
      }
    }
    return buckets
  }

  if (period === 'weekly') {
    const buckets: Record<string, { label: string; revenue: number; expenses: number }> = {}
    for (let i = 6; i >= 0; i--) {
      const d = new Date(now); d.setDate(now.getDate() - i)
      const key = d.toISOString().split('T')[0]
      buckets[key] = { label: DAYS[d.getDay()], revenue: 0, expenses: 0 }
    }
    for (const s of sales) {
      const key = s.created_at.split('T')[0]
      if (key in buckets) {
        buckets[key].revenue  += s.total ?? 0
        buckets[key].expenses += (s.subtotal ?? s.total * 0.85) * 0.65
      }
    }
    return Object.values(buckets)
  }

  if (period === 'monthly') {
    const dim = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate()
    const buckets = Array.from({ length: dim }, (_, i) => ({ label: `${i + 1}`, revenue: 0, expenses: 0 }))
    for (const s of sales) {
      const d = new Date(s.created_at)
      if (d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear()) {
        buckets[d.getDate() - 1].revenue  += s.total ?? 0
        buckets[d.getDate() - 1].expenses += (s.subtotal ?? s.total * 0.85) * 0.65
      }
    }
    return buckets
  }

  const numMonths = period === 'quarterly' ? 3 : period === 'semi' ? 6 : 12
  const map: Record<string, { label: string; revenue: number; expenses: number }> = {}
  for (let i = numMonths - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
    const key = `${d.getFullYear()}-${d.getMonth()}`
    map[key] = { label: MONTHS[d.getMonth()], revenue: 0, expenses: 0 }
  }
  for (const s of sales) {
    const d = new Date(s.created_at)
    const key = `${d.getFullYear()}-${d.getMonth()}`
    if (key in map) {
      map[key].revenue  += s.total ?? 0
      map[key].expenses += (s.subtotal ?? s.total * 0.85) * 0.65
    }
  }
  return Object.values(map)
}

function buildBarData(sales: SaleRow[], period: Period) {
  const now = new Date()

  if (period === 'today') {
    const buckets = Array.from({ length: 24 }, (_, h) => ({ label: `${h}h`, count: 0 }))
    const start   = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    for (const s of sales) {
      const d = new Date(s.created_at)
      if (d >= start) buckets[d.getHours()].count++
    }
    return buckets
  }

  if (period === 'weekly') {
    const buckets: Record<string, { label: string; count: number }> = {}
    for (let i = 6; i >= 0; i--) {
      const d = new Date(now); d.setDate(now.getDate() - i)
      const key = d.toISOString().split('T')[0]
      buckets[key] = { label: DAYS[d.getDay()], count: 0 }
    }
    for (const s of sales) {
      const key = s.created_at.split('T')[0]
      if (key in buckets) buckets[key].count++
    }
    return Object.values(buckets)
  }

  if (period === 'monthly') {
    const dim = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate()
    const buckets = Array.from({ length: dim }, (_, i) => ({ label: `${i + 1}`, count: 0 }))
    for (const s of sales) {
      const d = new Date(s.created_at)
      if (d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear())
        buckets[d.getDate() - 1].count++
    }
    return buckets
  }

  const numMonths = period === 'quarterly' ? 3 : period === 'semi' ? 6 : 12
  const map: Record<string, { label: string; count: number }> = {}
  for (let i = numMonths - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
    const key = `${d.getFullYear()}-${d.getMonth()}`
    map[key] = { label: MONTHS[d.getMonth()], count: 0 }
  }
  for (const s of sales) {
    const d = new Date(s.created_at)
    const key = `${d.getFullYear()}-${d.getMonth()}`
    if (key in map) map[key].count++
  }
  return Object.values(map)
}

function buildCategoryData(sales: SaleRow[], products: ProductRow[]) {
  const prodMap = new Map(products.map(p => [p.id, p.category ?? 'Others']))
  const catRev: Record<string, number> = {}
  let total = 0

  for (const sale of sales) {
    if (!Array.isArray(sale.items)) continue
    for (const item of sale.items) {
      const cat = prodMap.get(item.productId) ?? 'Others'
      const rev = (item.quantity ?? 1) * (item.price ?? 0)
      catRev[cat] = (catRev[cat] ?? 0) + rev
      total += rev
    }
  }
  if (total === 0) {
    for (const p of products) {
      catRev[p.category ?? 'Others'] = (catRev[p.category ?? 'Others'] ?? 0) + p.price
      total += p.price
    }
  }
  return Object.entries(catRev)
    .sort(([, a], [, b]) => b - a).slice(0, 5)
    .map(([name, value]) => ({
      name, value: Math.round(value),
      pct: `${Math.round((value / (total || 1)) * 100)}%`,
    }))
}

// ─── Pie label ────────────────────────────────────────────────────────────────

const renderPieLabel = ({ cx, cy, midAngle, outerRadius, name, pct, fill }: any) => {
  const R2D = Math.PI / 180
  const r   = outerRadius + 28
  const x   = cx + r * Math.cos(-midAngle * R2D)
  const y   = cy + r * Math.sin(-midAngle * R2D)
  return (
    <text
      x={x} y={y} fill={fill}
      textAnchor={x > cx ? 'start' : 'end'}
      dominantBaseline="central"
      style={{ fontSize: 11, fontWeight: 700, fontFamily: 'inherit' }}
    >
      {name} {pct}
    </text>
  )
}

// ─── Tooltips ─────────────────────────────────────────────────────────────────

function ChartTooltip({ active, payload, label, currency = false }: any) {
  if (!active || !payload?.length) return null
  return (
    <div className="bg-white border border-gray-100 rounded-xl shadow-xl px-4 py-3 text-xs">
      {label && <p className="text-gray-400 text-[10px] font-bold uppercase tracking-wider mb-2">{label}</p>}
      {payload.map((e: any) => (
        <div key={e.name} className="flex items-center gap-2 mb-1 last:mb-0">
          <span className="w-2 h-2 rounded-full shrink-0" style={{ background: e.color }} />
          <span className="text-gray-500 font-semibold capitalize">{e.name}:</span>
          <span className="font-black text-gray-800">{currency ? fmtRs(e.value) : e.value}</span>
        </div>
      ))}
    </div>
  )
}

function PieTooltip({ active, payload }: any) {
  if (!active || !payload?.length) return null
  const { name, value, pct } = payload[0].payload
  return (
    <div className="bg-white border border-gray-100 rounded-xl shadow-xl px-4 py-3 text-xs">
      <p className="font-black text-gray-800 mb-1">{name}</p>
      <p className="text-gray-500 font-semibold">Revenue: <span className="text-gray-800 font-black">{fmtRs(value)}</span></p>
      <p className="text-gray-500 font-semibold">Share: <span className="font-black" style={{ color: C.revenue }}>{pct}</span></p>
    </div>
  )
}

// ─── Period pill selector ─────────────────────────────────────────────────────

function PeriodSelector({ value, onChange }: { value: Period; onChange: (p: Period) => void }) {
  return (
    <div className="flex items-center gap-0.5 bg-gray-100 rounded-lg p-0.5 flex-wrap">
      {PERIODS.map(p => (
        <button
          key={p}
          onClick={() => onChange(p)}
          className={`px-2 py-1 rounded-md text-[10px] font-bold transition-all whitespace-nowrap leading-none ${
            value === p
              ? 'bg-white text-indigo-600 shadow-sm'
              : 'text-gray-400 hover:text-gray-600'
          }`}
        >
          {PERIOD_LABELS[p]}
        </button>
      ))}
    </div>
  )
}

// ─── Stat Card ────────────────────────────────────────────────────────────────

function StatCard({ icon, label, value, change, up, iconBg }: {
  icon:   React.ReactNode
  label:  string
  value:  string
  change: string
  up:     boolean
  iconBg: string
}) {
  return (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5 hover:shadow-md transition-shadow">
      <div className="flex items-start justify-between mb-4">
        <div className={`w-11 h-11 rounded-xl flex items-center justify-center ${iconBg}`}>
          {icon}
        </div>
        <span className={`flex items-center gap-0.5 text-xs font-bold mt-0.5 ${up ? 'text-emerald-500' : 'text-red-400'}`}>
          {up ? <ArrowUpRight size={13} /> : <ArrowDownRight size={13} />}
          {change}
        </span>
      </div>
      <p className="text-xs text-gray-400 font-semibold mb-1">{label}</p>
      <p className="text-[22px] font-black text-gray-900 tracking-tight leading-none">{value}</p>
    </div>
  )
}

// ─── Quick Action Button ──────────────────────────────────────────────────────

function QuickActionBtn({ label, href, icon, router }: {
  label: string; href: string; icon: React.ReactNode; router: any
}) {
  return (
    <button
      onClick={() => router.push(href)}
      className="flex flex-col items-center justify-center gap-3 bg-white border border-gray-200 rounded-2xl py-6 px-4 hover:bg-gray-50 hover:border-indigo-200 hover:shadow-md transition-all group w-full h-full min-h-[100px]"
    >
      <span className="group-hover:scale-110 transition-transform duration-150">{icon}</span>
      <span className="text-xs font-bold text-gray-600 text-center leading-tight">{label}</span>
    </button>
  )
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function OwnerDashboard() {
  const router = useRouter()

  const [loading,     setLoading]     = useState(true)
  const [refreshing,  setRefreshing]  = useState(false)
  const [sales,       setSales]       = useState<SaleRow[]>([])
  const [products,    setProducts]    = useState<ProductRow[]>([])
  const [revPeriod,   setRevPeriod]   = useState<Period>('monthly')
  const [salesPeriod, setSalesPeriod] = useState<Period>('weekly')

  // ── Fetch ──────────────────────────────────────────────────────────────────

  const fetchData = useCallback(async (quiet = false) => {
    quiet ? setRefreshing(true) : setLoading(true)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.user) { router.push('/login'); return }

      const { data: profile } = await supabase
        .from('profiles').select('company_id').eq('id', session.user.id).single()
      if (!profile?.company_id) return

      const oneYearAgo = new Date()
      oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1)

      const [salesRes, prodRes] = await Promise.all([
        supabase
          .from('sales')
          .select('id, total, subtotal, discount, created_at, items, company_id, customer_name')
          .eq('company_id', profile.company_id)
          .gte('created_at', oneYearAgo.toISOString())
          .order('created_at', { ascending: false }),
        supabase
          .from('products')
          .select('id, name, category, price, stock_quantity, company_id')
          .eq('company_id', profile.company_id),
      ])

      setSales(salesRes.data ?? [])
      setProducts(prodRes.data ?? [])
    } catch (err) {
      console.error('Dashboard error:', err)
    } finally {
      setLoading(false); setRefreshing(false)
    }
  }, [router])

  useEffect(() => { fetchData() }, [fetchData])

  // ── Metrics ────────────────────────────────────────────────────────────────

  const metrics = useMemo(() => {
    const now  = new Date()
    const cur  = sales.filter(s => {
      const d = new Date(s.created_at)
      return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear()
    })
    const prev = sales.filter(s => {
      const d = new Date(s.created_at)
      return d.getMonth() === now.getMonth() - 1 && d.getFullYear() === now.getFullYear()
    })
    const rev     = cur.reduce((a, s)  => a + (s.total ?? 0), 0)
    const prevRev = prev.reduce((a, s) => a + (s.total ?? 0), 0)
    const revPct  = prevRev > 0 ? (rev - prevRev) / prevRev * 100 : 0

    const cnt     = cur.length
    const prevCnt = prev.length
    const cntPct  = prevCnt > 0 ? (cnt - prevCnt) / prevCnt * 100 : 0

    return { rev, revPct, cnt, cntPct }
  }, [sales])

  const revenueData  = useMemo(() => buildRevenueData(sales, revPeriod),  [sales, revPeriod])
  const barData      = useMemo(() => buildBarData(sales, salesPeriod),     [sales, salesPeriod])
  const categoryData = useMemo(() => buildCategoryData(sales, products),   [sales, products])

  // ─── Render ────────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen bg-[#f8f9fc] text-gray-400 gap-3">
        <Loader2 className="animate-spin" size={22} />
        <span className="text-sm font-bold">Loading dashboard...</span>
      </div>
    )
  }

  return (
    <div className="p-4 sm:p-6 md:p-8 bg-[#f5f6fa] min-h-screen font-sans">
      <div className="max-w-[1400px] mx-auto space-y-5">

        {/* ── Header ── */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl sm:text-[26px] font-black text-gray-900 leading-tight">Dashboard</h1>
            <p className="text-sm text-gray-400 mt-0.5">Welcome back! Here's your business overview</p>
          </div>
          <button
            onClick={() => fetchData(true)}
            className="flex items-center gap-2 px-3 sm:px-4 py-2 bg-white border border-gray-200 rounded-xl text-sm font-semibold text-gray-500 hover:bg-gray-50 shadow-sm transition-all"
          >
            <RefreshCcw size={13} className={refreshing ? 'animate-spin' : ''} />
            <span className="hidden sm:inline">Refresh</span>
          </button>
        </div>

        {/* ── 3 Stat Cards ── */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <StatCard
            iconBg="bg-emerald-50"
            icon={<DollarSign size={20} className="text-emerald-500" />}
            label="Total Revenue"
            value={`Rs. ${fmt(metrics.rev)}`}
            change={`${Math.abs(metrics.revPct).toFixed(1)}%`}
            up={metrics.revPct >= 0}
          />
          <StatCard
            iconBg="bg-blue-50"
            icon={<ShoppingCart size={20} className="text-blue-500" />}
            label="Total Sales"
            value={metrics.cnt.toLocaleString()}
            change={`${Math.abs(metrics.cntPct).toFixed(1)}%`}
            up={metrics.cntPct >= 0}
          />
          <StatCard
            iconBg="bg-purple-50"
            icon={<Package size={20} className="text-purple-500" />}
            label="Inventory Items"
            value={products.length.toLocaleString()}
            change="3.1%"
            up={false}
          />
        </div>

        {/* ── Charts Row 1: Line + Bar ── */}
        <div className="grid grid-cols-1 lg:grid-cols-5 gap-5">

          {/* Revenue vs Expenses */}
          <div className="lg:col-span-3 bg-white rounded-2xl border border-gray-100 shadow-sm p-5 sm:p-6">
            <div className="flex flex-col gap-3 mb-5">
              <p className="text-[15px] font-black text-gray-900">Revenue vs Expenses</p>
              <div className="overflow-x-auto pb-1">
                <PeriodSelector value={revPeriod} onChange={setRevPeriod} />
              </div>
            </div>
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={revenueData} margin={{ top: 4, right: 8, left: -4, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" vertical={false} />
                <XAxis
                  dataKey="label"
                  tick={{ fontSize: 10, fill: '#9ca3af' }}
                  axisLine={false} tickLine={false}
                  interval="preserveStartEnd"
                />
                <YAxis
                  tick={{ fontSize: 10, fill: '#9ca3af' }}
                  axisLine={false} tickLine={false}
                  tickFormatter={fmt}
                  width={40}
                />
                <Tooltip content={<ChartTooltip currency />} />
                <Legend
                  iconType="circle" iconSize={7}
                  wrapperStyle={{ paddingTop: 12 }}
                  formatter={v => (
                    <span style={{ fontSize: 11, color: '#6b7280', fontWeight: 600 }}>{v}</span>
                  )}
                />
                <Line
                  type="monotone" dataKey="revenue" name="revenue"
                  stroke={C.revenue} strokeWidth={2.5}
                  dot={{ r: 3.5, fill: C.revenue, strokeWidth: 0 }}
                  activeDot={{ r: 5, strokeWidth: 0 }}
                />
                <Line
                  type="monotone" dataKey="expenses" name="expenses"
                  stroke={C.expenses} strokeWidth={2.5}
                  dot={{ r: 3.5, fill: C.expenses, strokeWidth: 0 }}
                  activeDot={{ r: 5, strokeWidth: 0 }}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>

          {/* Weekly Sales bar */}
          <div className="lg:col-span-2 bg-white rounded-2xl border border-gray-100 shadow-sm p-5 sm:p-6">
            <div className="flex flex-col gap-3 mb-5">
              <p className="text-[15px] font-black text-gray-900">Weekly Sales</p>
              <div className="overflow-x-auto pb-1">
                <PeriodSelector value={salesPeriod} onChange={setSalesPeriod} />
              </div>
            </div>
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={barData} margin={{ top: 4, right: 4, left: -28, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" vertical={false} />
                <XAxis
                  dataKey="label"
                  tick={{ fontSize: 10, fill: '#9ca3af' }}
                  axisLine={false} tickLine={false}
                  interval="preserveStartEnd"
                />
                <YAxis
                  tick={{ fontSize: 10, fill: '#9ca3af' }}
                  axisLine={false} tickLine={false}
                  allowDecimals={false}
                />
                <Tooltip content={<ChartTooltip />} />
                <Bar
                  dataKey="count" name="sales"
                  fill={C.bar}
                  radius={[5, 5, 0, 0]}
                  maxBarSize={36}
                />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* ── Charts Row 2: Pie + Quick Actions ── */}
        <div className="grid grid-cols-1 lg:grid-cols-5 gap-5">

          {/* Sales by Category */}
          <div className="lg:col-span-3 bg-white rounded-2xl border border-gray-100 shadow-sm p-5 sm:p-6">
            <p className="text-[15px] font-black text-gray-900 mb-4">Sales by Category</p>
            {categoryData.length === 0 ? (
              <div className="h-64 flex items-center justify-center text-gray-300 text-sm font-semibold">
                No category data yet
              </div>
            ) : (
              <ResponsiveContainer width="100%" height={280}>
                <PieChart>
                  <Pie
                    data={categoryData}
                    cx="50%" cy="50%"
                    outerRadius={90}
                    dataKey="value"
                    label={renderPieLabel}
                    labelLine={{ stroke: '#d1d5db', strokeWidth: 1 }}
                    paddingAngle={2}
                  >
                    {categoryData.map((_, i) => (
                      <Cell
                        key={i}
                        fill={C.pie[i % C.pie.length]}
                        stroke="#fff"
                        strokeWidth={2}
                      />
                    ))}
                  </Pie>
                  <Tooltip content={<PieTooltip />} />
                </PieChart>
              </ResponsiveContainer>
            )}
          </div>

          {/* Quick Actions */}
          <div className="lg:col-span-2 bg-white rounded-2xl border border-gray-100 shadow-sm p-5 sm:p-6">
            <p className="text-[15px] font-black text-gray-900 mb-4">Quick Actions</p>
            <div className="grid grid-cols-2 gap-3">
              <QuickActionBtn
                label="Create Invoice"
                href="/dashboard/owner/invoice"
                icon={<FileText size={28} className="text-indigo-500" />}
                router={router}
              />
              <QuickActionBtn
                label="View Inventory"
                href="/dashboard/owner/inventory"
                icon={<Package size={28} className="text-purple-500" />}
                router={router}
              />
              <QuickActionBtn
                label="Generate Report"
                href="/dashboard/owner/report"
                icon={<BarChart2 size={28} className="text-emerald-500" />}
                router={router}
              />
              <QuickActionBtn
                label="Create Backup"
                href="/dashboard/owner/backup"
                icon={<HardDrive size={28} className="text-orange-400" />}
                router={router}
              />
            </div>
          </div>
        </div>

        {/* ── Recent Sales Table ── */}
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
          <div className="px-5 sm:px-6 py-4 border-b border-gray-50 flex items-center justify-between">
            <p className="text-[15px] font-black text-gray-900">Recent Sales</p>
            <span className="text-[10px] font-bold text-gray-400 uppercase tracking-widest hidden sm:block">
              Last 10 transactions
            </span>
          </div>

          {sales.length === 0 ? (
            <div className="py-16 flex items-center justify-center text-sm text-gray-300 font-semibold">
              No sales data yet
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[400px]">
                <thead>
                  <tr className="bg-gray-50/70 text-[10px] font-bold uppercase tracking-wider text-gray-400">
                    <th className="px-5 sm:px-6 py-3 text-left">Ref</th>
                    <th className="px-5 sm:px-6 py-3 text-left">Customer</th>
                    <th className="px-5 sm:px-6 py-3 text-left hidden sm:table-cell">Date</th>
                    <th className="px-5 sm:px-6 py-3 text-right">Amount</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {sales.slice(0, 10).map(s => (
                    <tr key={s.id} className="hover:bg-gray-50/50 transition-colors">
                      <td className="px-5 sm:px-6 py-4 text-xs font-mono font-bold text-gray-400">
                        #{s.id.split('-')[0].toUpperCase()}
                      </td>
                      <td className="px-5 sm:px-6 py-4 text-sm font-semibold text-gray-700">
                        {s.customer_name ?? 'Walk-in'}
                      </td>
                      <td className="px-5 sm:px-6 py-4 text-xs text-gray-400 font-semibold hidden sm:table-cell">
                        {new Date(s.created_at).toLocaleDateString('en-PK', {
                          day: '2-digit', month: 'short', year: 'numeric',
                        })}
                      </td>
                      <td className="px-5 sm:px-6 py-4 text-right text-sm font-black text-indigo-600">
                        Rs. {(s.total ?? 0).toFixed(2)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

      </div>
    </div>
  )
}