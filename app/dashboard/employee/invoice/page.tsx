'use client'

import { useEffect, useState, useCallback, useRef, useMemo } from 'react'
import {
  Plus, Trash2, Printer, Loader2,
  WifiOff, Cloud, CheckCircle2, History,
  X, RefreshCcw, Trash, AlertTriangle, Save,
  FileText, Mail, Phone, MapPin,
  Banknote, Clock, FileCheck, Landmark, Hash,
  Lock, Edit2,
} from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { get, set, del } from 'idb-keyval'
import { useSessionRefresh } from '@/lib/use-session-refresh'

// ─── Types ────────────────────────────────────────────────────────────────────

interface InvoiceItem {
  id:          string
  description: string
  quantity:    number
  price:       number
  maxStock?:   number
  productId?:  number
}

type PaymentMethod = 'Cash' | 'Credit' | 'Cheque' | 'Bank Transfer'
type PaymentStatus = 'paid' | 'credit' | 'partial'

interface SaleRecord {
  id:               string
  customer_name:    string
  customer_email?:  string
  customer_phone?:  string
  customer_address?: string
  invoice_number?:  string
  invoice_date?:    string
  due_date?:        string
  notes?:           string
  payment_method?:  PaymentMethod
  payment_status?:  PaymentStatus
  bank_name?:       string
  cheque_number?:   string
  items:            InvoiceItem[]
  subtotal:         number
  discount:         number
  total:            number
  tax_rate?:        number
  created_at:       string
  company_id?:      string
  created_by?:      string
  is_pending?:      boolean
}

// ─── DB Helpers ───────────────────────────────────────────────────────────────

/** Strip local-only fields before Supabase insert/update */
function toDbRecord(sale: SaleRecord) {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { is_pending, ...rest } = sale as any

  // Only keep bank_name / cheque_number when relevant
  if (rest.payment_method !== 'Bank Transfer') delete rest.bank_name
  if (rest.payment_method !== 'Cheque')        delete rest.cheque_number

  return rest
}

// ─── PDF Cache ────────────────────────────────────────────────────────────────

let cachedJsPDF: any     = null
let cachedAutoTable: any = null

async function getPDFLibs() {
  if (!cachedJsPDF || !cachedAutoTable) {
    const [{ default: jsPDF }, { default: autoTable }] = await Promise.all([
      import('jspdf'),
      import('jspdf-autotable'),
    ])
    cachedJsPDF = jsPDF; cachedAutoTable = autoTable
  }
  return { jsPDF: cachedJsPDF, autoTable: cachedAutoTable }
}

// ─── Company Profile Cache ────────────────────────────────────────────────────

interface CompanyProfile {
  name: string; address?: string | null; city?: string | null
  phone?: string | null; email?: string | null; website?: string | null
  tax_number?: string | null; tagline?: string | null; logo_base64?: string | null
  cached_at: number
}

const PROFILE_TTL_MS = 24 * 60 * 60 * 1000

async function readCachedProfile(cid: string): Promise<CompanyProfile | null> {
  try {
    const c: CompanyProfile | undefined = await get(`company_profile:${cid}`)
    if (!c || Date.now() - c.cached_at > PROFILE_TTL_MS) return null
    return c
  } catch { return null }
}

async function fetchAndCacheProfile(cid: string) {
  try {
    const { data, error } = await supabase
      .from('companies')
      .select('name, address, city, phone, email, website, tax_number, tagline, logo_base64')
      .eq('id', cid).single()
    if (error || !data) return
    await set(`company_profile:${cid}`, { ...data, cached_at: Date.now() })
  } catch { }
}

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_TAX_RATE   = 0.10
const SEARCH_DEBOUNCE_MS = 300
const BATCH_SIZE         = 50
const MAX_QUEUE_SIZE     = 500

function generateInvoiceNumber() { return `INV-${Date.now()}` }
function today() { return new Date().toISOString().split('T')[0] }

// ─── Payment Method Config ────────────────────────────────────────────────────

const PAYMENT_METHODS: { value: PaymentMethod; label: string; icon: React.ReactNode; status: PaymentStatus }[] = [
  { value: 'Cash',          label: 'Cash',          icon: <Banknote size={16} />,  status: 'paid'   },
  { value: 'Credit',        label: 'Credit',        icon: <Clock size={16} />,     status: 'credit' },
  { value: 'Cheque',        label: 'Cheque',        icon: <FileCheck size={16} />, status: 'paid'   },
  { value: 'Bank Transfer', label: 'Bank Transfer', icon: <Landmark size={16} />,  status: 'paid'   },
]

const COMMON_BANKS = [
  'HBL – Habib Bank Limited',
  'UBL – United Bank Limited',
  'MCB – Muslim Commercial Bank',
  'Allied Bank',
  'Bank Alfalah',
  'Meezan Bank',
  'Standard Chartered',
  'Faysal Bank',
  'Askari Bank',
  'Silk Bank',
  'Other',
]

// ─── Shared Styles ────────────────────────────────────────────────────────────

const inputCls = 'w-full border border-gray-200 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent bg-white transition-shadow'
const labelCls = 'text-xs font-semibold text-gray-500 mb-1 block'

// ─── Component ────────────────────────────────────────────────────────────────

