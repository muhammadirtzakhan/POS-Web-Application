'use client'

import { useState, useCallback, useRef } from 'react'
import { supabase } from '@/lib/supabase'
import { getUserRole } from '../../action'
import { Lock, User, AlertCircle, Loader2 } from 'lucide-react'
import { useRouter } from 'next/navigation'

// ─── Constants ────────────────────────────────────────────────────────────────
const MAX_ATTEMPTS   = 5          // lock out after this many failed tries
const LOCKOUT_MS     = 60_000     // 60-second lockout window
const TIMEOUT_MS     = 10_000     // 10-second server timeout

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Returns a safe, user-facing error string without leaking internals. */
function toUserMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)

  if (msg === 'TIMEOUT' || msg.includes('fetch') || msg.includes('ENOTFOUND'))
    return 'Server unreachable. Please check your internet connection.'

  if (msg.toLowerCase().includes('invalid login credentials'))
    return 'Invalid email or password.'

  return 'Access denied. Please try again later.'
}

/** Lightweight validation — no stripping, just shape checks. */
function validate(email: string, password: string): string | null {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()))
    return 'Please enter a valid email address.'

  if (password.length < 6)
    return 'Password must be at least 6 characters.'

  return null // valid
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function LoginPage() {
  const router = useRouter()

  const [email,    setEmail]    = useState('')
  const [password, setPassword] = useState('')
  const [loading,  setLoading]  = useState(false)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  // Brute-force rate limiting (client-side guard)
  const attempts     = useRef(0)
  const lockedUntil  = useRef<number>(0)

  const handleLogin = useCallback(async (e: React.FormEvent) => {
    e.preventDefault()
    setErrorMsg(null)

    // ── 1. Rate-limit check ──────────────────────────────────────────────────
    const now = Date.now()
    if (now < lockedUntil.current) {
      const secondsLeft = Math.ceil((lockedUntil.current - now) / 1000)
      setErrorMsg(`Too many attempts. Try again in ${secondsLeft}s.`)
      return
    }

    // ── 2. Validate inputs (no stripping — supabase handles parameterization) ─
    const validationError = validate(email, password)
    if (validationError) {
      setErrorMsg(validationError)
      return
    }

    setLoading(true)

    try {
      // ── 3. Auth with hard timeout ─────────────────────────────────────────
      const authPromise = supabase.auth.signInWithPassword({
        email:    email.trim(),
        password: password,
      })

      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('TIMEOUT')), TIMEOUT_MS)
      )

      const { data, error: authError } = await Promise.race([
        authPromise,
        timeoutPromise,
      ])

      if (authError) throw authError
      if (!data?.user) throw new Error('Authentication failed.')

      // ── 4. Fetch role ─────────────────────────────────────────────────────
      const { role, error: roleError } = await getUserRole(data.user.id)

      if (roleError) throw roleError
      if (!role)     throw new Error('No role assigned to this account.')

      // Reset attempts on success
      attempts.current    = 0
      lockedUntil.current = 0

      // ── 5. Route by role ──────────────────────────────────────────────────
      if (role === 'super_admin') {
        router.push('/admin')
      } else if (role === 'owner') {
        router.push('/dashboard/owner')
      } else {
        router.push('/dashboard/employee')
      }

    } catch (err: unknown) {
      console.error('Login error:', err)

      // Increment attempt counter; lock if threshold reached
      attempts.current += 1
      if (attempts.current >= MAX_ATTEMPTS) {
        lockedUntil.current = Date.now() + LOCKOUT_MS
        attempts.current    = 0
        setErrorMsg(`Too many failed attempts. Locked for ${LOCKOUT_MS / 1000}s.`)
      } else {
        setErrorMsg(toUserMessage(err))
      }

      setLoading(false)
    }
  }, [email, password, router])

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="flex min-h-screen items-center justify-center bg-[#f0f4ff] p-4 font-sans">
      <div className="w-full max-w-[400px] rounded-[32px] bg-white p-8 shadow-2xl shadow-indigo-100">

        {/* Header */}
        <div className="mb-8 flex flex-col items-center">
          <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-[#5d44ff] shadow-lg shadow-indigo-200">
            <Lock className="h-8 w-8 text-white" />
          </div>
          <h1 className="text-2xl font-bold text-gray-900 tracking-tight">Billing System</h1>
          <p className="text-sm font-medium text-gray-400 mt-1">Sign in to your account</p>
        </div>

        {/* Error Banner */}
        {errorMsg && (
          <div className="mb-6 flex items-center gap-2 rounded-xl bg-red-50 p-4 text-xs font-bold text-red-600 animate-in fade-in slide-in-from-top-2">
            <AlertCircle size={16} />
            <span className="flex-1">{errorMsg}</span>
          </div>
        )}

        {/* Form */}
        <form onSubmit={handleLogin} className="space-y-5" noValidate>

          {/* Email */}
          <div className="space-y-1.5">
            <label className="ml-1 text-[10px] font-black uppercase tracking-widest text-gray-400">
              Email Address
            </label>
            <div className="relative">
              <User className="absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-gray-300" />
              <input
                type="email"
                required
                maxLength={254}               // RFC 5321 max email length
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="name@company.com"
                className="w-full rounded-2xl border border-gray-100 bg-gray-50/50 py-4 pl-12 pr-4 text-sm font-semibold outline-none transition-all focus:border-[#5d44ff] focus:ring-4 focus:ring-indigo-50"
              />
            </div>
          </div>

          {/* Password */}
          <div className="space-y-1.5">
            <label className="ml-1 text-[10px] font-black uppercase tracking-widest text-gray-400">
              Password
            </label>
            <div className="relative">
              <Lock className="absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-gray-300" />
              <input
                type="password"
                required
                maxLength={128}               // sane upper bound
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                className="w-full rounded-2xl border border-gray-100 bg-gray-50/50 py-4 pl-12 pr-4 text-sm font-semibold outline-none transition-all focus:border-[#5d44ff] focus:ring-4 focus:ring-indigo-50"
              />
            </div>
          </div>

          {/* Submit */}
          <button
            type="submit"
            disabled={loading}
            className="w-full overflow-hidden rounded-2xl bg-[#5d44ff] py-4 font-black text-white shadow-xl shadow-indigo-100 transition-all hover:bg-[#4b36d6] active:scale-[0.98] disabled:bg-gray-300"
          >
            <span className="flex items-center justify-center gap-2">
              {loading ? (
                <>
                  <Loader2 className="h-5 w-5 animate-spin" />
                  Processing...
                </>
              ) : (
                'Sign In'
              )}
            </span>
          </button>
        </form>

        <p className="mt-8 text-center text-xs font-bold text-gray-400">
          Trouble logging in?{' '}
          <span className="text-[#5d44ff] cursor-pointer">Contact Admin</span>
        </p>

      </div>
    </div>
  )
}
