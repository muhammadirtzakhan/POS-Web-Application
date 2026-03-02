'use client'

import { useState, useEffect, useCallback } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import { supabase } from '@/lib/supabase'
import {
  LayoutDashboard, Package, TrendingUp,
  FileText, DollarSign, FilePlus, HardDrive,
  LogOut, Menu, X, ChevronRight,
} from 'lucide-react'

// ─── Nav config — matches screenshot order exactly ────────────────────────────

const NAV = [
  { label: 'Dashboard',      href: '/dashboard/owner/ownerDashboard',           icon: LayoutDashboard, exact: true },
  { label: 'Inventory',      href: '/dashboard/employee/inventory', icon: Package          },
  { label: 'Insights',       href: '/dashboard/owner/businessInsight',  icon: TrendingUp       },
  { label: 'Report',         href: '/dashboard/owner/report',    icon: FileText         },
  { label: 'Balance',        href: '/dashboard/owner/balance',   icon: DollarSign       },
  { label: 'Create Invoice', href: '/dashboard/owner/invoice',   icon: FilePlus         },
  { label: 'Create Backup',  href: '/dashboard/owner/backup',    icon: HardDrive        },
]

// ─── Component ────────────────────────────────────────────────────────────────

export default function OwnerLayout({ children }: { children: React.ReactNode }) {
  const router   = useRouter()
  const pathname = usePathname()

  const [open,     setOpen]     = useState(false)
  const [company,  setCompany]  = useState('Billing System')

  useEffect(() => {
    supabase.auth.getSession().then(async ({ data: { session } }) => {
      if (!session?.user) return
      const { data } = await supabase
        .from('profiles').select('company_name').eq('id', session.user.id).single()
      if (data?.company_name) setCompany(data.company_name)
    })
  }, [])

  useEffect(() => { setOpen(false) }, [pathname])

  useEffect(() => {
    const fn = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('keydown', fn)
    return () => document.removeEventListener('keydown', fn)
  }, [])

  const handleLogout = useCallback(async () => {
    await supabase.auth.signOut()
    router.push('/login')
  }, [router])

  // ─── Sidebar inner ────────────────────────────────────────────────────────

  const SidebarInner = () => (
    <div className="flex flex-col h-full select-none">

      {/* Brand — just styled text, matching screenshot */}
      <div className="px-6 py-6">
        <span className="text-[17px] font-black text-indigo-600 leading-none">{company}</span>
      </div>

      {/* Nav */}
      <nav className="flex-1 px-3 space-y-0.5 overflow-y-auto">
        {NAV.map(({ label, href, icon: Icon, exact }) => {
          const active = exact ? pathname === href : pathname.startsWith(href)
          return (
            <button
              key={href}
              onClick={() => router.push(href)}
              className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-[13px] font-semibold transition-all group ${
                active
                  ? 'bg-indigo-50 text-indigo-600'
                  : 'text-gray-500 hover:text-gray-800 hover:bg-gray-50'
              }`}
            >
              <Icon
                size={17}
                className={`shrink-0 ${
                  active ? 'text-indigo-500' : 'text-gray-400 group-hover:text-gray-600'
                }`}
              />
              <span className="flex-1 text-left">{label}</span>
            </button>
          )
        })}
      </nav>

      {/* Logout — red, at bottom, matching screenshot */}
      <div className="px-3 pb-6 pt-4 border-t border-gray-100 mt-4">
        <button
          onClick={handleLogout}
          className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-[13px] font-semibold text-red-500 hover:bg-red-50 transition-all"
        >
          <LogOut size={17} className="shrink-0" />
          Logout
        </button>
      </div>
    </div>
  )

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="flex h-screen overflow-hidden bg-[#f8f9fc] font-sans">

      {/* Desktop sidebar */}
      <aside className="hidden md:flex flex-col w-[200px] shrink-0 bg-white border-r border-gray-100 h-full">
        <SidebarInner />
      </aside>

      {/* Mobile overlay */}
      {open && (
        <div
          className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm md:hidden"
          onClick={() => setOpen(false)}
        >
          <aside
            className="absolute left-0 top-0 h-full w-[200px] bg-white shadow-2xl flex flex-col animate-in slide-in-from-left duration-200"
            onClick={e => e.stopPropagation()}
          >
            <button
              onClick={() => setOpen(false)}
              className="absolute top-4 right-3 p-1.5 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-lg z-10"
            >
              <X size={15} />
            </button>
            <SidebarInner />
          </aside>
        </div>
      )}

      {/* Content area */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">

        {/* Mobile top bar */}
        <header className="md:hidden flex items-center justify-between px-4 py-3 bg-white border-b border-gray-100 shrink-0">
          <button
            onClick={() => setOpen(true)}
            className="p-2 text-gray-600 hover:bg-gray-100 rounded-xl transition-colors"
          >
            <Menu size={20} />
          </button>
          <span className="text-sm font-black text-indigo-600">{company}</span>
          <div className="w-9" />
        </header>

        <main className="flex-1 overflow-y-auto">
          {children}
        </main>
      </div>
    </div>
  )
}