export default function CreateInvoice() {
  useSessionRefresh()

  // ── Invoice meta ──────────────────────────────────────────────────────────
  const [invoiceNumber, setInvoiceNumber] = useState(generateInvoiceNumber)
  const [invoiceDate,   setInvoiceDate]   = useState(today)
  const [dueDate,       setDueDate]       = useState('')

  // ── Customer ──────────────────────────────────────────────────────────────
  const [customerName,    setCustomerName]    = useState('')
  const [customerEmail,   setCustomerEmail]   = useState('')
  const [customerPhone,   setCustomerPhone]   = useState('')
  const [customerAddress, setCustomerAddress] = useState('')

  // ── Items ─────────────────────────────────────────────────────────────────
  const [items, setItems] = useState<InvoiceItem[]>([
    { id: crypto.randomUUID(), description: '', quantity: 1, price: 0 },
  ])

  // ── Payment ───────────────────────────────────────────────────────────────
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('Cash')
  const [paymentStatus, setPaymentStatus] = useState<PaymentStatus>('paid')
  const [bankName,      setBankName]      = useState('')
  const [chequeNumber,  setChequeNumber]  = useState('')

  // ── Financials ────────────────────────────────────────────────────────────
  const [discount, setDiscount] = useState(0)
  const [taxRate,  setTaxRate]  = useState(DEFAULT_TAX_RATE)
  const [notes,    setNotes]    = useState('')

  // ── UI state ──────────────────────────────────────────────────────────────
  const [isSaving,       setIsSaving]       = useState(false)
  const [searchResults,  setSearchResults]  = useState<any[]>([])
  const [activeSearchId, setActiveSearchId] = useState<string | null>(null)
  const [isOnline,       setIsOnline]       = useState(true)
  const [syncing,        setSyncing]        = useState(false)
  const [syncProgress,   setSyncProgress]   = useState('')
  const [showHistory,    setShowHistory]    = useState(false)
  const [historySales,   setHistorySales]   = useState<SaleRecord[]>([])
  const [queueSize,      setQueueSize]      = useState(0)

  // ── Edit mode ─────────────────────────────────────────────────────────────
  const [editingId,      setEditingId]      = useState<string | null>(null)

  // ── Refs ──────────────────────────────────────────────────────────────────
  const companyIdRef   = useRef<string | null>(null)
  const userIdRef      = useRef<string | null>(null)
  const syncLock       = useRef(false)
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const dropdownRef    = useRef<HTMLDivElement>(null)
  const inputRefs      = useRef<Map<string, HTMLInputElement>>(new Map())
  const [dropdownPos, setDropdownPos] = useState<{ top: number; left: number; width: number } | null>(null)

  // ── Calculations ──────────────────────────────────────────────────────────

  const { subtotal, tax, total } = useMemo(() => {
    const subtotal  = items.reduce((acc, i) => acc + i.quantity * i.price, 0)
    const after     = Math.max(0, subtotal - discount)
    const tax       = after * taxRate
    return { subtotal, tax, total: after + tax }
  }, [items, discount, taxRate])

  const hasStockError = useMemo(
    () => items.some(i => i.maxStock !== undefined && i.quantity > i.maxStock),
    [items]
  )

  const isFormInvalid = useMemo(
    () => items.every(i => i.description.trim() === '') || hasStockError,
    [items, hasStockError]
  )

  const handlePaymentMethodChange = useCallback((method: PaymentMethod) => {
    setPaymentMethod(method)
    const cfg = PAYMENT_METHODS.find(m => m.value === method)
    setPaymentStatus(cfg?.status ?? 'paid')
    if (method !== 'Bank Transfer') setBankName('')
    if (method !== 'Cheque')        setChequeNumber('')
  }, [])

  // ── Init ──────────────────────────────────────────────────────────────────

  useEffect(() => {
    async function initIdentity() {
      try {
        const { data: { session } } = await supabase.auth.getSession()
        if (!session?.user) return
        userIdRef.current = session.user.id
        const { data: profileRow } = await supabase
          .from('profiles').select('company_id').eq('id', session.user.id).single()
        if (!profileRow?.company_id) return
        companyIdRef.current = profileRow.company_id
        const cached = await readCachedProfile(profileRow.company_id)
        if (!cached && navigator.onLine) await fetchAndCacheProfile(profileRow.company_id)
      } catch (err) {
        console.warn('[Invoice] Identity init failed:', err)
      }
    }
    initIdentity()
  }, [])

  // ── Outside-click closes dropdown ─────────────────────────────────────────

  useEffect(() => {
    const fn = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setActiveSearchId(null); setSearchResults([]); setDropdownPos(null)
      }
    }
    document.addEventListener('mousedown', fn)
    return () => document.removeEventListener('mousedown', fn)
  }, [])

  // ── Fixed dropdown position ───────────────────────────────────────────────

  useEffect(() => {
    if (!activeSearchId || searchResults.length === 0) { setDropdownPos(null); return }
    const input = inputRefs.current.get(activeSearchId)
    if (!input) return
    const compute = () => {
      const r = input.getBoundingClientRect()
      setDropdownPos({ top: r.bottom + 2, left: r.left, width: r.width })
    }
    compute()
    window.addEventListener('scroll', compute, true)
    window.addEventListener('resize', compute)
    return () => {
      window.removeEventListener('scroll', compute, true)
      window.removeEventListener('resize', compute)
    }
  }, [activeSearchId, searchResults])

  // ── PDF Generation ────────────────────────────────────────────────────────

  const generateReceipt = useCallback(async (sale: SaleRecord) => {
    try {
      const { jsPDF, autoTable } = await getPDFLibs()
      const doc     = new jsPDF()
      const company = sale.company_id ? await readCachedProfile(sale.company_id) : null
      const pageW   = doc.internal.pageSize.getWidth()
      let y         = 14

      if (company?.logo_base64) {
        try {
          const fmt = company.logo_base64.startsWith('data:image/png') ? 'PNG' : 'JPEG'
          doc.addImage(company.logo_base64, fmt, 14, y, 28, 28)
        } catch { }
      }

      doc.setFont('helvetica', 'bold').setFontSize(16).setTextColor(30, 30, 30)
      doc.text(company?.name ?? 'Invoice', pageW - 14, y + 6, { align: 'right' })
      doc.setFont('helvetica', 'normal').setFontSize(8).setTextColor(110)
      let infoY = y + 13
      const lines = [
        company?.tagline, company?.address, company?.city,
        company?.phone   && `Tel: ${company.phone}`,
        company?.email,
        company?.website,
        company?.tax_number && `NTN: ${company.tax_number}`,
      ].filter(Boolean) as string[]
      lines.forEach(l => { doc.text(l, pageW - 14, infoY, { align: 'right' }); infoY += 4.5 })

      y = Math.max(y + 34, infoY + 4)
      doc.setDrawColor(220).line(14, y, pageW - 14, y)
      y += 7

      doc.setFont('helvetica', 'bold').setFontSize(20).setTextColor(79, 70, 229)
      doc.text('INVOICE', 14, y)
      doc.setFont('helvetica', 'normal').setFontSize(8.5).setTextColor(120)
      doc.text(`No: ${sale.invoice_number ?? sale.id.split('-')[0].toUpperCase()}`, pageW - 14, y - 4, { align: 'right' })
      doc.text(`Date: ${sale.invoice_date ?? new Date(sale.created_at).toLocaleDateString()}`, pageW - 14, y + 2, { align: 'right' })
      if (sale.due_date) doc.text(`Due: ${sale.due_date}`, pageW - 14, y + 8, { align: 'right' })
      y += 10

      if (sale.payment_method) {
        const statusColor = sale.payment_status === 'credit' ? [239, 68, 68] : [16, 185, 129]
        doc.setFillColor(...(statusColor as [number, number, number]))
        doc.roundedRect(14, y, 50, 7, 1.5, 1.5, 'F')
        doc.setTextColor(255, 255, 255).setFontSize(7.5).setFont('helvetica', 'bold')
        const badge = `${sale.payment_method}${sale.payment_status === 'credit' ? ' — CREDIT' : ' — PAID'}`
        doc.text(badge, 39, y + 5, { align: 'center' })
        if (sale.bank_name)     doc.setTextColor(100).setFont('helvetica', 'normal').setFontSize(8).text(`Bank: ${sale.bank_name}`, 70, y + 5)
        if (sale.cheque_number) doc.setTextColor(100).setFont('helvetica', 'normal').setFontSize(8).text(`Cheque: ${sale.cheque_number}`, 70, y + 5)
        y += 12
      }

      doc.setFont('helvetica', 'bold').setFontSize(9).setTextColor(100)
      doc.text('BILL TO', 14, y); y += 5
      doc.setFont('helvetica', 'normal').setTextColor(50)
      doc.text(sale.customer_name, 14, y); y += 4.5
      if (sale.customer_email)   { doc.text(sale.customer_email,   14, y); y += 4.5 }
      if (sale.customer_phone)   { doc.text(sale.customer_phone,   14, y); y += 4.5 }
      if (sale.customer_address) { doc.text(sale.customer_address, 14, y); y += 4.5 }
      y += 4

      const saleTaxRate   = sale.tax_rate ?? DEFAULT_TAX_RATE
      const afterDiscount = Math.max(0, sale.subtotal - (sale.discount ?? 0))
      const saleTax       = afterDiscount * saleTaxRate

      autoTable(doc, {
        startY: y,
        head:   [['Description', 'Qty', 'Unit Price', 'Total']],
        body:   sale.items.map(i => [
          i.description, i.quantity,
          `Rs. ${i.price.toFixed(2)}`,
          `Rs. ${(i.quantity * i.price).toFixed(2)}`,
        ]),
        foot: [
          ['', '', 'Subtotal',                               `Rs. ${sale.subtotal.toFixed(2)}`],
          ['', '', 'Discount',                               `Rs. ${(sale.discount ?? 0).toFixed(2)}`],
          ['', '', `Tax (${(saleTaxRate * 100).toFixed(0)}%)`, `Rs. ${saleTax.toFixed(2)}`],
          ['', '', 'Total',                                  `Rs. ${sale.total.toFixed(2)}`],
        ],
        theme:      'striped',
        headStyles: { fillColor: [79, 70, 229], fontSize: 9 },
        footStyles: { fillColor: [245, 245, 255], textColor: [30, 30, 30], fontStyle: 'bold' },
        bodyStyles: { fontSize: 9 },
      })

      const finalY = (doc as any).lastAutoTable.finalY + 8
      if (sale.notes) {
        doc.setFont('helvetica', 'bold').setFontSize(8).setTextColor(100)
        doc.text('Notes:', 14, finalY)
        doc.setFont('helvetica', 'normal').setTextColor(130)
        doc.text(sale.notes, 14, finalY + 5)
      }
      doc.setFontSize(7.5).setTextColor(170)
      doc.text('Thank you for your business.', 14, finalY + (sale.notes ? 14 : 0))
      if (company?.name) {
        doc.text(`© ${new Date().getFullYear()} ${company.name}`, pageW - 14, finalY + (sale.notes ? 14 : 0), { align: 'right' })
      }
      window.open(doc.output('bloburl'), '_blank')
    } catch (err) {
      console.error('[Invoice] PDF generation failed', err)
    }
  }, [])

  // ── History fetch ─────────────────────────────────────────────────────────

  const fetchHistory = useCallback(async () => {
    const pending: SaleRecord[] = ((await get('offline_sales')) || []).map(
      (s: any) => ({ ...s, is_pending: true })
    )
    if (!navigator.onLine) { setHistorySales(pending); return }
    const { data } = await supabase
      .from('sales').select('*').order('created_at', { ascending: false }).limit(20)
    if (data) {
      const pendingIds = new Set(pending.map(s => s.id))
      setHistorySales([...pending, ...data.filter(s => !pendingIds.has(s.id))])
    }
  }, [])

  // ── Sync offline queue ────────────────────────────────────────────────────

  const syncOfflineSales = useCallback(async () => {
    if (!navigator.onLine || syncLock.current) return
    syncLock.current = true; setSyncing(true)

    try {
      const queue: SaleRecord[] = (await get('offline_sales')) || []
      if (queue.length === 0) return
      const batch = queue.slice(0, BATCH_SIZE)
      setSyncProgress(`Syncing ${Math.min(BATCH_SIZE, queue.length)} of ${queue.length}...`)
      const updatedQueue = [...queue]
      const syncedProductIds = new Set<number>()

      for (const sale of batch) {
        const dbRecord = toDbRecord(sale)
        if (!dbRecord.company_id && companyIdRef.current) dbRecord.company_id = companyIdRef.current
        if (!dbRecord.created_by  && userIdRef.current)   dbRecord.created_by  = userIdRef.current

        const { error: saleError } = await supabase.from('sales').insert([dbRecord])
        if (!saleError || saleError.code === '23505') {
          const rpcResults = await Promise.all(
            sale.items.filter(i => i.productId).map(async item => {
              const { error } = await supabase.rpc('decrement_stock', {
                row_id: item.productId, quantity_to_sub: item.quantity, p_sale_id: sale.id,
              })
              if (error) { console.error('[Sync] decrement_stock failed:', error); return false }
              syncedProductIds.add(item.productId!)
              return true
            })
          )
          if (rpcResults.every(Boolean)) {
            const idx = updatedQueue.findIndex(s => s.id === sale.id)
            if (idx > -1) updatedQueue.splice(idx, 1)
            await set('offline_sales', updatedQueue)
          } else break
        } else {
          console.error('[Sync] sale insert failed:', saleError)
          break
        }
      }

      if (syncedProductIds.size > 0) {
        const { data: fresh } = await supabase.from('products').select('*').in('id', Array.from(syncedProductIds))
        if (fresh?.length) {
          const local: any[] = (await get('local_inventory')) || []
          await set('local_inventory', local.map(p => {
            const u = fresh.find((fp: any) => Number(fp.id) === Number(p.id))
            return u ? { ...u, is_synced: true } : p
          }))
          const ch = new BroadcastChannel('inventory_updates')
          ch.postMessage({ type: 'INVENTORY_CHANGED' }); ch.close()
        }
      }

      const remaining: SaleRecord[] = (await get('offline_sales')) || []
      setQueueSize(remaining.length)
      if (remaining.length > 0 && navigator.onLine) setTimeout(syncOfflineSales, 2000)
    } catch (err) {
      console.error('[Sync] Failed:', err)
    } finally {
      setSyncing(false); setSyncProgress(''); syncLock.current = false; fetchHistory()
    }
  }, [fetchHistory])

  // ── Network listeners ─────────────────────────────────────────────────────

  useEffect(() => {
    const handleOnline = () => {
      setIsOnline(true); syncOfflineSales()
      if (companyIdRef.current) fetchAndCacheProfile(companyIdRef.current).catch(() => {})
    }
    const handleOffline = () => setIsOnline(false)
    window.addEventListener('online', handleOnline)
    window.addEventListener('offline', handleOffline)
    if (navigator.onLine) syncOfflineSales()
    return () => {
      window.removeEventListener('online', handleOnline)
      window.removeEventListener('offline', handleOffline)
    }
  }, [syncOfflineSales])

  // ── Item handlers ─────────────────────────────────────────────────────────

  const handleDescriptionChange = useCallback((itemId: string, value: string) => {
    // If user clears description, also reset product lock
    setItems(prev => prev.map(i =>
      i.id === itemId
        ? { ...i, description: value, productId: undefined, maxStock: undefined, price: 0 }
        : i
    ))
    setActiveSearchId(itemId)
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current)
    if (!value.trim()) { setSearchResults([]); setDropdownPos(null); return }
    searchTimerRef.current = setTimeout(async () => {
      const inv: any[] = (await get('local_inventory')) || []
      const lower = value.toLowerCase()
      setSearchResults(
        inv.filter(p =>
          p.name.toLowerCase().includes(lower) || (p.sku ?? '').toLowerCase().includes(lower)
        ).slice(0, 6)
      )
    }, SEARCH_DEBOUNCE_MS)
  }, [])

  const handleQuantityChange = useCallback((itemId: string, raw: string) => {
    setItems(prev => prev.map(i => i.id === itemId ? { ...i, quantity: Math.max(0, parseInt(raw, 10) || 0) } : i))
  }, [])

  // Price is NOT manually editable — only set via product selection
  const selectProduct = useCallback((p: any, itemId: string) => {
    setItems(prev => prev.map(i =>
      i.id === itemId
        ? { ...i, description: `${p.name} (${p.sku})`, price: p.price, maxStock: p.stock_quantity, productId: Number(p.id) }
        : i
    ))
    setSearchResults([]); setActiveSearchId(null); setDropdownPos(null)
  }, [])

  const addLineItem = useCallback(() => {
    setItems(prev => [...prev, { id: crypto.randomUUID(), description: '', quantity: 1, price: 0 }])
  }, [])

  const removeLineItem = useCallback((itemId: string) => {
    setItems(prev => prev.filter(i => i.id !== itemId))
  }, [])

  const clearForm = useCallback(() => {
    setInvoiceNumber(generateInvoiceNumber()); setInvoiceDate(today()); setDueDate('')
    setCustomerName(''); setCustomerEmail(''); setCustomerPhone(''); setCustomerAddress('')
    setItems([{ id: crypto.randomUUID(), description: '', quantity: 1, price: 0 }])
    setPaymentMethod('Cash'); setPaymentStatus('paid'); setBankName(''); setChequeNumber('')
    setDiscount(0); setTaxRate(DEFAULT_TAX_RATE); setNotes('')
    setEditingId(null)
  }, [])

  const clearOfflineQueue = useCallback(async () => {
    if (confirm('Remove all pending unsynced sales? This cannot be undone.')) {
      await del('offline_sales'); setQueueSize(0); fetchHistory()
    }
  }, [fetchHistory])

  // ── Load sale into form for editing ──────────────────────────────────────

  const handleEditSale = useCallback((sale: SaleRecord) => {
    setInvoiceNumber(sale.invoice_number ?? generateInvoiceNumber())
    setInvoiceDate(sale.invoice_date ?? today())
    setDueDate(sale.due_date ?? '')
    setCustomerName(sale.customer_name)
    setCustomerEmail(sale.customer_email ?? '')
    setCustomerPhone(sale.customer_phone ?? '')
    setCustomerAddress(sale.customer_address ?? '')
    setItems(sale.items.map(i => ({ ...i, id: i.id || crypto.randomUUID() })))
    setPaymentMethod(sale.payment_method ?? 'Cash')
    setPaymentStatus(sale.payment_status ?? 'paid')
    setBankName(sale.bank_name ?? '')
    setChequeNumber(sale.cheque_number ?? '')
    setDiscount(sale.discount ?? 0)
    setTaxRate(sale.tax_rate ?? DEFAULT_TAX_RATE)
    setNotes(sale.notes ?? '')
    setEditingId(sale.id)
    setShowHistory(false)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }, [])

  // ── Save / Complete ───────────────────────────────────────────────────────

  const handleCompleteSale = useCallback(async (andPrint = false) => {
    if (isFormInvalid || isSaving) return
    setIsSaving(true)

    try {
      const saleData: SaleRecord = {
        id:               editingId ?? crypto.randomUUID(),
        customer_name:    customerName.trim() || 'Walk-in',
        customer_email:   customerEmail   || undefined,
        customer_phone:   customerPhone   || undefined,
        customer_address: customerAddress || undefined,
        invoice_number:   invoiceNumber,
        invoice_date:     invoiceDate,
        due_date:         dueDate         || undefined,
        notes:            notes           || undefined,
        payment_method:   paymentMethod,
        payment_status:   paymentStatus,
        bank_name:        paymentMethod === 'Bank Transfer' ? bankName      || undefined : undefined,
        cheque_number:    paymentMethod === 'Cheque'        ? chequeNumber  || undefined : undefined,
        items,
        subtotal,
        discount,
        total,
        tax_rate: taxRate,
        created_at:  new Date().toISOString(),
        company_id:  companyIdRef.current ?? undefined,
        created_by:  userIdRef.current    ?? undefined,
      }

      if (editingId) {
        // ── EDIT mode: update DB directly ────────────────────────────────
        if (navigator.onLine) {
          const dbRecord = toDbRecord(saleData)
          const { error } = await supabase
            .from('sales')
            .update(dbRecord)
            .eq('id', editingId)
          if (error) {
            console.error('[Invoice] DB update failed:', error)
          } else {
            // Broadcast inventory change in case quantities differ
            const ch = new BroadcastChannel('inventory_updates')
            ch.postMessage({ type: 'INVENTORY_CHANGED' }); ch.close()
          }
        } else {
          // Offline: patch the offline queue entry
          const queue: SaleRecord[] = (await get('offline_sales')) || []
          const idx = queue.findIndex(s => s.id === editingId)
          if (idx > -1) {
            queue[idx] = saleData
            await set('offline_sales', queue)
          }
        }

        // Also update history view
        setHistorySales(prev => prev.map(s => s.id === editingId ? saleData : s))
        setEditingId(null)

      } else {
        // ── NEW sale ────────────────────────────────────────────────────
        // 1. Local inventory update
        const localInv: any[] = (await get('local_inventory')) || []
        await set('local_inventory', localInv.map(p => {
          const sold = items.find(i => i.productId === Number(p.id))
          return sold ? { ...p, stock_quantity: Math.max(0, p.stock_quantity - sold.quantity), is_synced: false } : p
        }))

        // 2. Broadcast
        const ch = new BroadcastChannel('inventory_updates')
        ch.postMessage({ type: 'SALE_COMPLETED' }); ch.close()

        // 3. Queue for sync
        const existing: SaleRecord[] = (await get('offline_sales')) || []
        const newQueue = [...existing, saleData]
        await set('offline_sales', newQueue); setQueueSize(newQueue.length)
      }

      // 4. Print if requested
      if (andPrint) generateReceipt(saleData)

      // 5. Reset
      clearForm()

      // 6. Sync online
      if (navigator.onLine && !editingId) syncOfflineSales()

    } catch (err) {
      console.error('[Invoice] Save failed:', err)
    } finally {
      setIsSaving(false)
    }
  }, [
    isFormInvalid, isSaving, editingId,
    customerName, customerEmail, customerPhone, customerAddress,
    invoiceNumber, invoiceDate, dueDate, notes, paymentMethod, paymentStatus,
    bankName, chequeNumber, items, subtotal, discount, total, taxRate,
    generateReceipt, syncOfflineSales, clearForm,
  ])

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="bg-gray-50 min-h-screen font-sans text-gray-900">

      {/* ── Queue Warning ── */}
      {queueSize >= MAX_QUEUE_SIZE && (
        <div className="max-w-5xl mx-auto px-4 pt-4">
          <div className="flex items-center gap-3 bg-amber-50 border border-amber-200 rounded-2xl px-5 py-3">
            <AlertTriangle size={16} className="text-amber-600 shrink-0" />
            <p className="text-sm font-bold text-amber-800">{queueSize} sales pending sync</p>
          </div>
        </div>
      )}

      <div className="max-w-5xl mx-auto px-4 md:px-6 py-6 space-y-5">

        {/* ── Page Header ── */}
        <div className="flex flex-col sm:flex-row sm:items-start gap-3 sm:justify-between">
          <div>
            <h1 className="text-2xl font-black text-gray-900 leading-tight">
              {editingId ? 'Edit Invoice' : 'Create Invoice'}
            </h1>
            <p className="text-sm text-gray-400 mt-0.5">
              {editingId
                ? 'Editing an existing invoice — changes will be saved to the database'
                : 'Generate professional invoices for your customers'}
            </p>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            {/* Online badge */}
            <div className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-full text-[10px] font-bold border ${
              isOnline
                ? 'bg-emerald-50 text-emerald-600 border-emerald-100'
                : 'bg-red-50 text-red-600 border-red-100'
            }`}>
              {isOnline ? <Cloud size={11} /> : <WifiOff size={11} />}
              {isOnline ? 'ONLINE' : 'OFFLINE'}
            </div>

            {/* History */}
            <button
              onClick={() => { fetchHistory(); setShowHistory(true) }}
              className="flex items-center gap-1.5 px-3 py-2 border border-gray-200 bg-white rounded-lg text-sm font-semibold text-gray-600 hover:bg-gray-50 transition-colors shadow-sm"
            >
              <History size={14} />
              <span className="hidden sm:inline">History</span>
            </button>

            {/* Clear */}
            <button
              onClick={clearForm}
              className="flex items-center gap-1.5 px-3 py-2 border border-gray-200 bg-white rounded-lg text-sm font-semibold text-gray-600 hover:bg-gray-50 transition-colors shadow-sm"
            >
              <X size={14} />
              <span className="hidden sm:inline">Clear</span>
            </button>

            {/* Save */}
            <button
              onClick={() => handleCompleteSale(false)}
              disabled={isSaving || isFormInvalid}
              className="flex items-center gap-1.5 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:bg-gray-200 disabled:cursor-not-allowed text-white rounded-lg text-sm font-bold shadow-md shadow-indigo-100 transition-colors"
            >
              {isSaving ? <Loader2 className="animate-spin" size={14} /> : <Save size={14} />}
              {editingId ? 'Update' : 'Save'}
            </button>

            {/* Print */}
            <button
              onClick={() => handleCompleteSale(true)}
              disabled={isSaving || isFormInvalid}
              className="flex items-center gap-1.5 px-4 py-2 bg-emerald-600 hover:bg-emerald-700 disabled:bg-gray-200 disabled:cursor-not-allowed text-white rounded-lg text-sm font-bold shadow-md shadow-emerald-100 transition-colors"
            >
              {isSaving ? <Loader2 className="animate-spin" size={14} /> : <Printer size={14} />}
              Print
            </button>
          </div>
        </div>

        {/* Edit mode banner */}
        {editingId && (
          <div className="flex items-center gap-3 bg-indigo-50 border border-indigo-200 rounded-xl px-5 py-3">
            <Edit2 size={15} className="text-indigo-600 shrink-0" />
            <p className="text-sm font-bold text-indigo-700">
              Editing invoice — Click <span className="font-black">Update</span> to save changes to the database.
            </p>
            <button onClick={clearForm} className="ml-auto text-xs text-indigo-400 hover:text-indigo-600 font-semibold">
              Cancel
            </button>
          </div>
        )}

        {/* ══ Main Card ══ */}
        <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-visible">

          {/* ── Top: Invoice + Bill To ── */}
          <div className="grid grid-cols-1 md:grid-cols-2 border-b border-gray-100">

            {/* Left – Invoice meta */}
            <div className="p-6 md:p-8 border-b md:border-b-0 md:border-r border-gray-100">
              <p className="text-sm font-black text-indigo-600 uppercase tracking-widest mb-5">INVOICE</p>
              <div className="space-y-4">
                <div>
                  <label className={labelCls}>Invoice Number</label>
                  <input
                    value={invoiceNumber}
                    onChange={e => setInvoiceNumber(e.target.value)}
                    className={inputCls}
                  />
                </div>
                <div>
                  <label className={labelCls}>Invoice Date</label>
                  <input type="date" value={invoiceDate} onChange={e => setInvoiceDate(e.target.value)} className={inputCls} />
                </div>
                <div>
                  <label className={labelCls}>Due Date</label>
                  <input type="date" value={dueDate} onChange={e => setDueDate(e.target.value)} className={inputCls} />
                </div>
              </div>
            </div>

            {/* Right – Bill To */}
            <div className="p-6 md:p-8">
              <p className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-5">BILL TO</p>
              <div className="space-y-3">
                <div>
                  <label className={labelCls}>Customer Name <span className="text-red-400">*</span></label>
                  <input
                    placeholder="Enter customer name"
                    value={customerName}
                    maxLength={80}
                    onChange={e => setCustomerName(e.target.value)}
                    className={inputCls}
                  />
                </div>
                <div>
                  <label className={labelCls}>Email</label>
                  <div className="relative">
                    <Mail className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-300 pointer-events-none" size={14} />
                    <input
                      type="email" placeholder="customer@email.com"
                      value={customerEmail} onChange={e => setCustomerEmail(e.target.value)}
                      className={`${inputCls} pl-8`}
                    />
                  </div>
                </div>
                <div>
                  <label className={labelCls}>Phone</label>
                  <div className="relative">
                    <Phone className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-300 pointer-events-none" size={14} />
                    <input
                      type="tel" placeholder="+92 300 0000000"
                      value={customerPhone} onChange={e => setCustomerPhone(e.target.value)}
                      className={`${inputCls} pl-8`}
                    />
                  </div>
                </div>
                <div>
                  <label className={labelCls}>Address</label>
                  <div className="relative">
                    <MapPin className="absolute left-3 top-3 text-gray-300 pointer-events-none" size={14} />
                    <textarea
                      placeholder="Customer address"
                      value={customerAddress} onChange={e => setCustomerAddress(e.target.value)}
                      rows={2}
                      className={`${inputCls} pl-8 resize-none`}
                    />
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* ── Items Section ── */}
          <div className="px-4 md:px-8 pt-6 pb-2" ref={dropdownRef}>
            <div className="flex items-center justify-between mb-4">
              <div>
                <p className="text-sm font-black text-gray-800">Items</p>
                <p className="text-[10px] text-gray-400 mt-0.5 flex items-center gap-1">
                  <Lock size={9} /> Search a product to auto-fill price
                </p>
              </div>
              <button
                onClick={addLineItem}
                className="flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-sm font-bold transition-colors"
              >
                <Plus size={14} /> Add Item
              </button>
            </div>

            {/* MOBILE: card per item */}
            <div className="md:hidden space-y-3">
              {items.map((item, idx) => (
                <div key={item.id} className="border border-gray-200 rounded-xl p-4 space-y-3 bg-gray-50/40">
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] font-black uppercase tracking-widest text-gray-400">Item {idx + 1}</span>
                    <button onClick={() => removeLineItem(item.id)} className="p-1.5 text-gray-300 hover:text-red-400 hover:bg-red-50 rounded-lg transition-colors">
                      <Trash2 size={14} />
                    </button>
                  </div>
                  <div>
                    <label className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-1 block">
                      Description / SKU
                    </label>
                    <input
                      ref={el => { if (el) inputRefs.current.set(item.id, el); else inputRefs.current.delete(item.id) }}
                      value={item.description}
                      onChange={e => handleDescriptionChange(item.id, e.target.value)}
                      onFocus={() => setActiveSearchId(item.id)}
                      placeholder="Type product name or SKU…"
                      className={inputCls}
                    />
                    {item.maxStock !== undefined && item.quantity > item.maxStock && (
                      <p className="text-[10px] text-red-500 font-bold mt-1">Max available: {item.maxStock}</p>
                    )}
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-1 block">Qty</label>
                      <input
                        type="number" min={1} value={item.quantity || ''}
                        onChange={e => handleQuantityChange(item.id, e.target.value)}
                        className={`${inputCls} text-center ${item.maxStock !== undefined && item.quantity > item.maxStock ? 'border-red-400 focus:ring-red-400' : ''}`}
                      />
                    </div>
                    <div>
                      <label className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-1 block">
                        Price (Rs.)
                      </label>
                      {/* Price is read-only — auto-filled from product search */}
                      <div className="relative">
                        <input
                          type="number"
                          readOnly
                          value={item.price || ''}
                          placeholder="From product"
                          className={`${inputCls} text-center bg-gray-50 text-gray-500 cursor-not-allowed select-none pr-7`}
                          tabIndex={-1}
                        />
                        <Lock size={10} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-300 pointer-events-none" />
                      </div>
                    </div>
                  </div>
                  <div className="flex justify-between items-center pt-2 border-t border-gray-100">
                    <span className="text-xs text-gray-400 font-semibold">Line Total</span>
                    <span className="text-sm font-black text-gray-800">Rs. {(item.quantity * item.price).toFixed(2)}</span>
                  </div>
                </div>
              ))}
            </div>

            {/* DESKTOP: table */}
            <div className="hidden md:block overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-gray-100 text-[10px] font-bold uppercase tracking-wider text-gray-400">
                    <th className="pb-3 text-left pl-1">Description</th>
                    <th className="pb-3 text-center w-28">Quantity</th>
                    <th className="pb-3 text-center w-40">
                      <span className="flex items-center justify-center gap-1">
                        Price <Lock size={9} />
                      </span>
                    </th>
                    <th className="pb-3 text-right w-28">Total</th>
                    <th className="pb-3 w-8" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {items.map(item => (
                    <tr key={item.id} className="group">
                      <td className="py-2.5 pr-4">
                        <input
                          ref={el => { if (el) inputRefs.current.set(item.id, el); else inputRefs.current.delete(item.id) }}
                          value={item.description}
                          onChange={e => handleDescriptionChange(item.id, e.target.value)}
                          onFocus={() => setActiveSearchId(item.id)}
                          placeholder="Type product name or SKU…"
                          className={inputCls}
                        />
                        {item.maxStock !== undefined && item.quantity > item.maxStock && (
                          <p className="text-[10px] text-red-500 font-bold mt-1 ml-1">Max: {item.maxStock}</p>
                        )}
                      </td>
                      <td className="py-2.5 px-2">
                        <input
                          type="number" min={1} value={item.quantity || ''}
                          onChange={e => handleQuantityChange(item.id, e.target.value)}
                          className={`${inputCls} text-center ${item.maxStock !== undefined && item.quantity > item.maxStock ? 'border-red-400 focus:ring-red-400' : ''}`}
                        />
                      </td>
                      <td className="py-2.5 px-2">
                        {/* Read-only price — only auto-filled from product selection */}
                        <div className="relative">
                          <input
                            type="number"
                            readOnly
                            value={item.price || ''}
                            placeholder="Select product"
                            tabIndex={-1}
                            className={`${inputCls} text-center bg-gray-50 text-gray-500 cursor-not-allowed select-none pr-7`}
                          />
                          <Lock size={10} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-300 pointer-events-none" />
                        </div>
                        {item.productId && (
                          <p className="text-[9px] text-emerald-500 font-semibold text-center mt-0.5">
                            ✓ From inventory
                          </p>
                        )}
                      </td>
                      <td className="py-2.5 pl-2 text-right text-sm font-bold text-gray-700 whitespace-nowrap">
                        Rs. {(item.quantity * item.price).toFixed(2)}
                      </td>
                      <td className="py-2.5 pl-1">
                        <button onClick={() => removeLineItem(item.id)} className="text-gray-300 hover:text-red-400 transition-colors p-1 rounded">
                          <Trash2 size={14} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* ── Bottom: Payment + Notes | Totals ── */}
          <div className="grid grid-cols-1 md:grid-cols-2 border-t border-gray-100 mt-2">

            {/* Left: Payment Method + Notes */}
            <div className="p-6 md:p-8 border-b md:border-b-0 md:border-r border-gray-100 space-y-5">

              {/* Payment Method */}
              <div>
                <label className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-3 block">
                  Payment Method <span className="text-red-400">*</span>
                </label>
                <div className="grid grid-cols-2 gap-2.5">
                  {PAYMENT_METHODS.map(pm => (
                    <button
                      key={pm.value}
                      type="button"
                      onClick={() => handlePaymentMethodChange(pm.value)}
                      className={`flex items-center gap-2.5 px-4 py-3 rounded-xl border text-sm font-semibold transition-all text-left ${
                        paymentMethod === pm.value
                          ? 'border-indigo-500 bg-indigo-50 text-indigo-700 shadow-sm ring-1 ring-indigo-200'
                          : 'border-gray-200 bg-white text-gray-600 hover:border-gray-300 hover:bg-gray-50'
                      }`}
                    >
                      <span className={paymentMethod === pm.value ? 'text-indigo-500' : 'text-gray-400'}>
                        {pm.icon}
                      </span>
                      {pm.label}
                    </button>
                  ))}
                </div>

                {/* Credit notice */}
                {paymentMethod === 'Credit' && (
                  <div className="mt-3 flex items-center gap-2 px-3 py-2.5 bg-amber-50 border border-amber-200 rounded-lg">
                    <Clock size={14} className="text-amber-500 shrink-0" />
                    <div>
                      <p className="text-xs font-bold text-amber-700">Credit Sale — Payment Pending</p>
                      <p className="text-[10px] text-amber-500 mt-0.5">Customer will pay at a later date.</p>
                    </div>
                  </div>
                )}

                {/* Bank Transfer */}
                {paymentMethod === 'Bank Transfer' && (
                  <div className="mt-3 space-y-2">
                    <label className={labelCls}>Bank Name <span className="text-red-400">*</span></label>
                    <select
                      value={bankName}
                      onChange={e => setBankName(e.target.value)}
                      className={inputCls}
                    >
                      <option value="">Select bank…</option>
                      {COMMON_BANKS.map(b => <option key={b} value={b}>{b}</option>)}
                    </select>
                    {bankName === 'Other' && (
                      <input
                        placeholder="Enter bank name"
                        onChange={e => setBankName(e.target.value)}
                        className={inputCls}
                      />
                    )}
                  </div>
                )}

                {/* Cheque */}
                {paymentMethod === 'Cheque' && (
                  <div className="mt-3">
                    <label className={labelCls}>
                      <span className="flex items-center gap-1.5"><Hash size={11} /> Cheque Number</span>
                    </label>
                    <input
                      placeholder="e.g. CHQ-00123456"
                      value={chequeNumber}
                      onChange={e => setChequeNumber(e.target.value)}
                      className={inputCls}
                    />
                  </div>
                )}
              </div>

              {/* Notes */}
              <div>
                <label className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-2 block">Notes</label>
                <textarea
                  placeholder="Add any additional notes or payment terms..."
                  value={notes}
                  onChange={e => setNotes(e.target.value)}
                  rows={4}
                  className={`${inputCls} resize-none`}
                />
              </div>
            </div>

            {/* Right: Totals */}
            <div className="p-6 md:p-8 flex flex-col justify-center">
              <div className="space-y-3">
                <div className="flex justify-between items-center text-sm text-gray-600">
                  <span className="font-semibold">Subtotal:</span>
                  <span className="font-bold">Rs. {subtotal.toFixed(2)}</span>
                </div>
                <div className="flex justify-between items-center text-sm">
                  <span className="font-semibold text-gray-600">Discount:</span>
                  <div className="flex items-center gap-2">
                    <span className="text-gray-400 text-xs">Rs.</span>
                    <input
                      type="number" min={0}
                      value={discount || ''}
                      onChange={e => setDiscount(Math.max(0, Number(e.target.value) || 0))}
                      className="w-24 text-right border border-gray-200 rounded-lg px-2 py-1.5 text-sm outline-none focus:ring-2 focus:ring-indigo-500"
                    />
                  </div>
                </div>
                <div className="flex justify-between items-center text-sm pb-3 border-b border-gray-100">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-gray-600">Tax:</span>
                    <input
                      type="number" min={0} max={100} step="0.1"
                      value={(taxRate * 100).toFixed(1)}
                      onChange={e => setTaxRate(Math.max(0, Math.min(100, parseFloat(e.target.value) || 0)) / 100)}
                      className="w-16 text-center border border-gray-200 rounded-lg px-2 py-1.5 text-sm outline-none focus:ring-2 focus:ring-indigo-500"
                    />
                    <span className="text-gray-400 text-xs">%</span>
                  </div>
                  <span className="font-bold text-gray-700">Rs. {tax.toFixed(2)}</span>
                </div>
                <div className="flex justify-between items-center bg-indigo-50 border border-indigo-100 rounded-xl px-4 py-3.5 mt-1">
                  <span className="font-black text-gray-800 text-base">Total:</span>
                  <span className="text-2xl font-black text-indigo-600">Rs. {total.toFixed(2)}</span>
                </div>
                <div className="flex justify-end pt-1">
                  <span className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[11px] font-bold ${
                    paymentStatus === 'credit'
                      ? 'bg-amber-100 text-amber-700 border border-amber-200'
                      : 'bg-emerald-100 text-emerald-700 border border-emerald-200'
                  }`}>
                    {paymentStatus === 'credit' ? <Clock size={10} /> : <CheckCircle2 size={10} />}
                    {paymentStatus === 'credit' ? 'CREDIT — PENDING PAYMENT' : 'PAID'}
                  </span>
                </div>
              </div>
            </div>
          </div>

        </div>
      </div>

      {/* ── History Sidebar ── */}
      {showHistory && (
        <div className="fixed inset-0 z-50 flex justify-end">
          <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" onClick={() => setShowHistory(false)} />
          <div className="relative w-full max-w-sm bg-white h-full shadow-2xl p-6 flex flex-col">
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-lg font-black flex items-center gap-2">
                <FileText size={17} /> Sales History
              </h2>
              <button onClick={() => setShowHistory(false)} className="text-gray-400 hover:text-red-500 transition-colors">
                <X size={19} />
              </button>
            </div>
            <button
              onClick={clearOfflineQueue}
              className="mb-4 w-full py-2 bg-red-50 text-red-600 text-[10px] font-bold rounded-lg border border-red-100 flex items-center justify-center gap-2 hover:bg-red-100 transition-colors"
            >
              <Trash size={11} /> CLEAR STUCK SYNC QUEUE
            </button>
            <div className="flex-1 overflow-y-auto space-y-3 pr-1">
              {historySales.length === 0 && (
                <p className="text-center text-sm text-gray-400 font-bold mt-10">No sales yet.</p>
              )}
              {historySales.map(sale => (
                <div key={sale.id} className={`p-4 rounded-xl border ${sale.is_pending ? 'bg-amber-50 border-amber-200' : 'bg-white border-gray-100'}`}>
                  <div className="flex justify-between text-[10px] font-bold text-gray-400 uppercase mb-1.5">
                    <span>{new Date(sale.created_at).toLocaleDateString()}</span>
                    {sale.is_pending
                      ? <span className="text-amber-600 animate-pulse">PENDING SYNC</span>
                      : <CheckCircle2 size={13} className="text-emerald-500" />
                    }
                  </div>
                  {sale.invoice_number && (
                    <p className="text-[10px] text-indigo-400 font-mono mb-1">{sale.invoice_number}</p>
                  )}
                  <p className="text-xs text-gray-500 mb-1">{sale.customer_name}</p>
                  {sale.payment_method && (
                    <div className="flex items-center gap-2 mb-2">
                      <span className="text-[10px] font-bold text-gray-500">{sale.payment_method}</span>
                      <span className={`text-[9px] font-black px-1.5 py-0.5 rounded-full ${
                        sale.payment_status === 'credit'
                          ? 'bg-amber-100 text-amber-600'
                          : 'bg-emerald-100 text-emerald-600'
                      }`}>
                        {sale.payment_status === 'credit' ? 'CREDIT' : 'PAID'}
                      </span>
                      {sale.bank_name && (
                        <span className="text-[9px] text-gray-400">{sale.bank_name}</span>
                      )}
                    </div>
                  )}
                  <p className="text-sm font-bold truncate mb-3 text-gray-700">
                    {sale.items.map(i => i.description).join(', ')}
                  </p>
                  <div className="flex justify-between items-center">
                    <span className="font-black text-gray-900">Rs. {sale.total.toFixed(0)}</span>
                    <div className="flex items-center gap-1">
                      {/* Edit button — loads sale into form */}
                      <button
                        onClick={() => handleEditSale(sale)}
                        className="p-1.5 text-indigo-400 hover:bg-indigo-50 rounded-lg transition-colors"
                        title="Edit invoice"
                      >
                        <Edit2 size={14} />
                      </button>
                      {/* Print receipt */}
                      <button
                        onClick={() => generateReceipt(sale)}
                        className="p-1.5 text-emerald-500 hover:bg-emerald-50 rounded-lg transition-colors"
                        title="Print receipt"
                      >
                        <Printer size={14} />
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ── Search Dropdown ── */}
      {dropdownPos && activeSearchId && searchResults.length > 0 && (
        <div
          ref={dropdownRef}
          style={{ position: 'fixed', top: dropdownPos.top, left: dropdownPos.left, width: dropdownPos.width, zIndex: 9999 }}
          className="bg-white border border-gray-200 shadow-2xl rounded-xl overflow-hidden"
        >
          {searchResults.map(p => (
            <div
              key={p.id}
              onMouseDown={e => { e.preventDefault(); selectProduct(p, activeSearchId) }}
              className="px-4 py-3 hover:bg-indigo-50 cursor-pointer flex justify-between items-center border-b last:border-0 text-sm"
            >
              <div className="min-w-0">
                <p className="font-semibold text-gray-800 truncate">{p.name}</p>
                <p className="text-[10px] text-gray-400 font-mono mt-0.5">SKU: {p.sku}</p>
              </div>
              <div className="text-right shrink-0 ml-4">
                <p className="text-indigo-600 font-black text-sm">Rs. {p.price}</p>
                <p className="text-[10px] text-gray-400">{p.stock_quantity} in stock</p>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── Sync Toast ── */}
      {syncing && (
        <div className="fixed bottom-6 left-6 bg-gray-900 text-white px-5 py-3 rounded-2xl shadow-2xl flex items-center gap-3">
          <RefreshCcw className="animate-spin" size={15} />
          <span className="text-xs font-bold uppercase tracking-wider">
            {syncProgress || 'Syncing to Cloud…'}
          </span>
        </div>
      )}
    </div>
  )
}