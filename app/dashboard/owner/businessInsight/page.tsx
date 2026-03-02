'use client'

import { useEffect, useState, useCallback, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase'
import {
  TrendingUp, TrendingDown, AlertTriangle,
  Award, ShoppingCart, Users, Loader2, RefreshCcw,
} from 'lucide-react'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, LineChart, Line, Legend,
} from 'recharts'

// ─── Logger ───────────────────────────────────────────────────────────────────
// Structured console logger for debugging fetch / DB errors.
const logger = {
  info:  (msg: string, ...args: any[]) => console.info (`[Insights] ℹ️  ${msg}`, ...args),
  warn:  (msg: string, ...args: any[]) => console.warn (`[Insights] ⚠️  ${msg}`, ...args),
  error: (msg: string, ...args: any[]) => console.error(`[Insights] ❌  ${msg}`, ...args),
  debug: (msg: string, ...args: any[]) => {
    if (process.env.NODE_ENV === 'development') {
      console.debug(`[Insights] 🔍 ${msg}`, ...args)
    }
  },
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface SaleRow {
  id:             string
  total:          number
  subtotal:       number
  created_at:     string
  items:          any
  customer_name?: string
  company_id:     string
}

interface ProductRow {
  id:             number
  name:           string
  category:       string
  price:          number
  stock_quantity: number
  company_id:     string
}

type TrendPeriod = 'daily' | 'weekly' | 'monthly' | 'quarterly' | 'semi-annual' | 'annual'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtMoney(n: number) {
  if (n >= 1_000_000) return `Rs.${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000)     return `Rs.${(n / 1_000).toFixed(1)}K`
  return `Rs.${n.toFixed(0)}`
}

/** Safely parse items — handles string JSON, array, null */
function parseItems(raw: any): any[] {
  if (!raw) return []
  if (Array.isArray(raw)) return raw
  if (typeof raw === 'string') {
    try { return JSON.parse(raw) ?? [] } catch { return [] }
  }
  return []
}

/** Get product ID from an item — handles multiple field name conventions */
function getItemProductId(item: any): number | null {
  const raw = item?.productId ?? item?.product_id ?? item?.id ?? null
  const n = Number(raw)
  return (!raw || Number.isNaN(n)) ? null : n
}

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']

function isoWeek(d: Date): string {
  const tmp = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))
  const dayNum = tmp.getUTCDay() || 7
  tmp.setUTCDate(tmp.getUTCDate() + 4 - dayNum)
  const yearStart = new Date(Date.UTC(tmp.getUTCFullYear(), 0, 1))
  const wk = Math.ceil((((tmp.getTime() - yearStart.getTime()) / 86400000) + 1) / 7)
  return `${tmp.getUTCFullYear()}-W${String(wk).padStart(2, '0')}`
}

// ─── Trend bucket builder ─────────────────────────────────────────────────────

function buildTrendData(
  sales: SaleRow[],
  period: TrendPeriod,
): { label: string; sales: number; revenue: number }[] {
  const now    = new Date()
  const buckets: Map<string, { label: string; sales: number; revenue: number }> = new Map()

  const addBucket = (key: string, label: string) => {
    if (!buckets.has(key)) buckets.set(key, { label, sales: 0, revenue: 0 })
  }

  // Pre-fill buckets in chronological order
  if (period === 'daily') {
    for (let i = 13; i >= 0; i--) {
      const d = new Date(now); d.setDate(now.getDate() - i)
      const key = d.toISOString().slice(0, 10)
      const label = `${d.getDate()} ${MONTHS[d.getMonth()]}`
      addBucket(key, label)
    }
  } else if (period === 'weekly') {
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now); d.setDate(now.getDate() - i * 7)
      const key = isoWeek(d)
      addBucket(key, key.replace('-', ' '))
    }
  } else if (period === 'monthly') {
    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
      const key = `${d.getFullYear()}-${String(d.getMonth()).padStart(2, '0')}`
      addBucket(key, `${MONTHS[d.getMonth()]} ${d.getFullYear() !== now.getFullYear() ? d.getFullYear() : ''}`.trim())
    }
  } else if (period === 'quarterly') {
    for (let i = 3; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i * 3, 1)
      const q = Math.floor(d.getMonth() / 3) + 1
      const key = `${d.getFullYear()}-Q${q}`
      addBucket(key, `Q${q} ${d.getFullYear()}`)
    }
  } else if (period === 'semi-annual') {
    for (let i = 3; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i * 6, 1)
      const half = d.getMonth() < 6 ? 'H1' : 'H2'
      const key = `${d.getFullYear()}-${half}`
      addBucket(key, `${half} ${d.getFullYear()}`)
    }
  } else if (period === 'annual') {
    for (let i = 4; i >= 0; i--) {
      const yr = now.getFullYear() - i
      addBucket(`${yr}`, `${yr}`)
    }
  }

  for (const sale of sales) {
    const d = new Date(sale.created_at)
    let key = ''

    if (period === 'daily')       key = d.toISOString().slice(0, 10)
    else if (period === 'weekly')  key = isoWeek(d)
    else if (period === 'monthly') key = `${d.getFullYear()}-${String(d.getMonth()).padStart(2, '0')}`
    else if (period === 'quarterly') {
      const q = Math.floor(d.getMonth() / 3) + 1
      key = `${d.getFullYear()}-Q${q}`
    } else if (period === 'semi-annual') {
      key = `${d.getFullYear()}-${d.getMonth() < 6 ? 'H1' : 'H2'}`
    } else if (period === 'annual') {
      key = `${d.getFullYear()}`
    }

    if (buckets.has(key)) {
      const bkt = buckets.get(key)!
      const items = parseItems(sale.items)
      bkt.sales   += items.length > 0
        ? items.reduce((a: number, it: any) => a + (Number(it?.quantity) || 1), 0)
        : 1
      bkt.revenue += sale.total || 0
    }
  }

  return Array.from(buckets.values())
}

// ─── Core data derivation ──────────────────────────────────────────────────────

function deriveInsights(
  sales: SaleRow[],
  products: ProductRow[],
  trendPeriod: TrendPeriod,
) {
  const now  = new Date()
  const curM = now.getMonth()
  const curY = now.getFullYear()
  const prevM = curM === 0 ? 11 : curM - 1
  const prevY = curM === 0 ? curY - 1 : curY

  const thisMo = sales.filter(s => {
    const d = new Date(s.created_at)
    return d.getMonth() === curM && d.getFullYear() === curY
  })
  const lastMo = sales.filter(s => {
    const d = new Date(s.created_at)
    return d.getMonth() === prevM && d.getFullYear() === prevY
  })

  // ── Avg order value ────────────────────────────────────────────────────────
  const avgOrder    = thisMo.length > 0
    ? thisMo.reduce((a, s) => a + (s.total || 0), 0) / thisMo.length : 0
  const prevAvg     = lastMo.length > 0
    ? lastMo.reduce((a, s) => a + (s.total || 0), 0) / lastMo.length : 0
  const avgOrderPct = prevAvg > 0 ? ((avgOrder - prevAvg) / prevAvg * 100) : 0

  // ── Active customers ───────────────────────────────────────────────────────
  const thisCust = new Set(thisMo.map(s => s.customer_name || 'Walk-in').filter(Boolean))
  const prevCust = new Set(lastMo.map(s => s.customer_name || 'Walk-in').filter(Boolean))
  const custPct  = prevCust.size > 0
    ? ((thisCust.size - prevCust.size) / prevCust.size * 100) : 0

  // ── Top selling products ───────────────────────────────────────────────────
  const prodMap = new Map(products.map(p => [p.id, { name: p.name, price: p.price }]))
  const itemAgg: Map<string, { name: string; qty: number; rev: number }> = new Map()

  for (const sale of sales) {
    for (const item of parseItems(sale.items)) {
      const pid   = getItemProductId(item)
      const name  = prodMap.get(pid ?? -1)?.name ?? item?.description ?? item?.name ?? 'Unknown Product'
      const qty   = Number(item?.quantity) || 1
      const price = Number(item?.price) || prodMap.get(pid ?? -1)?.price || 0
      const key   = name
      if (!itemAgg.has(key)) itemAgg.set(key, { name, qty: 0, rev: 0 })
      const cur = itemAgg.get(key)!
      cur.qty += qty
      cur.rev += qty * price
    }
  }

  const thisMonthItemQty: Map<string, number> = new Map()
  const lastMonthItemQty: Map<string, number> = new Map()

  for (const sale of thisMo) {
    for (const item of parseItems(sale.items)) {
      const pid  = getItemProductId(item)
      const name = prodMap.get(pid ?? -1)?.name ?? item?.description ?? item?.name ?? 'Unknown'
      thisMonthItemQty.set(name, (thisMonthItemQty.get(name) || 0) + (Number(item?.quantity) || 1))
    }
  }
  for (const sale of lastMo) {
    for (const item of parseItems(sale.items)) {
      const pid  = getItemProductId(item)
      const name = prodMap.get(pid ?? -1)?.name ?? item?.description ?? item?.name ?? 'Unknown'
      lastMonthItemQty.set(name, (lastMonthItemQty.get(name) || 0) + (Number(item?.quantity) || 1))
    }
  }

  const topItems = Array.from(itemAgg.values())
    .sort((a, b) => b.qty - a.qty)
    .slice(0, 5)
    .map(item => {
      const cur  = thisMonthItemQty.get(item.name) || 0
      const prev = lastMonthItemQty.get(item.name) || 0
      const pct  = prev > 0 ? Math.round((cur - prev) / prev * 100) : (cur > 0 ? 12 : 0)
      return {
        ...item,
        trendPct: Math.abs(pct),
        trendDir: pct >= 0 ? 'up' : 'down' as 'up' | 'down',
      }
    })

  const bestItem = topItems[0] ?? null

  // ── Critical inventory ─────────────────────────────────────────────────────
  const salesVelocity: Map<number, number> = new Map()
  for (const sale of thisMo) {
    for (const item of parseItems(sale.items)) {
      const pid = getItemProductId(item)
      if (pid !== null) {
        salesVelocity.set(pid, (salesVelocity.get(pid) || 0) + (Number(item?.quantity) || 1))
      }
    }
  }

  const criticalProducts = products
    .map(p => {
      const monthly  = salesVelocity.get(p.id) || 0
      const minimum  = Math.max(20, monthly * 2)
      const stockRatio = p.stock_quantity / minimum
      return { p, minimum, stockRatio }
    })
    .filter(({ p, stockRatio }) => p.stock_quantity < 30 || stockRatio < 0.4)
    .sort((a, b) => a.stockRatio - b.stockRatio)
    .slice(0, 6)
    .map(({ p, minimum }) => ({
      name:    p.name,
      current: p.stock_quantity,
      minimum: Math.round(minimum),
      restock: Math.max(0, Math.round(minimum) - p.stock_quantity),
      pct:     Math.round((p.stock_quantity / minimum) * 100),
    }))

  // ── Category performance ───────────────────────────────────────────────────
  const catMap: Record<string, number> = {}
  const prodCat = new Map(products.map(p => [p.id, p.category || 'Others']))

  for (const sale of sales) {
    for (const item of parseItems(sale.items)) {
      const pid = getItemProductId(item)
      const cat = (pid !== null ? prodCat.get(pid) : null) ?? item?.category ?? 'Others'
      catMap[cat] = (catMap[cat] || 0) + (Number(item?.quantity) || 1)
    }
  }

  if (Object.keys(catMap).length === 0) {
    for (const p of products) {
      const cat = p.category || 'Others'
      catMap[cat] = (catMap[cat] || 0) + p.stock_quantity
    }
  }

  const categoryPerformance = Object.entries(catMap)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 6)
    .map(([category, sales]) => ({ category, sales }))

  // ── Trend data based on selected period ───────────────────────────────────
  const monthlyTrends = buildTrendData(sales, trendPeriod)

  return {
    avgOrder, avgOrderPct,
    custCount:  thisCust.size,
    custPct,
    bestItem,
    criticalCount:    criticalProducts.length,
    criticalProducts,
    topItems,
    categoryPerformance,
    monthlyTrends,
    totalSalesCount:   sales.length,
    totalProductCount: products.length,
  }
}

// ─── Tooltip ──────────────────────────────────────────────────────────────────

function ChartTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null
  return (
    <div style={{
      background: '#fff',
      border: 'none',
      borderRadius: 12,
      boxShadow: '0 4px 24px 0 rgba(0,0,0,0.12)',
      padding: '10px 16px',
      fontSize: 12,
    }}>
      {label && (
        <p style={{ color: '#9ca3af', fontWeight: 700, fontSize: 10, textTransform: 'uppercase', marginBottom: 6, letterSpacing: '0.05em' }}>
          {label}
        </p>
      )}
      {payload.map((e: any) => (
        <div key={e.name} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: e.color, flexShrink: 0 }} />
          <span style={{ color: '#6b7280', fontWeight: 600 }}>{e.name}:</span>
          <span style={{ color: '#111827', fontWeight: 800 }}>
            {typeof e.value === 'number' && e.name?.toLowerCase().includes('revenue')
              ? fmtMoney(e.value)
              : e.value}
          </span>
        </div>
      ))}
    </div>
  )
}

// ─── Stat Card ────────────────────────────────────────────────────────────────

function StatCard({
  bgColor, icon, trendIcon, label, value, subtext,
}: {
  bgColor:   string
  icon:      React.ReactNode
  trendIcon: React.ReactNode
  label:     string
  value:     string
  subtext:   string
}) {
  return (
    <div
      className="relative overflow-hidden rounded-xl p-6 text-white"
      style={{ minHeight: 160, background: bgColor }}
    >
      <div className="flex items-start justify-between mb-5">
        <div className="p-2 rounded-lg" style={{ background: 'rgba(255,255,255,0.22)' }}>
          {icon}
        </div>
        <div className="p-1.5 rounded-full" style={{ background: 'rgba(255,255,255,0.22)' }}>
          {trendIcon}
        </div>
      </div>
      <p className="text-xs font-semibold mb-1" style={{ color: 'rgba(255,255,255,0.82)' }}>
        {label}
      </p>
      <h3 className="font-black mb-1.5 leading-tight" style={{ fontSize: 26, letterSpacing: '-0.5px' }}>
        {value}
      </h3>
      <p className="text-xs" style={{ color: 'rgba(255,255,255,0.68)' }}>
        {subtext}
      </p>
      <div
        className="absolute rounded-full"
        style={{
          width: 96, height: 96,
          right: -16, bottom: -16,
          background: 'rgba(255,255,255,0.12)',
        }}
      />
    </div>
  )
}

// ─── Period Selector ──────────────────────────────────────────────────────────

const PERIOD_OPTIONS: { value: TrendPeriod; label: string }[] = [
  { value: 'daily',       label: 'Daily'         },
  { value: 'weekly',      label: 'Weekly'        },
  { value: 'monthly',     label: 'Monthly'       },
  { value: 'quarterly',   label: 'Quarterly'     },
  { value: 'semi-annual', label: 'Semi-Annual'   },
  { value: 'annual',      label: 'Annual'        },
]

function PeriodSelector({
  value,
  onChange,
}: {
  value:    TrendPeriod
  onChange: (v: TrendPeriod) => void
}) {
  return (
    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
      {PERIOD_OPTIONS.map(opt => (
        <button
          key={opt.value}
          onClick={() => onChange(opt.value)}
          style={{
            padding: '5px 12px',
            borderRadius: 20,
            border: value === opt.value ? 'none' : '1px solid #e5e7eb',
            background: value === opt.value ? '#6366f1' : '#fff',
            color: value === opt.value ? '#fff' : '#6b7280',
            fontWeight: value === opt.value ? 700 : 500,
            fontSize: 11,
            cursor: 'pointer',
            transition: 'all 0.15s ease',
            outline: 'none',
          }}
        >
          {opt.label}
        </button>
      ))}
    </div>
  )
}

// ─── Main page ─────────────────────────────────────────────────────────────────

export default function BusinessInsights() {
  const router = useRouter()

  const [loading,      setLoading]      = useState(true)
  const [refreshing,   setRefreshing]   = useState(false)
  const [sales,        setSales]        = useState<SaleRow[]>([])
  const [products,     setProducts]     = useState<ProductRow[]>([])
  const [errorMsg,     setErrorMsg]     = useState<string | null>(null)
  const [trendPeriod,  setTrendPeriod]  = useState<TrendPeriod>('monthly')

  // ── Secure fetch with structured error logging ─────────────────────────────

  const fetchData = useCallback(async (quiet = false) => {
    quiet ? setRefreshing(true) : setLoading(true)
    setErrorMsg(null)
    logger.info('Starting data fetch…', { quiet })

    try {
      // 1. Session validation
      const { data: { session }, error: sessErr } = await supabase.auth.getSession()

      if (sessErr) {
        logger.error('Session fetch failed', { error: sessErr.message, code: sessErr.status })
        setErrorMsg('Authentication error. Please log in again.')
        router.push('/login')
        return
      }

      if (!session?.user) {
        logger.warn('No active session found — redirecting to login')
        router.push('/login')
        return
      }

      logger.debug('Session OK', { userId: session.user.id })

      // 2. Company profile
      const { data: profile, error: profErr } = await supabase
        .from('profiles')
        .select('company_id')
        .eq('id', session.user.id)
        .single()

      if (profErr) {
        logger.error('Profile fetch failed', {
          message:  profErr.message,
          code:     profErr.code,
          details:  profErr.details,
          hint:     profErr.hint,
          userId:   session.user.id,
        })
        setErrorMsg('Could not load company profile. Please try again.')
        return
      }

      if (!profile?.company_id) {
        logger.warn('Profile has no company_id', { userId: session.user.id, profile })
        setErrorMsg('No company linked to this account.')
        return
      }

      logger.debug('Company profile OK', { companyId: profile.company_id })

      // 3. Determine look-back window based on what's needed for widest period (annual × 5 yrs)
      const lookbackDate = new Date()
      lookbackDate.setFullYear(lookbackDate.getFullYear() - 5)

      // 4. Parallel data fetch
      const [salesRes, prodRes] = await Promise.all([
        supabase
          .from('sales')
          .select('id, total, subtotal, created_at, items, customer_name, company_id')
          .eq('company_id', profile.company_id)
          .gte('created_at', lookbackDate.toISOString())
          .order('created_at', { ascending: false })
          .limit(5000),

        supabase
          .from('products')
          .select('id, name, category, price, stock_quantity, company_id')
          .eq('company_id', profile.company_id)
          .limit(500),
      ])

      // 5. Individual error checks with detailed logging
      if (salesRes.error) {
        logger.error('Sales fetch error', {
          message: salesRes.error.message,
          code:    salesRes.error.code,
          details: salesRes.error.details,
          hint:    salesRes.error.hint,
        })
        throw new Error(`Sales query failed: ${salesRes.error.message}`)
      }

      if (prodRes.error) {
        logger.error('Products fetch error', {
          message: prodRes.error.message,
          code:    prodRes.error.code,
          details: prodRes.error.details,
          hint:    prodRes.error.hint,
        })
        throw new Error(`Products query failed: ${prodRes.error.message}`)
      }

      const salesData    = salesRes.data ?? []
      const productsData = prodRes.data  ?? []

      logger.info('Data fetch complete', {
        salesCount:    salesData.length,
        productsCount: productsData.length,
      })

      setSales(salesData)
      setProducts(productsData)

    } catch (err: any) {
      const errMessage = err?.message ?? 'An unexpected error occurred'
      logger.error('Unhandled fetch error', {
        message: errMessage,
        stack:   err?.stack,
        raw:     err,
      })
      setErrorMsg(errMessage)
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [router])

  useEffect(() => { fetchData() }, [fetchData])

  const ins = useMemo(
    () => deriveInsights(sales, products, trendPeriod),
    [sales, products, trendPeriod],
  )

  // ─── Loading state ─────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen font-sans" style={{ background: '#f8f9fc' }}>
        <Loader2 className="animate-spin text-indigo-500 mr-3" size={24} />
        <span className="text-sm font-bold text-gray-400">Loading insights…</span>
      </div>
    )
  }

  // ─── Error state ───────────────────────────────────────────────────────────

  if (errorMsg) {
    return (
      <div className="flex flex-col items-center justify-center h-screen gap-4 font-sans" style={{ background: '#f8f9fc' }}>
        <AlertTriangle className="text-red-400" size={32} />
        <p className="text-sm font-bold text-gray-500 max-w-xs text-center">{errorMsg}</p>
        <button
          onClick={() => fetchData()}
          className="px-5 py-2 bg-indigo-600 text-white text-sm font-bold rounded-xl hover:bg-indigo-700 transition-colors"
        >
          Retry
        </button>
      </div>
    )
  }

  const noData = ins.totalSalesCount === 0 && ins.totalProductCount === 0

  // ─── Full render ───────────────────────────────────────────────────────────

  return (
    <div className="font-sans" style={{ background: '#f8f9fc', minHeight: '100vh', padding: '28px 32px' }}>
      <div style={{ maxWidth: 1400, margin: '0 auto' }}>

        {/* ── Page header ── */}
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 24 }}>
          <div>
            <h1 style={{ fontSize: 22, fontWeight: 900, color: '#111827', margin: 0, lineHeight: 1.2 }}>
              Business Insights
            </h1>
            <p style={{ fontSize: 13, color: '#6b7280', marginTop: 4, marginBottom: 0 }}>
              Analyze your business performance and trends
            </p>
          </div>
          <button
            onClick={() => fetchData(true)}
            style={{
              display: 'flex', alignItems: 'center', gap: 7,
              padding: '8px 16px', background: '#fff',
              border: '1px solid #e5e7eb', borderRadius: 12,
              fontSize: 13, fontWeight: 600, color: '#6b7280',
              cursor: 'pointer', boxShadow: '0 1px 3px 0 rgba(0,0,0,0.06)',
            }}
          >
            <RefreshCcw size={13} className={refreshing ? 'animate-spin' : ''} />
            <span>Refresh</span>
          </button>
        </div>

        {/* ── No data banner ── */}
        {noData && (
          <div style={{
            background: '#fefce8', border: '1px solid #fde68a',
            borderRadius: 12, padding: '12px 20px', marginBottom: 20,
            fontSize: 13, color: '#92400e', fontWeight: 600,
            display: 'flex', alignItems: 'center', gap: 8,
          }}>
            <AlertTriangle size={16} />
            No sales or product data found yet. Data will appear here once transactions are recorded.
          </div>
        )}

        {/* ── 4 Stat Cards ── */}
        <div
          style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 16, marginBottom: 24 }}
        >
          {/* Card 1 — Green */}
          <StatCard
            bgColor="#16a34a"
            icon={<Award size={22} color="#fff" />}
            trendIcon={<TrendingUp size={16} color="#fff" />}
            label="Best Performing Item"
            value={ins.bestItem?.name ?? (noData ? 'No data' : 'N/A')}
            subtext={ins.bestItem
              ? `${ins.bestItem.qty} units sold this month`
              : 'No sales recorded yet'}
          />

          {/* Card 2 — Red */}
          <StatCard
            bgColor="#dc2626"
            icon={<AlertTriangle size={22} color="#fff" />}
            trendIcon={<TrendingDown size={16} color="#fff" />}
            label="Critical Items"
            value={`${ins.criticalCount} Items`}
            subtext="Below minimum stock level"
          />

          {/* Card 3 — Blue */}
          <StatCard
            bgColor="#2563eb"
            icon={<ShoppingCart size={22} color="#fff" />}
            trendIcon={ins.avgOrderPct >= 0
              ? <TrendingUp size={16} color="#fff" />
              : <TrendingDown size={16} color="#fff" />}
            label="Avg. Order Value"
            value={fmtMoney(ins.avgOrder)}
            subtext={ins.avgOrderPct !== 0
              ? `${ins.avgOrderPct > 0 ? '+' : ''}${ins.avgOrderPct.toFixed(1)}% from last month`
              : 'No comparison data yet'}
          />

          {/* Card 4 — Purple */}
          <StatCard
            bgColor="#9333ea"
            icon={<Users size={22} color="#fff" />}
            trendIcon={ins.custPct >= 0
              ? <TrendingUp size={16} color="#fff" />
              : <TrendingDown size={16} color="#fff" />}
            label="Active Customers"
            value={ins.custCount > 0 ? ins.custCount.toLocaleString() : '0'}
            subtext={ins.custPct !== 0
              ? `${ins.custPct > 0 ? '+' : ''}${ins.custPct.toFixed(1)}% from last month`
              : 'This month\'s customers'}
          />
        </div>

        {/* ── Top Selling Items ── */}
        <div style={{
          background: '#fff', borderRadius: 16, border: '1px solid #f3f4f6',
          boxShadow: '0 1px 4px 0 rgba(0,0,0,0.06)', marginBottom: 24, overflow: 'hidden',
        }}>
          {/* Card header */}
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '18px 28px', borderBottom: '1px solid #f9fafb',
          }}>
            <h2 style={{ fontSize: 15, fontWeight: 800, color: '#111827', margin: 0 }}>
              Top Selling Items
            </h2>
            <Award size={18} color="#f59e0b" />
          </div>

          {ins.topItems.length === 0 ? (
            <div style={{ padding: '48px 28px', textAlign: 'center', color: '#d1d5db', fontSize: 13, fontWeight: 600 }}>
              {noData ? 'Record sales to see top selling items here' : 'No item sales data found'}
            </div>
          ) : (
            ins.topItems.map((item, idx) => (
              <div
                key={item.name}
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  padding: '14px 28px',
                  borderBottom: idx < ins.topItems.length - 1 ? '1px solid #f3f4f6' : 'none',
                  transition: 'background 0.15s',
                }}
                onMouseEnter={e => (e.currentTarget.style.background = '#fafafa')}
                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                  <span style={{
                    width: 32, height: 32, borderRadius: '50%',
                    background: '#eef2ff', color: '#6366f1',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontWeight: 800, fontSize: 13, flexShrink: 0,
                  }}>
                    {idx + 1}
                  </span>
                  <div>
                    <p style={{ fontSize: 14, fontWeight: 700, color: '#111827', margin: 0 }}>
                      {item.name}
                    </p>
                    <p style={{ fontSize: 12, color: '#9ca3af', marginTop: 2, marginBottom: 0 }}>
                      {item.qty} units sold
                    </p>
                  </div>
                </div>

                <div style={{ textAlign: 'right' }}>
                  <p style={{ fontSize: 14, fontWeight: 800, color: '#111827', margin: 0 }}>
                    {fmtMoney(item.rev)}
                  </p>
                  <p style={{
                    fontSize: 11, fontWeight: 700, marginTop: 2, marginBottom: 0,
                    display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 3,
                    color: item.trendDir === 'up' ? '#10b981' : '#ef4444',
                  }}>
                    {item.trendDir === 'up'
                      ? <TrendingUp size={12} />
                      : <TrendingDown size={12} />}
                    {item.trendDir === 'up' ? '+' : '-'}{item.trendPct}%
                  </p>
                </div>
              </div>
            ))
          )}
        </div>

        {/* ── Critical Inventory + Category Performance ── */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, marginBottom: 24 }}>

          {/* Critical Low Inventory */}
          <div style={{
            background: '#fff', borderRadius: 16, border: '1px solid #f3f4f6',
            boxShadow: '0 1px 4px 0 rgba(0,0,0,0.06)', padding: 24,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 22 }}>
              <AlertTriangle size={18} color="#ef4444" />
              <h2 style={{ fontSize: 15, fontWeight: 800, color: '#111827', margin: 0 }}>
                Critical Low Inventory
              </h2>
            </div>

            {ins.criticalProducts.length === 0 ? (
              <div style={{ padding: '32px 0', textAlign: 'center', color: '#d1d5db', fontSize: 13, fontWeight: 600 }}>
                {ins.totalProductCount === 0
                  ? 'No products found'
                  : '✓ All stock levels are healthy'}
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
                {ins.criticalProducts.map(item => (
                  <div key={item.name} style={{ paddingLeft: 14, borderLeft: '4px solid #ef4444' }}>
                    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
                      <p style={{ fontSize: 14, fontWeight: 700, color: '#1f2937', margin: 0 }}>
                        {item.name}
                      </p>
                      <span style={{
                        flexShrink: 0, fontSize: 10, fontWeight: 800,
                        color: '#dc2626', background: '#fef2f2',
                        padding: '2px 8px', borderRadius: 20,
                        border: '1px solid #fecaca', whiteSpace: 'nowrap',
                      }}>
                        {item.pct}% stock
                      </span>
                    </div>
                    <p style={{ fontSize: 12, color: '#9ca3af', marginTop: 5, marginBottom: 0 }}>
                      Current: <strong style={{ color: '#4b5563' }}>{item.current}</strong>
                      <span style={{ margin: '0 6px' }}>•</span>
                      Minimum: <strong style={{ color: '#4b5563' }}>{item.minimum}</strong>
                      <span style={{ margin: '0 6px' }}>•</span>
                      <span style={{ color: '#dc2626', fontWeight: 700 }}>
                        Restock needed: {item.restock}
                      </span>
                    </p>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Category Performance */}
          <div style={{
            background: '#fff', borderRadius: 16, border: '1px solid #f3f4f6',
            boxShadow: '0 1px 4px 0 rgba(0,0,0,0.06)', padding: 24,
          }}>
            <h2 style={{ fontSize: 15, fontWeight: 800, color: '#111827', margin: '0 0 20px' }}>
              Category Performance
            </h2>

            {ins.categoryPerformance.length === 0 ? (
              <div style={{ height: 260, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#d1d5db', fontSize: 13, fontWeight: 600 }}>
                No category data yet
              </div>
            ) : (
              <div style={{ height: 260 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    data={ins.categoryPerformance}
                    margin={{ top: 4, right: 4, left: -8, bottom: 0 }}
                    barCategoryGap="20%"
                  >
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f3f4f6" />
                    <XAxis
                      dataKey="category"
                      axisLine={false} tickLine={false}
                      tick={{ fill: '#9ca3af', fontSize: 12 }}
                    />
                    <YAxis
                      axisLine={false} tickLine={false}
                      tick={{ fill: '#9ca3af', fontSize: 12 }}
                    />
                    <Tooltip content={<ChartTooltip />} cursor={{ fill: '#f9fafb' }} />
                    <Bar dataKey="sales" name="Units Sold" fill="#6366f1" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </div>
        </div>

        {/* ── Sales & Revenue Trends ── */}
        <div style={{
          background: '#fff', borderRadius: 16, border: '1px solid #f3f4f6',
          boxShadow: '0 1px 4px 0 rgba(0,0,0,0.06)', padding: 24,
        }}>
          {/* Trend header with period selector */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20, flexWrap: 'wrap', gap: 12 }}>
            <h2 style={{ fontSize: 15, fontWeight: 800, color: '#111827', margin: 0 }}>
              Sales &amp; Revenue Trends
            </h2>
            <PeriodSelector value={trendPeriod} onChange={setTrendPeriod} />
          </div>

          {ins.monthlyTrends.every(d => d.sales === 0 && d.revenue === 0) ? (
            <div style={{ height: 300, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#d1d5db', fontSize: 13, fontWeight: 600 }}>
              {noData ? 'Trend data will appear once sales are recorded' : 'No trend data in this period'}
            </div>
          ) : (
            <div style={{ height: 300 }}>
              <ResponsiveContainer width="100%" height="100%">
                <LineChart
                  data={ins.monthlyTrends}
                  margin={{ top: 4, right: 28, left: -8, bottom: 0 }}
                >
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f3f4f6" />
                  <XAxis
                    dataKey="label"
                    axisLine={false} tickLine={false}
                    tick={{ fill: '#9ca3af', fontSize: 11 }}
                    interval="preserveStartEnd"
                  />
                  <YAxis
                    yAxisId="left"
                    axisLine={false} tickLine={false}
                    tick={{ fill: '#9ca3af', fontSize: 12 }}
                  />
                  <YAxis
                    yAxisId="right" orientation="right"
                    axisLine={false} tickLine={false}
                    tick={{ fill: '#9ca3af', fontSize: 12 }}
                    tickFormatter={v => v >= 1000 ? `${(v / 1000).toFixed(0)}K` : String(v)}
                  />
                  <Tooltip content={<ChartTooltip />} />
                  <Legend
                    verticalAlign="top" align="right"
                    iconType="circle" iconSize={8}
                    wrapperStyle={{ paddingBottom: 16, fontSize: 11, fontWeight: 600 }}
                    formatter={v => (
                      <span style={{ color: '#6b7280', fontWeight: 600, fontSize: 11 }}>{v}</span>
                    )}
                  />
                  <Line
                    yAxisId="left"
                    type="monotone" dataKey="sales" name="Sales (Units)"
                    stroke="#8b5cf6" strokeWidth={2.5}
                    dot={{ r: 4, fill: '#8b5cf6', stroke: '#fff', strokeWidth: 2 }}
                    activeDot={{ r: 7, strokeWidth: 0 }}
                  />
                  <Line
                    yAxisId="right"
                    type="monotone" dataKey="revenue" name="Revenue"
                    stroke="#10b981" strokeWidth={2.5}
                    dot={{ r: 4, fill: '#10b981', stroke: '#fff', strokeWidth: 2 }}
                    activeDot={{ r: 7, strokeWidth: 0 }}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>

      </div>
    </div>
  )
}