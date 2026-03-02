'use client'

import { useEffect, useState, useCallback, useRef, useMemo } from 'react'
import {
  Search, Plus, Edit, AlertCircle, Package,
  X, Trash2, Save, Loader2, Wifi, WifiOff,
  Cloud, CheckCircle2, AlertTriangle, Ban
} from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { get, set } from 'idb-keyval'
import { useSessionRefresh } from '../../../../lib/use-session-refresh'

// ─── Types ────────────────────────────────────────────────────────────────────

interface Product {
  id?: number          // INTEGER from Supabase products table
  name: string
  sku: string
  category: string
  price: number
  stock_quantity: number
  company_id?: string
  is_synced?: boolean
  updated_at?: string
}

interface SyncQueueItem {
  tempId: number
  type: 'INSERT' | 'UPDATE' | 'DELETE'
  id?: number
  payload?: Omit<Product, 'id' | 'is_synced'>
}

// ─── Constants ────────────────────────────────────────────────────────────────

const CATEGORIES       = ['Electronics', 'Stationery', 'Furniture', 'Snacks', 'Other'] as const
const SYNC_INTERVAL_MS = 20_000
const SEARCH_DEBOUNCE  = 200

// Stock thresholds — change here to apply globally
const STOCK_LOW      = 20   // < 20 = low
const STOCK_CRITICAL = 5    // <= 5 = critical
const STOCK_OUT      = 0    // <= 0 = out of stock

