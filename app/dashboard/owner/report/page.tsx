'use client'

import { useEffect, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase'
import {
  Calendar, Users, FileText,
  Loader2, AlertTriangle, RefreshCcw, FileSpreadsheet,
} from 'lucide-react'

// ─── Logger ───────────────────────────────────────────────────────────────────
const log = {
  info:  (m: string, ...a: any[]) => console.info (`[Reports] ℹ️  ${m}`, ...a),
  warn:  (m: string, ...a: any[]) => console.warn (`[Reports] ⚠️  ${m}`, ...a),
  error: (m: string, ...a: any[]) => console.error(`[Reports] ❌  ${m}`, ...a),
  debug: (m: string, ...a: any[]) =>
    process.env.NODE_ENV === 'development' && console.debug(`[Reports] 🔍 ${m}`, ...a),
}

// ─── Types — exactly matching DB schema ──────────────────────────────────────

interface SaleRow {
  id:              string
  customer_name:   string | null
  customer_email:  string | null
  payment_method:  string | null
  items:           any
  total:           number
  subtotal:        number | null
  discount:        number | null
  company_id:      string
  created_at:      string
  user_id:         string | null
  created_by:      string | null
}

interface ProductRow {
  id:             number
  name:           string
  sku:            string
  price:          number
  stock_quantity: number
  category:       string
  company_id:     string
}

interface CompanyRow {
  id:          string
  name:        string
  address:     string | null
  city:        string | null
  phone:       string | null
  email:       string | null
  tax_number:  string | null
  tagline:     string | null
  logo_base64: string | null
}

interface ProfileRow {
  company_id:   string
  company_name: string | null
  full_name:    string | null
  email:        string | null
  role:         string | null
}

interface CustomerSummary {
  name:          string
  email:         string
  totalOrders:   number
  totalSpent:    number
  totalDiscount: number
  lastPurchase:  string
  sales:         SaleRow[]
}

type ReportPeriod = 'daily' | 'weekly' | 'monthly' | 'quarterly' | 'annual' | 'custom'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtMoney(n: number) {
  return `Rs. ${n.toLocaleString('en-PK', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-PK', { day: '2-digit', month: 'short', year: 'numeric' })
}

function parseItems(raw: any): any[] {
  if (!raw) return []
  if (Array.isArray(raw)) return raw
  if (typeof raw === 'string') { try { return JSON.parse(raw) ?? [] } catch { return [] } }
  return []
}

function getTax(s: SaleRow): number {
  if (s.subtotal != null && s.total != null) {
    const t = s.total - s.subtotal
    return t > 0 ? +t.toFixed(2) : 0
  }
  return 0
}

function getDiscount(s: SaleRow): number {
  return s.discount && s.discount > 0 ? s.discount : 0
}

function getItemName(item: any, prodMap: Map<number, ProductRow>): string {
  const pid  = item?.productId ?? item?.product_id ?? item?.id
  const prod = pid != null ? prodMap.get(Number(pid)) : null
  return prod?.name ?? item?.description ?? item?.name ?? 'Item'
}

function getPeriodRange(period: ReportPeriod): { from: Date; to: Date; label: string } {
  const now   = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  switch (period) {
    case 'daily':
      return { from: today, to: now, label: "Today's Sales Report" }
    case 'weekly': {
      const from = new Date(today); from.setDate(today.getDate() - 6)
      return { from, to: now, label: 'Weekly Sales Report (Last 7 Days)' }
    }
    case 'monthly': {
      const from = new Date(now.getFullYear(), now.getMonth(), 1)
      return { from, to: now, label: `Monthly Report — ${now.toLocaleString('default', { month: 'long', year: 'numeric' })}` }
    }
    case 'quarterly': {
      const from = new Date(now); from.setMonth(now.getMonth() - 3)
      return { from, to: now, label: 'Quarterly Sales Report (Last 3 Months)' }
    }
    case 'annual': {
      const from = new Date(now.getFullYear(), 0, 1)
      return { from, to: now, label: `Annual Report — ${now.getFullYear()}` }
    }
    default:
      return { from: today, to: now, label: 'Custom Range Report' }
  }
}

// ─── PDF Generator ────────────────────────────────────────────────────────────

async function generateFinancialPDF(
  sales:       SaleRow[],
  products:    ProductRow[],
  company:     CompanyRow,
  reportTitle: string,
  fromDate:    Date,
  toDate:      Date,
) {
  const jsPDFModule = await import('jspdf')
  const autoTable   = (await import('jspdf-autotable')).default
  const jsPDF       = jsPDFModule.default ?? (jsPDFModule as any).jsPDF

  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' })
  const W = doc.internal.pageSize.getWidth()
  const H = doc.internal.pageSize.getHeight()
  const mL = 14, mR = 14
  let y = 0

  const prodMap = new Map(products.map(p => [p.id, p]))

  doc.setFillColor(79, 70, 229)
  doc.rect(0, 0, W, 44, 'F')

  if (company.logo_base64) {
    try { doc.addImage(company.logo_base64, 'PNG', mL, 4, 20, 20) } catch { }
  }
  const tX = company.logo_base64 ? mL + 24 : mL

  doc.setTextColor(255, 255, 255)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(16)
  doc.text(company.name, tX, 13)

  doc.setFont('helvetica', 'normal')
  doc.setFontSize(8.5)
  const meta = [company.address, company.city, company.phone, company.email].filter(Boolean).join('  |  ')
  if (meta) doc.text(meta, tX, 21)
  if (company.tax_number) doc.text(`Tax No: ${company.tax_number}`, tX, 28)

  doc.setFont('helvetica', 'bold')
  doc.setFontSize(10.5)
  doc.text(reportTitle, mL, 37)
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(7.5)
  doc.text(
    `${fmtDate(fromDate.toISOString())} — ${fmtDate(toDate.toISOString())}`,
    W - mR, 37, { align: 'right' },
  )

  y = 52

  const totalRevenue  = sales.reduce((a, s) => a + (s.total || 0), 0)
  const totalSubtotal = sales.reduce((a, s) => a + (s.subtotal ?? s.total ?? 0), 0)
  const totalTax      = sales.reduce((a, s) => a + getTax(s), 0)
  const totalDiscount = sales.reduce((a, s) => a + getDiscount(s), 0)
  const avgOrder      = sales.length > 0 ? totalRevenue / sales.length : 0
  const uniqueCusts   = new Set(sales.map(s => s.customer_name || 'Walk-in')).size

  const kpis = [
    { label: 'Total Revenue',  value: fmtMoney(totalRevenue)  },
    { label: 'Subtotal',       value: fmtMoney(totalSubtotal) },
    { label: 'Tax (derived)',  value: fmtMoney(totalTax)      },
    { label: 'Total Discount', value: fmtMoney(totalDiscount) },
    { label: 'Avg Order',      value: fmtMoney(avgOrder)      },
    { label: 'Orders / Custs', value: `${sales.length} / ${uniqueCusts}` },
  ]
  const kpiW = (W - mL - mR) / 3
  kpis.forEach((kpi, i) => {
    const col = i % 3; const row = Math.floor(i / 3)
    const x = mL + col * kpiW; const bY = y + row * 18
    doc.setFillColor(238, 242, 255)
    doc.roundedRect(x, bY, kpiW - 3, 15, 2, 2, 'F')
    doc.setFontSize(6.5); doc.setFont('helvetica', 'normal'); doc.setTextColor(100, 116, 139)
    doc.text(kpi.label.toUpperCase(), x + 3, bY + 5)
    doc.setFontSize(9.5); doc.setFont('helvetica', 'bold'); doc.setTextColor(30, 27, 75)
    doc.text(kpi.value, x + 3, bY + 12)
  })
  y += 44

  const pageFooter = (data: any) => {
    const count = (doc as any).internal.getNumberOfPages()
    doc.setFontSize(6.5); doc.setFont('helvetica', 'normal'); doc.setTextColor(156, 163, 175)
    doc.text(`${company.name} — Confidential`, mL, H - 7)
    doc.text(
      `Generated ${fmtDate(new Date().toISOString())}   |   Page ${data.pageNumber} of ${count}`,
      W - mR, H - 7, { align: 'right' },
    )
  }

  doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.setTextColor(30, 27, 75)
  doc.text('Sales Transactions', mL, y)
  doc.setDrawColor(79, 70, 229); doc.setLineWidth(0.4)
  doc.line(mL, y + 1.5, mL + 45, y + 1.5)
  y += 5

  autoTable(doc, {
    startY: y,
    head: [['Date', 'Customer', 'Email', 'Payment', 'Items', 'Discount', 'Subtotal', 'Tax', 'Total']],
    body: sales.map(s => {
      const items   = parseItems(s.items)
      const itemTxt = items.length > 0
        ? items.slice(0, 3).map((it: any) => `${it?.quantity || 1}× ${getItemName(it, prodMap)}`).join(', ')
          + (items.length > 3 ? ` +${items.length - 3} more` : '')
        : '—'
      return [
        fmtDate(s.created_at),
        s.customer_name  || 'Walk-in',
        s.customer_email || '—',
        s.payment_method || '—',
        itemTxt,
        getDiscount(s) > 0 ? fmtMoney(getDiscount(s)) : '—',
        fmtMoney(s.subtotal ?? s.total ?? 0),
        getTax(s) > 0 ? fmtMoney(getTax(s)) : '—',
        fmtMoney(s.total || 0),
      ]
    }),
    theme: 'grid',
    styles: { font: 'helvetica', fontSize: 6.5, cellPadding: 1.8, overflow: 'linebreak' },
    headStyles: { fillColor: [79, 70, 229], textColor: 255, fontStyle: 'bold', fontSize: 7 },
    alternateRowStyles: { fillColor: [248, 250, 252] },
    columnStyles: {
      0: { cellWidth: 20 }, 1: { cellWidth: 24 }, 2: { cellWidth: 32 }, 3: { cellWidth: 18 },
      4: { cellWidth: 40 }, 5: { cellWidth: 16 }, 6: { cellWidth: 18 }, 7: { cellWidth: 14 }, 8: { cellWidth: 18 },
    },
    margin: { left: mL, right: mR },
    didDrawPage: pageFooter,
  })
  y = (doc as any).lastAutoTable.finalY + 10

  if (y > H - 70) { doc.addPage(); y = 20 }
  doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.setTextColor(30, 27, 75)
  doc.text('General Ledger — Revenue Summary', mL, y)
  doc.setDrawColor(79, 70, 229); doc.line(mL, y + 1.5, mL + 72, y + 1.5)
  y += 5

  const byDate: Record<string, { credit: number; tax: number; discount: number; count: number }> = {}
  for (const s of sales) {
    const k = fmtDate(s.created_at)
    if (!byDate[k]) byDate[k] = { credit: 0, tax: 0, discount: 0, count: 0 }
    byDate[k].credit   += s.total    || 0
    byDate[k].tax      += getTax(s)
    byDate[k].discount += getDiscount(s)
    byDate[k].count++
  }
  let runBal = 0
  autoTable(doc, {
    startY: y,
    head: [['Date', 'Account', 'Description', 'Discount', 'Tax', 'Revenue', 'Running Bal.']],
    body: Object.entries(byDate).map(([date, d]) => {
      runBal += d.credit
      return [
        date, 'Sales Revenue',
        `${d.count} transaction${d.count !== 1 ? 's' : ''}`,
        fmtMoney(d.discount), fmtMoney(d.tax), fmtMoney(d.credit), fmtMoney(runBal),
      ]
    }),
    foot: [['', '', 'TOTALS',
      fmtMoney(totalDiscount), fmtMoney(totalTax), fmtMoney(totalRevenue), fmtMoney(totalRevenue),
    ]],
    theme: 'grid',
    styles: { font: 'helvetica', fontSize: 7.5, cellPadding: 2 },
    headStyles: { fillColor: [30, 27, 75], textColor: 255, fontStyle: 'bold', fontSize: 8 },
    footStyles: { fillColor: [238, 242, 255], textColor: [30, 27, 75], fontStyle: 'bold' },
    alternateRowStyles: { fillColor: [248, 250, 252] },
    columnStyles: {
      0: { cellWidth: 24 }, 1: { cellWidth: 32 }, 2: { cellWidth: 34 },
      3: { cellWidth: 22 }, 4: { cellWidth: 18 }, 5: { cellWidth: 24 }, 6: { cellWidth: 26 },
    },
    margin: { left: mL, right: mR },
    didDrawPage: pageFooter,
  })
  y = (doc as any).lastAutoTable.finalY + 10

  if (y > H - 60) { doc.addPage(); y = 20 }
  doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.setTextColor(30, 27, 75)
  doc.text('Revenue by Payment Method', mL, y)
  doc.setDrawColor(79, 70, 229); doc.line(mL, y + 1.5, mL + 58, y + 1.5)
  y += 5

  const byPay: Record<string, { revenue: number; discount: number; count: number }> = {}
  for (const s of sales) {
    const k = s.payment_method || 'Unspecified'
    if (!byPay[k]) byPay[k] = { revenue: 0, discount: 0, count: 0 }
    byPay[k].revenue  += s.total    || 0
    byPay[k].discount += getDiscount(s)
    byPay[k].count++
  }
  autoTable(doc, {
    startY: y,
    head: [['Payment Method', 'Orders', 'Total Discount', 'Revenue', '% Share']],
    body: Object.entries(byPay).map(([method, d]) => [
      method, d.count, fmtMoney(d.discount), fmtMoney(d.revenue),
      totalRevenue > 0 ? `${((d.revenue / totalRevenue) * 100).toFixed(1)}%` : '0%',
    ]),
    theme: 'striped',
    styles: { font: 'helvetica', fontSize: 8, cellPadding: 2.5 },
    headStyles: { fillColor: [79, 70, 229], textColor: 255, fontStyle: 'bold' },
    margin: { left: mL, right: mR },
    didDrawPage: pageFooter,
  })

  const fileName = `${reportTitle.replace(/[^a-z0-9]/gi, '_')}_${new Date().toISOString().slice(0, 10)}.pdf`
  doc.save(fileName)
  log.info('PDF saved', { fileName, pages: (doc as any).internal.getNumberOfPages() })
}

// ─── Customer PDF ─────────────────────────────────────────────────────────────

async function generateCustomerPDF(
  customer: CustomerSummary,
  products: ProductRow[],
  company:  CompanyRow,
) {
  const jsPDFModule = await import('jspdf')
  const autoTable   = (await import('jspdf-autotable')).default
  const jsPDF       = jsPDFModule.default ?? (jsPDFModule as any).jsPDF

  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' })
  const W = doc.internal.pageSize.getWidth()
  const H = doc.internal.pageSize.getHeight()
  const mL = 14, mR = 14
  let y = 0

  const prodMap = new Map(products.map(p => [p.id, p]))

  doc.setFillColor(79, 70, 229); doc.rect(0, 0, W, 44, 'F')
  if (company.logo_base64) { try { doc.addImage(company.logo_base64, 'PNG', mL, 4, 20, 20) } catch { } }
  const tX = company.logo_base64 ? mL + 24 : mL
  doc.setTextColor(255, 255, 255); doc.setFont('helvetica', 'bold'); doc.setFontSize(15)
  doc.text(company.name, tX, 13)
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9)
  doc.text(`Customer Report — ${customer.name}`, tX, 21)
  const meta = [company.address, company.city, company.phone].filter(Boolean).join('  |  ')
  if (meta) doc.text(meta, tX, 28)
  doc.setFontSize(7.5)
  doc.text(`Generated: ${fmtDate(new Date().toISOString())}`, tX, 36)

  y = 52

  doc.setFillColor(238, 242, 255); doc.roundedRect(mL, y, W - mL - mR, 36, 3, 3, 'F')
  doc.setFont('helvetica', 'bold'); doc.setFontSize(12); doc.setTextColor(30, 27, 75)
  doc.text(customer.name, mL + 5, y + 9)
  doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(100, 116, 139)
  if (customer.email !== '—') doc.text(`Email: ${customer.email}`, mL + 5, y + 17)
  doc.text(`Total Orders: ${customer.totalOrders}`, mL + 5, y + 24)
  doc.text(`Total Spent: ${fmtMoney(customer.totalSpent)}`, mL + 70, y + 24)
  doc.text(`Total Discount: ${fmtMoney(customer.totalDiscount)}`, mL + 5, y + 31)
  doc.text(`Last Purchase: ${fmtDate(customer.lastPurchase)}`, mL + 70, y + 31)
  y += 44

  doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.setTextColor(30, 27, 75)
  doc.text('Purchase History', mL, y)
  doc.setDrawColor(79, 70, 229); doc.setLineWidth(0.4); doc.line(mL, y + 1.5, mL + 40, y + 1.5)
  y += 5

  autoTable(doc, {
    startY: y,
    head: [['Date', 'Items', 'Payment', 'Discount', 'Subtotal', 'Tax', 'Total']],
    body: customer.sales.map(s => [
      fmtDate(s.created_at),
      parseItems(s.items).map((it: any) => `${it?.quantity || 1}× ${getItemName(it, prodMap)}`).join(', ') || '—',
      s.payment_method || '—',
      getDiscount(s) > 0 ? fmtMoney(getDiscount(s)) : '—',
      fmtMoney(s.subtotal ?? s.total ?? 0),
      getTax(s) > 0 ? fmtMoney(getTax(s)) : '—',
      fmtMoney(s.total || 0),
    ]),
    foot: [['', '', '',
      fmtMoney(customer.totalDiscount),
      fmtMoney(customer.sales.reduce((a, s) => a + (s.subtotal ?? s.total ?? 0), 0)),
      fmtMoney(customer.sales.reduce((a, s) => a + getTax(s), 0)),
      fmtMoney(customer.totalSpent),
    ]],
    theme: 'grid',
    styles: { font: 'helvetica', fontSize: 7, cellPadding: 2 },
    headStyles: { fillColor: [79, 70, 229], textColor: 255, fontStyle: 'bold' },
    footStyles: { fillColor: [238, 242, 255], textColor: [30, 27, 75], fontStyle: 'bold' },
    alternateRowStyles: { fillColor: [248, 250, 252] },
    columnStyles: {
      0: { cellWidth: 22 }, 1: { cellWidth: 68 }, 2: { cellWidth: 20 },
      3: { cellWidth: 18 }, 4: { cellWidth: 20 }, 5: { cellWidth: 14 }, 6: { cellWidth: 20 },
    },
    margin: { left: mL, right: mR },
    didDrawPage: (data: any) => {
      const count = (doc as any).internal.getNumberOfPages()
      doc.setFontSize(6.5); doc.setFont('helvetica', 'normal'); doc.setTextColor(156, 163, 175)
      doc.text(`${company.name} — Confidential`, mL, H - 7)
      doc.text(`Page ${data.pageNumber} of ${count}`, W - mR, H - 7, { align: 'right' })
    },
  })

  const fileName = `Customer_${customer.name.replace(/\s+/g, '_')}_${new Date().toISOString().slice(0, 10)}.pdf`
  doc.save(fileName)
  log.info('Customer PDF saved', { customer: customer.name, fileName })
}

// ─── Excel General Ledger ─────────────────────────────────────────────────────

async function generateLedgerExcel(
  sales:       SaleRow[],
  products:    ProductRow[],
  company:     CompanyRow,
  reportTitle: string,
  fromDate:    Date,
  toDate:      Date,
) {
  const XLSX    = await import('xlsx')
  const prodMap = new Map(products.map(p => [p.id, p]))
  const wb      = XLSX.utils.book_new()

  let runBal = 0
  const wsLedger = XLSX.utils.aoa_to_sheet([
    [company.name],
    [[company.address, company.city, company.phone].filter(Boolean).join(' | ')],
    [company.tax_number ? `Tax No: ${company.tax_number}` : ''],
    [''],
    [reportTitle],
    [`Period: ${fmtDate(fromDate.toISOString())} to ${fmtDate(toDate.toISOString())}`],
    [`Generated: ${fmtDate(new Date().toISOString())}`],
    [''],
    ['Date', 'Transaction ID', 'Customer', 'Customer Email', 'Payment Method',
     'Items', 'Discount (Rs.)', 'Subtotal (Rs.)', 'Tax (Rs.)', 'Total (Rs.)', 'Running Balance (Rs.)'],
    ...sales.map(s => {
      runBal += s.total || 0
      return [
        fmtDate(s.created_at), s.id,
        s.customer_name  || 'Walk-in',
        s.customer_email || '—',
        s.payment_method || '—',
        parseItems(s.items).map((it: any) => `${it?.quantity || 1}× ${getItemName(it, prodMap)}`).join(', ') || '—',
        getDiscount(s),
        s.subtotal ?? s.total ?? 0,
        getTax(s),
        s.total || 0,
        runBal,
      ]
    }),
    [''],
    ['TOTALS', '', '', '', '', '',
      sales.reduce((a, s) => a + getDiscount(s), 0),
      sales.reduce((a, s) => a + (s.subtotal ?? s.total ?? 0), 0),
      sales.reduce((a, s) => a + getTax(s), 0),
      sales.reduce((a, s) => a + (s.total || 0), 0),
      runBal,
    ],
  ])
  wsLedger['!cols'] = [
    { wch: 14 }, { wch: 36 }, { wch: 22 }, { wch: 28 }, { wch: 18 },
    { wch: 50 }, { wch: 16 }, { wch: 16 }, { wch: 14 }, { wch: 16 }, { wch: 22 },
  ]
  XLSX.utils.book_append_sheet(wb, wsLedger, 'General Ledger')

  const custMap: Record<string, { name: string; email: string; orders: number; spent: number; discount: number; last: string }> = {}
  for (const s of sales) {
    const k = s.customer_name || 'Walk-in'
    if (!custMap[k]) custMap[k] = { name: k, email: s.customer_email || '—', orders: 0, spent: 0, discount: 0, last: s.created_at }
    custMap[k].orders++
    custMap[k].spent    += s.total    || 0
    custMap[k].discount += getDiscount(s)
    if (new Date(s.created_at) > new Date(custMap[k].last)) custMap[k].last = s.created_at
  }
  const wsCust = XLSX.utils.aoa_to_sheet([
    [company.name], ['Customer Summary'], [`Generated: ${fmtDate(new Date().toISOString())}`], [''],
    ['Customer', 'Email', 'Orders', 'Total Spent (Rs.)', 'Total Discount (Rs.)', 'Avg Order (Rs.)', 'Last Purchase'],
    ...Object.values(custMap).sort((a, b) => b.spent - a.spent).map(c => [
      c.name, c.email, c.orders,
      +c.spent.toFixed(2), +c.discount.toFixed(2),
      +(c.orders > 0 ? c.spent / c.orders : 0).toFixed(2),
      fmtDate(c.last),
    ]),
  ])
  wsCust['!cols'] = [{ wch: 24 }, { wch: 30 }, { wch: 10 }, { wch: 20 }, { wch: 22 }, { wch: 18 }, { wch: 16 }]
  XLSX.utils.book_append_sheet(wb, wsCust, 'Customer Summary')

  const byDay: Record<string, { revenue: number; tax: number; discount: number; orders: number }> = {}
  for (const s of sales) {
    const k = fmtDate(s.created_at)
    if (!byDay[k]) byDay[k] = { revenue: 0, tax: 0, discount: 0, orders: 0 }
    byDay[k].revenue  += s.total    || 0
    byDay[k].tax      += getTax(s)
    byDay[k].discount += getDiscount(s)
    byDay[k].orders++
  }
  const wsDaily = XLSX.utils.aoa_to_sheet([
    [company.name], ['Daily Sales Breakdown'], [''],
    ['Date', 'Orders', 'Discount (Rs.)', 'Tax (Rs.)', 'Revenue (Rs.)', 'Net Revenue (Rs.)'],
    ...Object.entries(byDay).map(([date, d]) => [
      date, d.orders, +d.discount.toFixed(2), +d.tax.toFixed(2),
      +d.revenue.toFixed(2), +(d.revenue - d.tax).toFixed(2),
    ]),
  ])
  wsDaily['!cols'] = [{ wch: 18 }, { wch: 10 }, { wch: 16 }, { wch: 14 }, { wch: 18 }, { wch: 20 }]
  XLSX.utils.book_append_sheet(wb, wsDaily, 'Daily Breakdown')

  const prodPerf: Record<string, { name: string; sku: string; category: string; qty: number; revenue: number }> = {}
  for (const s of sales) {
    for (const it of parseItems(s.items)) {
      const pid  = it?.productId ?? it?.product_id ?? it?.id
      const prod = pid != null ? prodMap.get(Number(pid)) : null
      const name = prod?.name ?? it?.description ?? it?.name ?? 'Unknown'
      const qty  = Number(it?.quantity) || 1
      const price= Number(it?.price) || prod?.price || 0
      if (!prodPerf[name]) prodPerf[name] = { name, sku: prod?.sku ?? '—', category: prod?.category ?? '—', qty: 0, revenue: 0 }
      prodPerf[name].qty     += qty
      prodPerf[name].revenue += qty * price
    }
  }
  const wsProd = XLSX.utils.aoa_to_sheet([
    [company.name], ['Product Performance'], [''],
    ['Product', 'SKU', 'Category', 'Units Sold', 'Revenue (Rs.)'],
    ...Object.values(prodPerf).sort((a, b) => b.revenue - a.revenue).map(p => [
      p.name, p.sku, p.category, p.qty, +p.revenue.toFixed(2),
    ]),
  ])
  wsProd['!cols'] = [{ wch: 30 }, { wch: 16 }, { wch: 18 }, { wch: 14 }, { wch: 18 }]
  XLSX.utils.book_append_sheet(wb, wsProd, 'Product Performance')

  const totRev = sales.reduce((a, s) => a + (s.total || 0), 0)
  const byPaySheet: Record<string, { revenue: number; discount: number; orders: number }> = {}
  for (const s of sales) {
    const k = s.payment_method || 'Unspecified'
    if (!byPaySheet[k]) byPaySheet[k] = { revenue: 0, discount: 0, orders: 0 }
    byPaySheet[k].revenue  += s.total    || 0
    byPaySheet[k].discount += getDiscount(s)
    byPaySheet[k].orders++
  }
  const wsPay = XLSX.utils.aoa_to_sheet([
    [company.name], ['Payment Method Breakdown'], [''],
    ['Payment Method', 'Orders', 'Discount (Rs.)', 'Revenue (Rs.)', '% Share'],
    ...Object.entries(byPaySheet).map(([m, d]) => [
      m, d.orders, +d.discount.toFixed(2), +d.revenue.toFixed(2),
      totRev > 0 ? +((d.revenue / totRev) * 100).toFixed(2) : 0,
    ]),
  ])
  wsPay['!cols'] = [{ wch: 22 }, { wch: 10 }, { wch: 18 }, { wch: 18 }, { wch: 12 }]
  XLSX.utils.book_append_sheet(wb, wsPay, 'Payment Methods')

  const fileName = `General_Ledger_${company.name.replace(/\s+/g, '_')}_${new Date().toISOString().slice(0, 10)}.xlsx`
  XLSX.writeFile(wb, fileName)
  log.info('Excel saved', { fileName, sheets: 5 })
}

// ─── Report Card UI ───────────────────────────────────────────────────────────

function ReportCard({
  icon, title, subtitle, iconBg, generating, onPDF, onExcel,
}: {
  icon:       React.ReactNode
  title:      string
  subtitle:   string
  iconBg:     string
  generating: boolean
  onPDF:      () => void
  onExcel:    () => void
}) {
  return (
    <div style={{
      border: '1.5px solid #e5e7eb', borderRadius: 16, padding: '20px 12px',
      background: '#fff', display: 'flex', flexDirection: 'column',
      alignItems: 'center', gap: 8, minHeight: 170,
    }}>
      <div style={{ width: 52, height: 52, borderRadius: 14, background: iconBg, display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 2 }}>
        {icon}
      </div>
      <p style={{ fontSize: 13, fontWeight: 800, color: '#111827', margin: 0, textAlign: 'center' }}>{title}</p>
      <p style={{ fontSize: 11, color: '#9ca3af', margin: 0, textAlign: 'center' }}>{subtitle}</p>
      <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
        <button onClick={onPDF} disabled={generating} style={{
          display: 'flex', alignItems: 'center', gap: 4,
          padding: '5px 11px', borderRadius: 8, border: 'none',
          background: generating ? '#e5e7eb' : '#4f46e5',
          color: generating ? '#9ca3af' : '#fff',
          fontSize: 10, fontWeight: 700, cursor: generating ? 'not-allowed' : 'pointer',
        }}>
          {generating ? <Loader2 size={10} className="animate-spin" /> : <FileText size={10} />} PDF
        </button>
        <button onClick={onExcel} disabled={generating} style={{
          display: 'flex', alignItems: 'center', gap: 4,
          padding: '5px 11px', borderRadius: 8, border: 'none',
          background: generating ? '#e5e7eb' : '#059669',
          color: generating ? '#9ca3af' : '#fff',
          fontSize: 10, fontWeight: 700, cursor: generating ? 'not-allowed' : 'pointer',
        }}>
          {generating ? <Loader2 size={10} className="animate-spin" /> : <FileSpreadsheet size={10} />} Excel
        </button>
      </div>
    </div>
  )
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function ReportGeneration() {
  const router = useRouter()

  const [loading,    setLoading]    = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [sales,      setSales]      = useState<SaleRow[]>([])
  const [products,   setProducts]   = useState<ProductRow[]>([])
  const [company,    setCompany]    = useState<CompanyRow>({
    id: '', name: 'Your Company', address: null, city: null,
    phone: null, email: null, tax_number: null, tagline: null, logo_base64: null,
  })
  const [errorMsg,   setErrorMsg]   = useState<string | null>(null)
  const [fromDate,   setFromDate]   = useState('')
  const [toDate,     setToDate]     = useState('')
  const [generating, setGenerating] = useState<string | null>(null)

  // ── Fetch ──────────────────────────────────────────────────────────────────

  const fetchData = useCallback(async (quiet = false) => {
    quiet ? setRefreshing(true) : setLoading(true)
    setErrorMsg(null)
    log.info('Fetching…', { quiet })

    try {
      const { data: { session }, error: sessErr } = await supabase.auth.getSession()
      if (sessErr) {
        log.error('Session error', { message: sessErr.message, status: sessErr.status })
        router.push('/login'); return
      }
      if (!session?.user) { log.warn('No session'); router.push('/login'); return }

      const { data: profile, error: profErr } = await supabase
        .from('profiles')
        .select('company_id, company_name, full_name, email, role')
        .eq('id', session.user.id)
        .single<ProfileRow>()

      if (profErr) {
        log.error('Profile error', { message: profErr.message, code: profErr.code, hint: profErr.hint, details: profErr.details })
        setErrorMsg('Could not load company profile.'); return
      }
      if (!profile?.company_id) {
        log.warn('No company_id', { userId: session.user.id })
        setErrorMsg('No company linked to this account.'); return
      }

      const lookback = new Date(); lookback.setFullYear(lookback.getFullYear() - 5)

      const [salesRes, prodRes, compRes] = await Promise.all([
        supabase
          .from('sales')
          .select('id, customer_name, customer_email, payment_method, items, total, subtotal, discount, company_id, created_at, user_id, created_by')
          .eq('company_id', profile.company_id)
          .gte('created_at', lookback.toISOString())
          .order('created_at', { ascending: false })
          .limit(10000),
        supabase
          .from('products')
          .select('id, name, sku, price, stock_quantity, category, company_id')
          .eq('company_id', profile.company_id)
          .limit(1000),
        supabase
          .from('companies')
          .select('id, name, address, city, phone, email, tax_number, tagline, logo_base64')
          .eq('id', profile.company_id)
          .single<CompanyRow>(),
      ])

      if (salesRes.error) {
        log.error('Sales error', { message: salesRes.error.message, code: salesRes.error.code, details: salesRes.error.details, hint: salesRes.error.hint })
        throw new Error(`Sales: ${salesRes.error.message}`)
      }
      if (prodRes.error) {
        log.error('Products error', { message: prodRes.error.message, code: prodRes.error.code, details: prodRes.error.details, hint: prodRes.error.hint })
        throw new Error(`Products: ${prodRes.error.message}`)
      }
      if (compRes.error) {
        log.warn('Company fetch warning (non-fatal)', { message: compRes.error.message, code: compRes.error.code })
        setCompany(prev => ({ ...prev, name: profile.company_name || 'Your Company' }))
      } else if (compRes.data) {
        setCompany(compRes.data)
      }

      setSales(salesRes.data   ?? [])
      setProducts(prodRes.data ?? [])
      log.info('Fetch complete', { sales: salesRes.data?.length, products: prodRes.data?.length, company: compRes.data?.name })

    } catch (err: any) {
      log.error('Unhandled error', { message: err?.message, stack: err?.stack })
      setErrorMsg(err?.message ?? 'Unexpected error. Check browser console.')
    } finally {
      setLoading(false); setRefreshing(false)
    }
  }, [router])

  useEffect(() => { fetchData() }, [fetchData])

  // ── Filter ─────────────────────────────────────────────────────────────────

  const filterSales = useCallback((from: Date, to: Date) =>
    sales.filter(s => { const d = new Date(s.created_at); return d >= from && d <= to }),
  [sales])

  // ── Handlers ───────────────────────────────────────────────────────────────

  const handleTimePDF = useCallback(async (period: ReportPeriod) => {
    setGenerating(`time-${period}`)
    try {
      let from: Date, to: Date, label: string
      if (period === 'custom') {
        if (!fromDate || !toDate) { alert('Please select From and To dates.'); return }
        from = new Date(fromDate); to = new Date(toDate + 'T23:59:59'); label = 'Custom Range Report'
      } else {
        const r = getPeriodRange(period); from = r.from; to = r.to; label = r.label
      }
      const filtered = filterSales(from, to)
      if (filtered.length === 0) { alert('No sales found for this period.'); return }
      await generateFinancialPDF(filtered, products, company, label, from, to)
    } catch (err: any) {
      log.error('PDF error', { period, message: err.message, stack: err.stack })
      alert('PDF generation failed. See console for details.')
    } finally { setGenerating(null) }
  }, [sales, products, company, fromDate, toDate, filterSales])

  const handleTimeExcel = useCallback(async (period: ReportPeriod) => {
    setGenerating(`excel-${period}`)
    try {
      let from: Date, to: Date, label: string
      if (period === 'custom') {
        if (!fromDate || !toDate) { alert('Please select From and To dates.'); return }
        from = new Date(fromDate); to = new Date(toDate + 'T23:59:59'); label = 'Custom Range General Ledger'
      } else {
        const r = getPeriodRange(period); from = r.from; to = r.to; label = r.label
      }
      const filtered = filterSales(from, to)
      if (filtered.length === 0) { alert('No sales found for this period.'); return }
      await generateLedgerExcel(filtered, products, company, label, from, to)
    } catch (err: any) {
      log.error('Excel error', { period, message: err.message, stack: err.stack })
      alert('Excel generation failed. See console for details.')
    } finally { setGenerating(null) }
  }, [sales, products, company, fromDate, toDate, filterSales])

  const handleCustomerReport = useCallback(async (customer: CustomerSummary) => {
    setGenerating(`cust-${customer.name}`)
    try {
      await generateCustomerPDF(customer, products, company)
    } catch (err: any) {
      log.error('Customer PDF error', { customer: customer.name, message: err.message })
      alert('Customer report failed. See console for details.')
    } finally { setGenerating(null) }
  }, [products, company])

  // ── Customer summaries ─────────────────────────────────────────────────────

  const customers: CustomerSummary[] = (() => {
    const map: Record<string, CustomerSummary> = {}
    for (const s of sales) {
      const k = s.customer_name || 'Walk-in'
      if (!map[k]) map[k] = { name: k, email: s.customer_email || '—', totalOrders: 0, totalSpent: 0, totalDiscount: 0, lastPurchase: s.created_at, sales: [] }
      map[k].totalOrders++
      map[k].totalSpent    += s.total    || 0
      map[k].totalDiscount += getDiscount(s)
      if (new Date(s.created_at) > new Date(map[k].lastPurchase)) map[k].lastPurchase = s.created_at
      map[k].sales.push(s)
    }
    return Object.values(map).sort((a, b) => b.totalSpent - a.totalSpent)
  })()

  // ── Loading / Error ────────────────────────────────────────────────────────

  if (loading) return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', background: '#f8f9fc', fontFamily: 'system-ui, sans-serif' }}>
      <Loader2 className="animate-spin" size={22} style={{ color: '#4f46e5', marginRight: 10 }} />
      <span style={{ fontSize: 14, fontWeight: 700, color: '#9ca3af' }}>Loading reports…</span>
    </div>
  )

  if (errorMsg) return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100vh', gap: 14, background: '#f8f9fc', fontFamily: 'system-ui, sans-serif' }}>
      <AlertTriangle size={32} style={{ color: '#ef4444' }} />
      <p style={{ fontSize: 13, fontWeight: 600, color: '#6b7280', maxWidth: 320, textAlign: 'center', margin: 0 }}>{errorMsg}</p>
      <button onClick={() => fetchData()} style={{ padding: '8px 22px', background: '#4f46e5', color: '#fff', border: 'none', borderRadius: 10, fontWeight: 700, fontSize: 13, cursor: 'pointer' }}>Retry</button>
    </div>
  )

  const reportCards: { period: ReportPeriod; title: string; subtitle: string; iconBg: string; iconColor: string }[] = [
    { period: 'daily',     title: 'Daily Report',     subtitle: "Today's sales", iconBg: '#ede9fe', iconColor: '#7c3aed' },
    { period: 'weekly',    title: 'Weekly Report',    subtitle: 'Last 7 days',   iconBg: '#ede9fe', iconColor: '#8b5cf6' },
    { period: 'monthly',   title: 'Monthly Report',   subtitle: 'Current month', iconBg: '#dbeafe', iconColor: '#2563eb' },
    { period: 'quarterly', title: 'Quarterly Report', subtitle: 'Last 3 months', iconBg: '#d1fae5', iconColor: '#059669' },
    { period: 'annual',    title: 'Annual Report',    subtitle: 'Full year',     iconBg: '#ffedd5', iconColor: '#ea580c' },
  ]

  // ─── Render ────────────────────────────────────────────────────────────────

  return (
    <div style={{ background: '#f8f9fc', minHeight: '100vh', fontFamily: 'system-ui, -apple-system, sans-serif' }}>

      {/* ─────────────────────────────────────────────────────────────────────
          Mobile-only responsive overrides (≤ 640 px).
          Desktop layout (> 640 px) is 100% unchanged.
         ───────────────────────────────────────────────────────────────────── */}
      <style>{`

        /* ── Page wrapper padding ── */
        .rg-page { padding: 28px 32px; }
        @media (max-width: 640px) {
          .rg-page { padding: 20px 16px; }
        }

        /* ── Page header: stack on mobile ── */
        .rg-header {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          margin-bottom: 28px;
        }
        @media (max-width: 640px) {
          .rg-header {
            flex-direction: column;
            gap: 12px;
            margin-bottom: 20px;
          }
          .rg-header h1 { font-size: 19px !important; }
          /* Refresh button: full-width touch target */
          .rg-refresh-btn {
            width: 100% !important;
            justify-content: center !important;
            padding: 10px 16px !important;
          }
        }

        /* ── Section card padding ── */
        .rg-section { padding: 28px; }
        @media (max-width: 640px) {
          .rg-section { padding: 16px !important; border-radius: 14px !important; }
        }

        /* ── Date picker grid: side-by-side on desktop, stacked on mobile ── */
        .rg-datepicker-grid {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 16px;
          margin-bottom: 22px;
        }
        @media (max-width: 480px) {
          .rg-datepicker-grid {
            grid-template-columns: 1fr;
          }
        }

        /* ── Custom-range download buttons: side-by-side → stacked ── */
        .rg-custom-btns {
          display: flex;
          gap: 10px;
          margin-bottom: 22px;
          flex-wrap: wrap;
        }
        @media (max-width: 480px) {
          .rg-custom-btns { flex-direction: column; }
          .rg-custom-btns button {
            width: 100% !important;
            justify-content: center !important;
            padding: 11px 16px !important;
            font-size: 13px !important;
          }
        }

        /* ── Report cards grid: 5 col desktop → 2 col mobile ── */
        .rg-cards-grid {
          display: grid;
          grid-template-columns: repeat(5, 1fr);
          gap: 14px;
        }
        @media (max-width: 900px) {
          .rg-cards-grid { grid-template-columns: repeat(3, 1fr); }
        }
        @media (max-width: 560px) {
          .rg-cards-grid { grid-template-columns: repeat(2, 1fr); gap: 10px; }
        }
        @media (max-width: 360px) {
          .rg-cards-grid { grid-template-columns: 1fr; }
        }

        /* ── Customer table: scrollable on mobile, no layout changes on desktop ── */
        .rg-table-wrap { overflow-x: auto; -webkit-overflow-scrolling: touch; }
        @media (max-width: 640px) {
          /* Make the table wide enough to scroll comfortably */
          .rg-table-wrap table { min-width: 680px; }
          /* Tighten cell padding */
          .rg-table-wrap td,
          .rg-table-wrap th { padding: 12px 10px !important; }
          /* Generate Report button: smaller on tight screens */
          .rg-gen-btn {
            padding: 7px 12px !important;
            font-size: 11px !important;
          }
        }

        /* ── Section heading row ── */
        @media (max-width: 640px) {
          .rg-section-title { font-size: 14px !important; }
        }
      `}</style>

      <div className="rg-page" style={{ maxWidth: 1300, margin: '0 auto' }}>

        {/* ── Header ── */}
        <div className="rg-header">
          <div>
            <h1 style={{ fontSize: 22, fontWeight: 900, color: '#111827', margin: 0 }}>
              Report Generation
            </h1>
            <p style={{ fontSize: 13, color: '#6b7280', marginTop: 4, marginBottom: 0 }}>
              Create and download various business reports
            </p>
          </div>
          <button
            onClick={() => fetchData(true)}
            className="rg-refresh-btn"
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '8px 16px', background: '#fff',
              border: '1px solid #e5e7eb', borderRadius: 10,
              fontSize: 13, fontWeight: 600, color: '#6b7280',
              cursor: 'pointer', boxShadow: '0 1px 3px rgba(0,0,0,0.06)',
            }}
          >
            <RefreshCcw size={13} className={refreshing ? 'animate-spin' : ''} /> Refresh
          </button>
        </div>

        {/* ── Time-based Reports ── */}
        <div
          className="rg-section"
          style={{
            background: '#fff', borderRadius: 18, border: '1px solid #e5e7eb',
            boxShadow: '0 1px 4px rgba(0,0,0,0.06)', marginBottom: 24,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 24 }}>
            <div style={{ width: 32, height: 32, borderRadius: 8, background: '#ede9fe', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <Calendar size={17} style={{ color: '#7c3aed' }} />
            </div>
            <h2 className="rg-section-title" style={{ fontSize: 16, fontWeight: 800, color: '#111827', margin: 0 }}>
              Time-based Reports
            </h2>
          </div>

          {/* Date pickers */}
          <div className="rg-datepicker-grid">
            {[{ label: 'From Date', val: fromDate, set: setFromDate }, { label: 'To Date', val: toDate, set: setToDate }].map(({ label, val, set }) => (
              <div key={label}>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 700, color: '#374151', marginBottom: 6 }}>
                  {label}
                </label>
                <input
                  type="date"
                  value={val}
                  onChange={e => set(e.target.value)}
                  style={{
                    width: '100%', padding: '10px 14px', boxSizing: 'border-box',
                    border: '1.5px solid #e5e7eb', borderRadius: 10,
                    fontSize: 13, color: '#374151', background: '#fff', outline: 'none',
                  }}
                />
              </div>
            ))}
          </div>

          {/* Custom range buttons */}
          {fromDate && toDate && (
            <div className="rg-custom-btns">
              <button
                onClick={() => handleTimePDF('custom')}
                disabled={!!generating}
                style={{
                  display: 'flex', alignItems: 'center', gap: 7,
                  padding: '9px 20px', borderRadius: 10, border: 'none',
                  background: generating ? '#e5e7eb' : '#4f46e5',
                  color: generating ? '#9ca3af' : '#fff',
                  fontSize: 13, fontWeight: 700, cursor: generating ? 'not-allowed' : 'pointer',
                }}
              >
                {generating === 'time-custom'
                  ? <Loader2 size={14} className="animate-spin" />
                  : <FileText size={14} />}
                Download Custom PDF
              </button>
              <button
                onClick={() => handleTimeExcel('custom')}
                disabled={!!generating}
                style={{
                  display: 'flex', alignItems: 'center', gap: 7,
                  padding: '9px 20px', borderRadius: 10, border: 'none',
                  background: generating ? '#e5e7eb' : '#059669',
                  color: generating ? '#9ca3af' : '#fff',
                  fontSize: 13, fontWeight: 700, cursor: generating ? 'not-allowed' : 'pointer',
                }}
              >
                {generating === 'excel-custom'
                  ? <Loader2 size={14} className="animate-spin" />
                  : <FileSpreadsheet size={14} />}
                Download General Ledger Excel
              </button>
            </div>
          )}

          {/* Report cards */}
          <div className="rg-cards-grid">
            {reportCards.map(card => (
              <ReportCard
                key={card.period}
                icon={<FileText size={22} style={{ color: card.iconColor }} />}
                title={card.title}
                subtitle={card.subtitle}
                iconBg={card.iconBg}
                generating={generating === `time-${card.period}` || generating === `excel-${card.period}`}
                onPDF={()   => handleTimePDF(card.period)}
                onExcel={() => handleTimeExcel(card.period)}
              />
            ))}
          </div>
        </div>

        {/* ── Customer Purchase History ── */}
        <div
          className="rg-section"
          style={{
            background: '#fff', borderRadius: 18, border: '1px solid #e5e7eb',
            boxShadow: '0 1px 4px rgba(0,0,0,0.06)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 24 }}>
            <div style={{ width: 32, height: 32, borderRadius: 8, background: '#dbeafe', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <Users size={17} style={{ color: '#2563eb' }} />
            </div>
            <h2 className="rg-section-title" style={{ fontSize: 16, fontWeight: 800, color: '#111827', margin: 0 }}>
              Customer Purchase History
            </h2>
          </div>

          {customers.length === 0 ? (
            <div style={{ padding: '48px 0', textAlign: 'center', color: '#d1d5db', fontSize: 13, fontWeight: 600 }}>
              No customer data found.
            </div>
          ) : (
            <div className="rg-table-wrap">
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ borderBottom: '2px solid #f3f4f6' }}>
                    {['CUSTOMER', 'EMAIL', 'TOTAL PURCHASES', 'TOTAL SPENT', 'TOTAL DISCOUNT', 'LAST PURCHASE', 'ACTIONS'].map(h => (
                      <th
                        key={h}
                        style={{
                          padding: '10px 16px', textAlign: 'left',
                          fontSize: 11, fontWeight: 700, color: '#9ca3af',
                          letterSpacing: '0.05em', whiteSpace: 'nowrap',
                        }}
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {customers.map((cust, idx) => (
                    <tr
                      key={cust.name}
                      style={{
                        borderBottom: idx < customers.length - 1 ? '1px solid #f3f4f6' : 'none',
                        transition: 'background 0.15s',
                      }}
                      onMouseEnter={e => (e.currentTarget.style.background = '#fafafa')}
                      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                    >
                      <td style={{ padding: '16px', fontSize: 14, fontWeight: 700, color: '#111827', whiteSpace: 'nowrap' }}>
                        {cust.name}
                      </td>
                      <td style={{ padding: '16px', fontSize: 13, color: '#6b7280' }}>
                        {cust.email}
                      </td>
                      <td style={{ padding: '16px', fontSize: 13, color: '#374151' }}>
                        {cust.totalOrders} order{cust.totalOrders !== 1 ? 's' : ''}
                      </td>
                      <td style={{ padding: '16px', fontSize: 13, fontWeight: 600, color: '#111827' }}>
                        {fmtMoney(cust.totalSpent)}
                      </td>
                      <td style={{ padding: '16px', fontSize: 13, color: cust.totalDiscount > 0 ? '#059669' : '#9ca3af' }}>
                        {cust.totalDiscount > 0 ? fmtMoney(cust.totalDiscount) : '—'}
                      </td>
                      <td style={{ padding: '16px', fontSize: 12, color: '#6b7280', whiteSpace: 'nowrap' }}>
                        {fmtDate(cust.lastPurchase)}
                      </td>
                      <td style={{ padding: '16px' }}>
                        <button
                          onClick={() => handleCustomerReport(cust)}
                          disabled={!!generating}
                          className="rg-gen-btn"
                          style={{
                            display: 'inline-flex', alignItems: 'center', gap: 7,
                            padding: '8px 16px', borderRadius: 10, border: 'none',
                            background: generating === `cust-${cust.name}` ? '#e5e7eb' : '#4f46e5',
                            color: generating === `cust-${cust.name}` ? '#9ca3af' : '#fff',
                            fontSize: 12, fontWeight: 700,
                            cursor: generating ? 'not-allowed' : 'pointer', whiteSpace: 'nowrap',
                          }}
                        >
                          {generating === `cust-${cust.name}`
                            ? <Loader2 size={13} className="animate-spin" />
                            : <FileText size={13} />}
                          Generate Report
                        </button>
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