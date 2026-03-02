'use client'

import { useEffect, useRef } from 'react'
import { get, set } from 'idb-keyval'
import { supabase } from '@/lib/supabase'

// ─── Constants ────────────────────────────────────────────────────────────────

const SYNC_INTERVAL_MS = 60_000  // 1 minute
const BATCH_SIZE       = 50      // max sales per sync cycle

// ─── Types ────────────────────────────────────────────────────────────────────

interface SaleRecord {
  id: string
  customer_name: string
  items: any[]
  subtotal: number
  discount: number
  total: number
  created_at: string
  company_id?: string
  created_by?: string
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export const useSyncManager = () => {
  // Refs so closures inside setInterval/addEventListener are never stale
  const companyIdRef = useRef<string | null>(null)
  const userIdRef    = useRef<string | null>(null)
  const isSyncingRef = useRef(false)

  useEffect(() => {
    // ── Resolve company + user identity once on mount ──────────────────────
    async function initIdentity() {
      try {
        const { data: { session } } = await supabase.auth.getSession()
        if (!session?.user) return

        userIdRef.current = session.user.id

        const { data: profile } = await supabase
          .from('profiles')
          .select('company_id')
          .eq('id', session.user.id)
          .single()

        if (profile?.company_id) companyIdRef.current = profile.company_id
      } catch {
        // Offline — identity will be resolved on next sync cycle
      }
    }

    // ── Bug 2 fix: filter by company_id — never pull other companies' data ─
    const downloadInventoryLocally = async () => {
      if (!navigator.onLine) return

      // Wait for identity if not yet resolved
      if (!companyIdRef.current) await initIdentity()
      if (!companyIdRef.current) return  // still offline or unauthenticated

      const { data, error } = await supabase
        .from('products')
        .select('*')
        .eq('company_id', companyIdRef.current)  // scoped to this company only

      if (data && !error) {
        // Preserve is_synced flags on products already in local cache
        const existing: any[] = (await get('local_inventory')) || []
        const existingMap = new Map(existing.map(p => [String(p.id), p]))

        const merged = data.map(p => ({
          ...p,
          is_synced: true,
          // Keep local stock if product is currently unsynced (sale in flight)
          stock_quantity: existingMap.get(String(p.id))?.is_synced === false
            ? existingMap.get(String(p.id))!.stock_quantity
            : p.stock_quantity,
        }))

        await set('local_inventory', merged)
        console.log('📦 Local inventory mirror updated from database.')
      }
    }

    const performSync = async () => {
      if (!navigator.onLine || isSyncingRef.current) return
      isSyncingRef.current = true

      try {
        const queue: SaleRecord[] = (await get('offline_sales')) || []

        if (queue.length === 0) {
          await downloadInventoryLocally()
          return
        }

        console.log(`🔄 Sync started: ${queue.length} sales pending.`)

        // Bug 7 fix: work from in-memory copy, not re-reading IDB on every iteration
        let workingQueue = [...queue]

        // Bug 6 fix: process in batches — don't hammer Supabase after long offline
        const batch = workingQueue.slice(0, BATCH_SIZE)

        for (const sale of batch) {
          try {
            // Bug 1 fix: use customer_name, not customer_email
            // Bug 4 fix: stamp company_id + created_by for RLS + audit trail
            const dbRecord = {
              id:            sale.id,
              customer_name: sale.customer_name ?? (sale as any).customer_email ?? 'Walk-in',
              items:         sale.items,
              subtotal:      sale.subtotal,
              discount:      sale.discount,
              total:         sale.total,
              created_at:    sale.created_at,
              company_id:    sale.company_id  ?? companyIdRef.current  ?? undefined,
              created_by:    sale.created_by  ?? userIdRef.current     ?? undefined,
            }

            const { error: dbError } = await supabase.from('sales').insert([dbRecord])

            // 23505 = duplicate key — sale already in DB, safe to clear from queue
            if (dbError && dbError.code !== '23505') throw dbError

            // Bug 3 fix: decrement stock via idempotent RPC
            // p_sale_id ensures retries never double-decrement (stock_ledger guard)
            const rpcResults = await Promise.all(
              sale.items
                .filter((item: any) => item.productId)
                .map(async (item: any) => {
                  const { error: rpcError } = await supabase.rpc('decrement_stock', {
                    row_id:          Number(item.productId),
                    quantity_to_sub: item.quantity,
                    p_sale_id:       sale.id,
                  })
                  if (rpcError) {
                    console.error(`decrement_stock failed for product ${item.productId}:`, rpcError)
                    return false
                  }
                  return true
                })
            )

            if (!rpcResults.every(Boolean)) {
              // At least one RPC failed — leave in queue and retry next cycle
              throw new Error('One or more stock decrements failed')
            }

            // Remove from working queue on full success
            workingQueue = workingQueue.filter(s => s.id !== sale.id)
            await set('offline_sales', workingQueue)

          } catch (err: any) {
            console.error(`❌ Sync error for ${sale.id}:`, err?.message ?? err ?? 'Unknown')
            // Stop this cycle on first failure — retry next interval
            break
          }
        }

        // If anything was synced, refresh local inventory with authoritative values
        const remaining: SaleRecord[] = (await get('offline_sales')) || []
        if (remaining.length < queue.length) {
          await downloadInventoryLocally()

          // Notify any open inventory tab
          const ch = new BroadcastChannel('inventory_updates')
          ch.postMessage({ type: 'INVENTORY_CHANGED' })
          ch.close()

          console.log(`✅ Sync complete: ${queue.length - remaining.length} sales uploaded.`)
        }

        // If there's still a backlog, schedule another run after a short pause
        if (remaining.length > 0 && navigator.onLine) {
          setTimeout(performSync, 2000)
        }

      } finally {
        isSyncingRef.current = false
      }
    }

    // ── Startup ───────────────────────────────────────────────────────────
    initIdentity().then(() => {
      downloadInventoryLocally()
      performSync()
    })

    const interval = setInterval(performSync, SYNC_INTERVAL_MS)

    // Bug 5 note: jsPDF is no longer imported here — receipt generation lives
    // in create-invoice.tsx with lazy imports, keeping this hook lean
    window.addEventListener('online', performSync)

    return () => {
      clearInterval(interval)
      window.removeEventListener('online', performSync)
    }
  }, [])
}