const EMPTY_FORM: Product = {
  name: '', sku: '', category: 'Electronics', price: 0, stock_quantity: 0,
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Deduplicates by SKU — keeps the synced (remote) version over an unsynced
 * local copy when both exist. Prevents duplicate rows when a product was
 * added locally and then fetched again from Supabase.
 */
function deduplicateProducts(list: Product[]): Product[] {
  const map = new Map<string, Product>()
  for (const p of list) {
    const existing = map.get(p.sku)
    if (!existing || (!existing.is_synced && p.is_synced)) {
      map.set(p.sku, p)
    }
  }
  return Array.from(map.values())
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function InventoryManagement() {
  // Issue 3: handles sessions expiring on idle POS terminals
  useSessionRefresh()
  const [products, setProducts]             = useState<Product[]>([])
  const [loading, setLoading]               = useState(true)
  const [isSaving, setIsSaving]             = useState(false)
  const [searchTerm, setSearchTerm]         = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [isModalOpen, setIsModalOpen]       = useState(false)
  const [isOnline, setIsOnline]             = useState(true)
  const [pendingSyncCount, setPendingSyncCount] = useState(0)
  const [editingId, setEditingId]           = useState<number | null>(null)
  const [formData, setFormData]             = useState<Product>(EMPTY_FORM)
  const [syncError, setSyncError]           = useState<string | null>(null)

  // ── Refs ─────────────────────────────────────────────────────────────────
  const userCompanyIdRef  = useRef<string | null>(null)
  const searchTimerRef    = useRef<ReturnType<typeof setTimeout> | null>(null)
  const syncIntervalRef   = useRef<ReturnType<typeof setInterval> | null>(null)
  const isSyncingRef      = useRef(false)

  // ── Memoised Derived Data ─────────────────────────────────────────────────

  const stockGroups = useMemo(() => ({
    low:      products.filter(p => p.stock_quantity > STOCK_CRITICAL && p.stock_quantity < STOCK_LOW),
    critical: products.filter(p => p.stock_quantity > STOCK_OUT && p.stock_quantity <= STOCK_CRITICAL),
    out:      products.filter(p => p.stock_quantity <= STOCK_OUT),
  }), [products])

  const filteredProducts = useMemo(() => {
    if (!debouncedSearch) return products
    const lower = debouncedSearch.toLowerCase()
    return products.filter(p =>
      p.name.toLowerCase().includes(lower) ||
      p.sku.toLowerCase().includes(lower)
    )
  }, [products, debouncedSearch])

  // ── Search Debounce ───────────────────────────────────────────────────────

  const handleSearchChange = useCallback((value: string) => {
    setSearchTerm(value)
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current)
    searchTimerRef.current = setTimeout(
      () => setDebouncedSearch(value),
      SEARCH_DEBOUNCE
    )
  }, [])

  // ── Pending Count ─────────────────────────────────────────────────────────

  const updatePendingCount = useCallback(async () => {
    const queue: SyncQueueItem[] = (await get('inventory_sync_queue')) || []
    setPendingSyncCount(queue.length)
  }, [])

  // ── Sync Queue Processor ──────────────────────────────────────────────────

  const processSyncQueue = useCallback(async () => {
    if (!navigator.onLine || isSyncingRef.current) return
    isSyncingRef.current = true
    setSyncError(null)

    try {
      const queue: SyncQueueItem[] = (await get('inventory_sync_queue')) || []
      if (queue.length === 0) return

      let currentQueue = [...queue]
      let localData: Product[] = (await get('local_inventory')) || []

      for (const item of queue) {
        try {
          let dbError: any = null
          let syncedId: number | undefined

          if (item.type === 'INSERT' || item.type === 'UPDATE') {
            // Strip frontend-only fields that don't exist in the DB schema
            const { is_synced: _s, updated_at: _u, ...cleanPayload } = (item.payload ?? {}) as any
            const upsertPayload = {
              ...cleanPayload,
              company_id: userCompanyIdRef.current,
              ...(item.type === 'UPDATE' && item.id ? { id: item.id } : {}),
            }
            const { data, error } = await supabase
              .from('products')
              .upsert(upsertPayload)
              .select('id')
              .single()
            dbError  = error
            syncedId = data?.id
          } else if (item.type === 'DELETE') {
            const { error } = await supabase
              .from('products')
              .delete()
              .eq('id', item.id)
            dbError = error
          }

          if (dbError) {
            // Surface the real error so it's visible in the UI and console
            console.error('[Sync] Supabase rejected item', item, '→', dbError)
            setSyncError(dbError.message ?? dbError.code ?? 'Sync failed — check console')
            break
          }

          // Success — remove from queue
          currentQueue = currentQueue.filter(q => q.tempId !== item.tempId)
          await set('inventory_sync_queue', currentQueue)

          if (item.type === 'DELETE') {
            localData = localData.filter(p => p.id !== item.id && p.sku !== item.payload?.sku)
          } else {
            localData = localData.map(p => {
              if (p.sku === item.payload?.sku) {
                return { ...p, id: syncedId ?? p.id, is_synced: true }
              }
              return p
            })
          }

        } catch (err: any) {
          console.error('[Sync] Network/unexpected error for item', item, '→', err)
          setSyncError(err?.message ?? 'Network error — could not reach server')
          break
        }
      }

      setProducts(localData)
      await set('local_inventory', localData)
    } catch (err: any) {
      console.error('[Sync] Fatal error in processSyncQueue:', err)
      setSyncError(err?.message ?? String(err))
    } finally {
      isSyncingRef.current = false
      updatePendingCount()
    }
  }, [updatePendingCount])

  // ── App Init ──────────────────────────────────────────────────────────────

  const initializeApp = useCallback(async () => {
    setLoading(true)

    // 1. Load from IndexedDB first — instant, works offline
    const rawLocal: Product[] = (await get('local_inventory')) || []
    const localData = deduplicateProducts(rawLocal)
    if (localData.length > 0) {
      setProducts(localData)
      await set('local_inventory', localData)
    }

    try {
      const { data, error } = await supabase.auth.getSession()
      if (error) throw error

      if (data.session?.user) {
        const { data: profile } = await supabase
          .from('profiles')
          .select('company_id')
          .eq('id', data.session.user.id)
          .single()

        if (profile?.company_id) {
          userCompanyIdRef.current = profile.company_id
        }
      }

      if (navigator.onLine && userCompanyIdRef.current) {
        const [pendingInvQueue, pendingSales] = await Promise.all([
          get('inventory_sync_queue'),
          get('offline_sales'),
        ])

        const hasUnsyncedProducts = localData.some(p => !p.is_synced)
        const hasPendingChanges =
          hasUnsyncedProducts ||
          (pendingInvQueue && (pendingInvQueue as any[]).length > 0) ||
          (pendingSales    && (pendingSales    as any[]).length > 0)

        if (!hasPendingChanges) {
          const { data: remoteProducts } = await supabase
            .from('products')
            .select('*')
            .eq('company_id', userCompanyIdRef.current)
            .order('name')

          if (remoteProducts) {
            // ✅ FIX 3: Merge Supabase data with local instead of wholesale replacing.
            // If the user edited a product and navigated away before the sync
            // completed, `hasPendingChanges` could briefly be false (queue flushed,
            // local marked synced) while Supabase hasn't committed yet. A merge
            // ensures any local unsynced edits are never silently discarded.
            const localBySku = new Map(localData.map(p => [p.sku, p]))

            const merged: Product[] = remoteProducts.map((rp: Product) => {
              const local = localBySku.get(rp.sku)
              // Keep local version if it has unsynced edits
              if (local && !local.is_synced) return local
              return { ...rp, is_synced: true }
            })

            // Preserve local-only products not yet written to Supabase
            const remoteSkus = new Set(remoteProducts.map((p: Product) => p.sku))
            const localOnly  = localData.filter(p => !remoteSkus.has(p.sku) && !p.is_synced)

            const final = deduplicateProducts([...merged, ...localOnly])
            setProducts(final)
            await set('local_inventory', final)
          }
        }
      }
    } catch (err) {
      console.error('Supabase connection failed — running offline:', err)
      setIsOnline(false)
    } finally {
      setLoading(false)
      updatePendingCount()
    }
  }, [updatePendingCount])

  // ── Effects ───────────────────────────────────────────────────────────────

  useEffect(() => {
    setIsOnline(navigator.onLine)

    const channel = new BroadcastChannel('inventory_updates')
    channel.onmessage = async (event) => {
      if (event.data.type === 'SALE_COMPLETED' || event.data.type === 'INVENTORY_CHANGED') {
        const localData: Product[] = (await get('local_inventory')) || []
        setProducts(localData)
        updatePendingCount()
      }
    }

    const handleOnline  = () => { setIsOnline(true);  processSyncQueue() }
    const handleOffline = () => { setIsOnline(false) }

    window.addEventListener('online',  handleOnline)
    window.addEventListener('offline', handleOffline)

    initializeApp()

    syncIntervalRef.current = setInterval(() => {
      if (navigator.onLine) processSyncQueue()
    }, SYNC_INTERVAL_MS)

    return () => {
      channel.close()
      window.removeEventListener('online',  handleOnline)
      window.removeEventListener('offline', handleOffline)
      if (syncIntervalRef.current) clearInterval(syncIntervalRef.current)
      if (searchTimerRef.current)  clearTimeout(searchTimerRef.current)
    }
  }, [initializeApp, processSyncQueue, updatePendingCount])

  // ── Handlers ─────────────────────────────────────────────────────────────

  const openAddModal = useCallback(() => {
    setEditingId(null)
    setFormData(EMPTY_FORM)
    setIsModalOpen(true)
  }, [])

  const openEditModal = useCallback((product: Product) => {
    setEditingId(product.id ?? null)
    setFormData(product)
    setIsModalOpen(true)
  }, [])

  const handleSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault()
    setIsSaving(true)

    const isNew = !editingId
    const productData: Product = {
      ...formData,
      id:          editingId ?? undefined,
      company_id:  userCompanyIdRef.current ?? undefined,
      is_synced:   false,
    }

    const currentLocal: Product[] = (await get('local_inventory')) || []
    const updatedProducts = deduplicateProducts(
      isNew
        ? [productData, ...currentLocal]
        : currentLocal.map(p =>
            (Number(p.id) === Number(editingId) || p.sku === formData.sku) ? productData : p
          )
    )

    setProducts(updatedProducts)
    await set('local_inventory', updatedProducts)

    const queue: SyncQueueItem[] = (await get('inventory_sync_queue')) || []
    // Strip frontend-only fields from the queued payload so they never reach Supabase
    const { is_synced: _s, updated_at: _u, id: _id, company_id: _c, ...dbPayload } = formData as any
    await set('inventory_sync_queue', [
      ...queue,
      {
        tempId:  Date.now(),
        type:    isNew ? 'INSERT' : 'UPDATE',
        id:      editingId ?? undefined,
        payload: dbPayload,
      },
    ])

    updatePendingCount()
    processSyncQueue()
    setIsModalOpen(false)
    setIsSaving(false)
  }, [editingId, formData, updatePendingCount, processSyncQueue])

  const handleDelete = useCallback(async (product: Product) => {
    if (!confirm(`Delete "${product.name}"? This cannot be undone.`)) return

    const currentLocal: Product[] = (await get('local_inventory')) || []
    const updatedList = currentLocal.filter(p => p.sku !== product.sku)
    setProducts(updatedList)
    await set('local_inventory', updatedList)

    if (product.id) {
      const queue: SyncQueueItem[] = (await get('inventory_sync_queue')) || []
      await set('inventory_sync_queue', [
        ...queue,
        { tempId: Date.now(), type: 'DELETE', id: product.id },
      ])
      updatePendingCount()
      processSyncQueue()
    }
  }, [updatePendingCount, processSyncQueue])

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="p-4 md:p-8 bg-gray-50 min-h-screen font-sans">

      {/* Header */}
      <div className="flex flex-col md:flex-row justify-between items-start gap-4 mb-8">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl md:text-3xl font-bold text-gray-900">Inventory</h1>
            <span className={`flex items-center gap-1 text-[10px] px-2 py-1 rounded-full font-bold uppercase ${
              isOnline
                ? 'bg-green-100 text-green-700'
                : 'bg-amber-100 text-amber-700'
            }`}>
              {isOnline ? <><Wifi size={12}/> Online</> : <><WifiOff size={12}/> Offline</>}
            </span>
          </div>
          <p className="text-sm text-gray-500 mt-0.5">Local-First · Sync Enabled</p>
        </div>

        <div className="w-full md:w-auto flex flex-col items-end gap-2">
          <button
            onClick={openAddModal}
            className="w-full md:w-auto flex justify-center items-center gap-2 bg-indigo-600 text-white px-6 py-3 rounded-xl font-bold hover:bg-indigo-700 shadow-lg transition-colors"
          >
            <Plus size={20} /> Add Item
          </button>
          {pendingSyncCount > 0 && (
            <div className="flex items-center gap-2 text-[10px] font-bold text-indigo-600">
              <Cloud size={14} className="animate-bounce" />
              {pendingSyncCount} change{pendingSyncCount > 1 ? 's' : ''} waiting to sync...
            </div>
          )}
          {syncError && (
            <div className="flex items-center gap-2 text-[10px] font-bold text-red-600 bg-red-50 px-3 py-2 rounded-xl max-w-xs text-right">
              <AlertCircle size={12} className="shrink-0" />
              <span>{syncError}</span>
              <button onClick={() => setSyncError(null)} className="ml-1 hover:text-red-800">
                <X size={10} />
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Stat Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <StatCard icon={<Package className="text-indigo-500" />}     label="Total"    value={products.length}            color="border-indigo-100" />
        <StatCard icon={<AlertCircle className="text-yellow-500" />} label="Low Stock" value={stockGroups.low.length}    color="border-yellow-100" items={stockGroups.low} />
        <StatCard icon={<AlertTriangle className="text-orange-500"/>} label="Critical"  value={stockGroups.critical.length} color="border-orange-100" items={stockGroups.critical} />
        <StatCard icon={<Ban className="text-red-500" />}            label="Run Out"   value={stockGroups.out.length}     color="border-red-100"    items={stockGroups.out} />
      </div>

      {/* Search */}
      <div className="relative mb-6">
        <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400" size={20} />
        <input
          type="text"
          placeholder="Search by name or SKU..."
          value={searchTerm}
          onChange={e => handleSearchChange(e.target.value)}
          className="w-full pl-12 pr-4 py-3 bg-white border border-gray-100 rounded-2xl shadow-sm outline-none focus:ring-2 focus:ring-indigo-500 text-sm"
        />
      </div>

      {/* Table */}
      <div className="bg-white rounded-3xl shadow-sm border border-gray-100 overflow-x-auto">
        {loading ? (
          <div className="flex items-center justify-center py-24 text-gray-400 gap-3">
            <Loader2 className="animate-spin" size={20} />
            <span className="text-sm font-bold">Loading inventory...</span>
          </div>
        ) : filteredProducts.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 text-gray-400 gap-2">
            <Package size={32} className="opacity-30" />
            <p className="text-sm font-bold">{debouncedSearch ? 'No products match your search.' : 'No products yet. Add your first item!'}</p>
          </div>
        ) : (
          <table className="w-full text-left min-w-[700px]">
            <thead className="bg-gray-50/50 border-b border-gray-100">
              <tr className="text-gray-400 text-[10px] md:text-xs uppercase font-bold tracking-wider">
                <th className="px-6 py-4">Product</th>
                <th className="px-6 py-4">SKU</th>
                <th className="px-6 py-4">Price</th>
                <th className="px-6 py-4">Stock</th>
                <th className="px-6 py-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {filteredProducts.map(product => (
                <tr key={product.id ?? `sku-${product.sku}`} className="hover:bg-gray-50/40 transition-colors">
                  <td className="px-6 py-4">
                    <div className="flex items-center gap-3">
                      <div>
                        <p className="font-bold text-gray-900 text-sm">{product.name}</p>
                        <span className="text-[9px] bg-indigo-50 text-indigo-600 px-1.5 py-0.5 rounded font-bold uppercase">
                          {product.category}
                        </span>
                      </div>
                      {product.is_synced
                        ? <CheckCircle2 size={14} className="text-green-500 shrink-0" />
                        : <span className="text-[8px] bg-amber-50 text-amber-600 px-1.5 py-0.5 rounded font-bold animate-pulse shrink-0">SAVING...</span>
                      }
                    </div>
                  </td>
                  <td className="px-6 py-4 text-gray-500 font-mono text-xs">{product.sku}</td>
                  <td className="px-6 py-4 font-bold text-sm">Rs. {product.price.toFixed(2)}</td>
                  <td className="px-6 py-4"><StockLevelBar quantity={product.stock_quantity} /></td>
                  <td className="px-6 py-4 text-right">
                    <div className="flex justify-end gap-1 md:gap-2">
                      <button
                        onClick={() => openEditModal(product)}
                        className="p-2 text-indigo-600 hover:bg-indigo-50 rounded-lg transition-colors"
                        title="Edit product"
                      >
                        <Edit size={16} />
                      </button>
                      <button
                        onClick={() => handleDelete(product)}
                        className="p-2 text-red-500 hover:bg-red-50 rounded-lg transition-colors"
                        title="Delete product"
                      >
                        <Trash2 size={16} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Add / Edit Modal */}
      {isModalOpen && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-3xl w-full max-w-lg shadow-2xl overflow-hidden">
            <div className="p-6 border-b flex justify-between items-center bg-gray-50/50">
              <h2 className="text-xl font-bold">{editingId ? 'Edit Product' : 'New Product'}</h2>
              <button onClick={() => setIsModalOpen(false)} className="hover:text-red-500 transition-colors">
                <X className="text-gray-400" />
              </button>
            </div>
            <form onSubmit={handleSubmit} className="p-6 space-y-4">
              <input
                required
                placeholder="Product Name"
                value={formData.name}
                maxLength={120}
                className="w-full p-3 border rounded-xl outline-none focus:ring-2 focus:ring-indigo-500"
                onChange={e => setFormData(f => ({ ...f, name: e.target.value }))}
              />
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <input
                  required
                  placeholder="SKU"
                  value={formData.sku}
                  maxLength={50}
                  className="p-3 border rounded-xl outline-none focus:ring-2 focus:ring-indigo-500"
                  onChange={e => setFormData(f => ({ ...f, sku: e.target.value }))}
                />
                <select
                  value={formData.category}
                  className="p-3 border rounded-xl bg-white outline-none focus:ring-2 focus:ring-indigo-500"
                  onChange={e => setFormData(f => ({ ...f, category: e.target.value }))}
                >
                  {CATEGORIES.map(c => <option key={c}>{c}</option>)}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-[10px] font-bold text-gray-400 uppercase ml-1 mb-1 block">Price (Rs.)</label>
                  <input
                    required
                    type="number"
                    min={0}
                    step="0.01"
                    placeholder="0.00"
                    value={formData.price || ''}
                    className="w-full p-3 border rounded-xl outline-none focus:ring-2 focus:ring-indigo-500"
                    onChange={e => setFormData(f => ({ ...f, price: Math.max(0, Number(e.target.value)) }))}
                  />
                </div>
                <div>
                  <label className="text-[10px] font-bold text-gray-400 uppercase ml-1 mb-1 block">Quantity</label>
                  <input
                    required
                    type="number"
                    min={0}
                    placeholder="0"
                    value={formData.stock_quantity || ''}
                    className="w-full p-3 border rounded-xl outline-none focus:ring-2 focus:ring-indigo-500"
                    onChange={e => setFormData(f => ({ ...f, stock_quantity: Math.max(0, parseInt(e.target.value, 10) || 0) }))}
                  />
                </div>
              </div>
              <button
                type="submit"
                disabled={isSaving}
                className="w-full bg-indigo-600 text-white py-4 rounded-2xl font-bold flex justify-center items-center gap-2 hover:bg-indigo-700 disabled:bg-gray-200 disabled:cursor-not-allowed transition-colors"
              >
                {isSaving ? <Loader2 className="animate-spin" size={18} /> : <Save size={18} />}
                Save Product
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Sub-Components ───────────────────────────────────────────────────────────

function StockLevelBar({ quantity }: { quantity: number }) {
  const percentage = Math.min((quantity / 200) * 100, 100)
  const color =
    quantity <= 0  ? 'bg-black' :
    quantity <= 5  ? 'bg-red-500' :
    quantity < 20  ? 'bg-yellow-500' :
    'bg-green-500'

  return (
    <div className="w-24 md:w-32">
      <div className="h-1.5 w-full bg-gray-100 rounded-full overflow-hidden">
        <div className={`h-full rounded-full transition-all ${color}`} style={{ width: `${percentage}%` }} />
      </div>
      <span className="text-[9px] text-gray-400 mt-1 block">{quantity} in stock</span>
    </div>
  )
}

interface StatCardProps {
  icon: React.ReactNode
  label: string
  value: number
  color: string
  items?: Product[]
}

function StatCard({ icon, label, value, color, items }: StatCardProps) {
  return (
    <div className={`group relative bg-white p-4 md:p-6 rounded-3xl border ${color} shadow-sm flex items-center gap-3 md:gap-4 transition-all hover:shadow-md cursor-default`}>
      <div className="p-2 md:p-3 bg-gray-50 rounded-2xl shrink-0">{icon}</div>
      <div>
        <p className="text-[10px] md:text-sm text-gray-500">{label}</p>
        <p className="text-xl md:text-2xl font-black">{value}</p>
      </div>

      {/* Hover Dropdown — only rendered if there are items */}
      {items && items.length > 0 && (
        <div className="absolute top-[calc(100%+8px)] left-0 opacity-0 invisible group-hover:opacity-100 group-hover:visible z-[100] transition-all duration-200 w-full min-w-[220px]">
          <div className="bg-white border border-gray-100 rounded-2xl shadow-2xl p-4">
            <h4 className="text-[10px] font-bold text-gray-400 uppercase mb-2 border-b pb-1">Affected Items</h4>
            <div className="max-h-40 overflow-y-auto space-y-2 pr-1">
              {items.map(item => (
                <div key={item.id ?? `sku-${item.sku}`} className="flex justify-between items-center text-[11px]">
                  <span className="font-semibold text-gray-700 truncate mr-2">{item.name}</span>
                  <span className="font-bold text-red-500 shrink-0">{item.stock_quantity}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}