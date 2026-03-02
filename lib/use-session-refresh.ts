'use client'

/**
 * useSessionRefresh
 *
 * Solves the #1 production auth failure: browser tabs throttle or suspend
 * background JS timers, so Supabase's built-in auto-refresh misses its window
 * when a POS terminal sits idle for hours.
 *
 * This hook handles two scenarios:
 *  1. Tab becomes visible again after being in background — forces a session check
 *  2. Supabase fires SIGNED_OUT event — redirects to login immediately
 *
 * Usage: call once at the top of any protected page component.
 *   useSessionRefresh()
 */

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase'

export function useSessionRefresh() {
  const router = useRouter()

  useEffect(() => {
    // ── 1. Auth state listener ────────────────────────────────────────────
    // Catches token refresh events and forced sign-outs from Supabase dashboard
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      async (event) => {
        if (event === 'SIGNED_OUT') {
          // Clear any sensitive local data before redirecting
          router.push('/login')
        }
      }
    )

    // ── 2. Visibility change handler ──────────────────────────────────────
    // When employee returns to a tab that was in background for hours,
    // the Supabase token may have expired. Force a check + refresh immediately.
    const handleVisibilityChange = async () => {
      if (document.visibilityState !== 'visible') return

      try {
        const { data: { session }, error } = await supabase.auth.getSession()

        if (error || !session) {
          // No valid session — attempt refresh before giving up
          const { error: refreshError } = await supabase.auth.refreshSession()
          if (refreshError) {
            console.warn('Session expired and could not be refreshed. Redirecting to login.')
            router.push('/login')
          }
        }
      } catch {
        // Network failure on session check — don't redirect, app may be offline
        // The sync logic handles offline gracefully
      }
    }

    document.addEventListener('visibilitychange', handleVisibilityChange)

    // ── 3. Initial check on mount ─────────────────────────────────────────
    // Handles the edge case of loading the page with an already-expired session
    handleVisibilityChange()

    return () => {
      subscription.unsubscribe()
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [router])
}