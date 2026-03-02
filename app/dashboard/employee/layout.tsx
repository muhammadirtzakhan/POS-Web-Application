'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import { supabase } from '@/lib/supabase'
import {
  FileText, Package, LayoutDashboard,
  LogOut, Menu, X, ChevronRight,
  Building2, Cloud, WifiOff, User
} from 'lucide-react'

// ─── Nav config ───────────────────────────────────────────────────────────────

interface NavItem {
  label: string
  href:  string
  icon:  React.ReactNode
  roles: string[]
}

const NAV_ITEMS: NavItem[] = [
  {
    label: 'Dashboard',
    href:  '',                // relative — filled in based on role prefix
    icon:  <LayoutDashboard size={18} />,
    roles: ['owner', 'employee', 'super_admin'],
  },
  {
    label: 'Create Invoice',
    href:  '/invoice',
    icon:  <FileText size={18} />,
    roles: ['owner', 'employee'],
  },
  {
    label: 'Inventory',
    href:  '/inventory',
    icon:  <Package size={18} />,
    roles: ['owner', 'employee'],
  },
]

// ─── Component ────────────────────────────────────────────────────────────────

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const router   = useRouter()
  const pathname = usePathname()

  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [role,        setRole]        = useState<string | null>(null)
  const [userName,    setUserName]    = useState<string>('')
  const [companyName, setCompanyName] = useState<string>('')
  const [isOnline,    setIsOnline]    = useState(true)
  const overlayRef = useRef<HTMLDivElement>(null)

  // ── Fetch user identity for sidebar header ─────────────────────────────────

  useEffect(() => {
    async function loadIdentity() {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.user) return

      const { data } = await supabase
        .from('profiles')
        .select('role, full_name, company_name')
        .eq('id', session.user.id)
        .single()

      if (data) {
        setRole(data.role)
        setUserName(data.full_name ?? session.user.email ?? '')
        setCompanyName(data.company_name ?? '')
      }
    }
    loadIdentity()
  }, [])

  // ── Online status ──────────────────────────────────────────────────────────

  useEffect(() => {
    setIsOnline(navigator.onLine)
    const on  = () => setIsOnline(true)
    const off = () => setIsOnline(false)
    window.addEventListener('online',  on)
    window.addEventListener('offline', off)
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off) }
  }, [])

  // ── Close sidebar when clicking the overlay ────────────────────────────────

  const handleOverlayClick = useCallback((e: React.MouseEvent) => {
    if (e.target === overlayRef.current) setSidebarOpen(false)
  }, [])

  // ── Close sidebar on route change (mobile) ─────────────────────────────────

  useEffect(() => { setSidebarOpen(false) }, [pathname])

  // ── Close on Escape ────────────────────────────────────────────────────────

  useEffect(() => {
    const fn = (e: KeyboardEvent) => { if (e.key === 'Escape') setSidebarOpen(false) }
    document.addEventListener('keydown', fn)
    return () => document.removeEventListener('keydown', fn)
  }, [])

  // ── Resolve nav href based on role ─────────────────────────────────────────

  const basePrefix = role === 'owner'
    ? '/dashboard/owner'
    : role === 'super_admin'
    ? '/dashboard'
    : '/dashboard/employee'

  const resolvedNav = NAV_ITEMS
    .filter(item => !role || item.roles.includes(role))
    .map(item => ({
      ...item,
      href: item.href === '' ? basePrefix : `${basePrefix}${item.href}`,
    }))

  // ── Logout ────────────────────────────────────────────────────────────────

  const handleLogout = useCallback(async () => {
    await supabase.auth.signOut()
    router.push('/login')
  }, [router])

  // ─── Sidebar Content (shared between mobile overlay + desktop) ─────────────

  const SidebarContent = () => (
    <div className="flex flex-col h-full">

      {/* Header */}
      <div className="px-5 py-6 border-b border-gray-100">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-indigo-600 flex items-center justify-center shadow-lg shadow-indigo-200 shrink-0">
            <Building2 size={16} className="text-white" />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-black text-gray-900 truncate">
              {companyName || 'POS System'}
            </p>
            <p className="text-[10px] text-gray-400 font-semibold truncate capitalize">
              {role?.replace('_', ' ') ?? ''}
            </p>
          </div>
        </div>
      </div>

      {/* Nav Links */}
      <nav className="flex-1 px-3 py-5 space-y-1 overflow-y-auto">
        {resolvedNav.map(item => {
          const active = pathname === item.href || pathname.startsWith(item.href + '/')
          return (
            <button
              key={item.href}
              onClick={() => router.push(item.href)}
              className={`w-full flex items-center gap-3 px-4 py-2.5 rounded-xl text-sm font-semibold transition-all group ${
                active
                  ? 'bg-indigo-50 text-indigo-600 border border-indigo-100'
                  : 'text-gray-500 hover:text-gray-900 hover:bg-gray-50'
              }`}
            >
              <span className={active ? 'text-indigo-500' : 'text-gray-400 group-hover:text-gray-600'}>
                {item.icon}
              </span>
              <span className="flex-1 text-left">{item.label}</span>
              {active && <ChevronRight size={14} className="text-indigo-400" />}
            </button>
          )
        })}
      </nav>

      {/* User + Status footer */}
      <div className="px-3 py-4 border-t border-gray-100 space-y-2">
        {/* Connection status */}
        <div className={`flex items-center gap-2 px-4 py-2 rounded-xl text-[10px] font-bold ${
          isOnline ? 'bg-emerald-50 text-emerald-600' : 'bg-red-50 text-red-600'
        }`}>
          {isOnline ? <Cloud size={12} /> : <WifiOff size={12} />}
          {isOnline ? 'Connected' : 'Offline Mode'}
        </div>

        {/* User identity */}
        <div className="flex items-center gap-3 px-4 py-2 bg-gray-50 rounded-xl">
          <div className="w-7 h-7 rounded-full bg-indigo-100 flex items-center justify-center shrink-0">
            <User size={13} className="text-indigo-500" />
          </div>
          <p className="text-xs font-semibold text-gray-600 truncate flex-1">{userName}</p>
        </div>

        {/* Logout */}
        <button
          onClick={handleLogout}
          className="w-full flex items-center gap-3 px-4 py-2.5 rounded-xl text-sm font-semibold text-red-500 hover:bg-red-50 transition-all"
        >
          <LogOut size={16} />
          Sign Out
        </button>
      </div>
    </div>
  )

  // ─── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="flex h-screen overflow-hidden bg-gray-50 font-sans">

      {/* ── Desktop Sidebar (hidden on mobile) ── */}
      <aside className="hidden md:flex flex-col w-60 shrink-0 bg-white border-r border-gray-100 shadow-sm h-full">
        <SidebarContent />
      </aside>

      {/* ── Mobile Sidebar Overlay ── */}
      {sidebarOpen && (
        <div
          ref={overlayRef}
          className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm md:hidden"
          onClick={handleOverlayClick}
        >
          {/* Slide-in panel */}
          <aside
            className="absolute left-0 top-0 h-full w-72 bg-white shadow-2xl flex flex-col
                       animate-in slide-in-from-left duration-200"
            onClick={e => e.stopPropagation()}
          >
            {/* Close button inside panel */}
            <button
              onClick={() => setSidebarOpen(false)}
              className="absolute top-4 right-4 p-2 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-lg transition-colors z-10"
            >
              <X size={18} />
            </button>
            <SidebarContent />
          </aside>
        </div>
      )}

      {/* ── Main content area ── */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">

        {/* ── Mobile Top Bar ── */}
        <header className="md:hidden flex items-center justify-between px-4 py-3 bg-white border-b border-gray-100 shadow-sm shrink-0">
          <button
            onClick={() => setSidebarOpen(true)}
            className="p-2 text-gray-600 hover:bg-gray-100 rounded-xl transition-colors"
            aria-label="Open menu"
          >
            <Menu size={22} />
          </button>

          {/* Mobile page title / brand */}
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-lg bg-indigo-600 flex items-center justify-center">
              <Building2 size={13} className="text-white" />
            </div>
            <span className="text-sm font-black text-gray-800 truncate max-w-[160px]">
              {companyName || 'POS System'}
            </span>
          </div>

          {/* Mobile connection badge */}
          <div className={`flex items-center gap-1 px-2 py-1 rounded-full text-[9px] font-bold ${
            isOnline ? 'bg-emerald-50 text-emerald-600' : 'bg-red-50 text-red-600'
          }`}>
            {isOnline ? <Cloud size={10} /> : <WifiOff size={10} />}
            {isOnline ? 'ON' : 'OFF'}
          </div>
        </header>

        {/* ── Page content ── */}
        <main className="flex-1 overflow-y-auto">
          {children}
        </main>
      </div>
    </div>
  )
}