'use client'

import { useState, useCallback, useRef, useEffect, useMemo } from 'react'
import { adminCreateUser, adminResetPassword, adminDeleteCompany, adminUpdateCompany } from '../../action'
import { supabase } from '@/lib/supabase'
import { useRouter } from 'next/navigation'
import {
  Building2, KeyRound, LogOut, Plus, ChevronRight,
  Upload, X, Phone, Mail, Globe, MapPin, Hash,
  Loader2, Eye, EyeOff, AlertCircle, RefreshCcw,
  Tag, Trash2, Edit, CheckCircle2, Search, Save
} from 'lucide-react'

// ─── Types ────────────────────────────────────────────────────────────────────

interface CompanyProfile {
  name:       string
  address:    string
  city:       string
  phone:      string
  email:      string
  website:    string
  taxNumber:  string
  tagline:    string
  logoBase64: string
}

interface Company {
  id:          string
  name:        string
  email?:      string
  city?:       string
  phone?:      string
  address?:    string
  website?:    string
  tax_number?: string
  tagline?:    string
  logo_base64?:string
  created_at:  string
}

type NavTab = 'create' | 'companies' | 'reset'

const EMPTY_PROFILE: CompanyProfile = {
  name: '', address: '', city: '', phone: '',
  email: '', website: '', taxNumber: '', tagline: '', logoBase64: '',
}

// ─── Toasts — stable refs to prevent dependency loops ────────────────────────
// The flash bug was caused by toast object being recreated every render,
// which invalidated useCallback deps → infinite useEffect loop.

type ToastType = 'success' | 'error'
interface Toast { id: string; type: ToastType; message: string }

function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([])

  // Stable refs — these never change identity, safe to use in useCallback deps
  const successRef = useRef<(msg: string) => void>(null!)
  const errorRef   = useRef<(msg: string) => void>(null!)

  useEffect(() => {
    const add = (type: ToastType, message: string) => {
      const id = crypto.randomUUID()
      setToasts(prev => [...prev, { id, type, message }])
      setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 4000)
    }
    successRef.current = (msg) => add('success', msg)
    errorRef.current   = (msg) => add('error',   msg)
  }, [])

  const remove = useCallback((id: string) => setToasts(p => p.filter(t => t.id !== id)), [])

  // Stable function wrappers — identity never changes
  const success = useCallback((msg: string) => successRef.current?.(msg), [])
  const error   = useCallback((msg: string) => errorRef.current?.(msg),   [])

  return { toasts, success, error, remove }
}

// ─── Shared input component matching inventory style ──────────────────────────

function Field({
  label, icon, type = 'text', value, onChange, placeholder, required, hint
}: {
  label: string; icon?: React.ReactNode; type?: string
  value: string; onChange: (v: string) => void
  placeholder?: string; required?: boolean; hint?: string
}) {
  const [show, setShow] = useState(false)
  const isPass = type === 'password'
  return (
    <div className="space-y-1">
      <label className="text-[10px] font-bold uppercase tracking-wider text-gray-400 ml-1">{label}</label>
      <div className="relative">
        {icon && <div className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-300">{icon}</div>}
        <input
          type={isPass && show ? 'text' : type}
          required={required}
          value={value}
          placeholder={placeholder}
          onChange={e => onChange(e.target.value)}
          className={`w-full border rounded-xl py-3 text-sm outline-none focus:ring-2 focus:ring-indigo-500 transition-colors ${icon ? 'pl-9' : 'pl-3'} pr-10`}
        />
        {isPass && (
          <button type="button" onClick={() => setShow(s => !s)}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-300 hover:text-gray-500">
            {show ? <EyeOff size={14} /> : <Eye size={14} />}
          </button>
        )}
      </div>
      {hint && <p className="text-[10px] text-gray-400 ml-1">{hint}</p>}
    </div>
  )
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function SuperAdminDashboard() {
  const router = useRouter()
  const { toasts, success, error, remove } = useToasts()

  const [nav, setNav]         = useState<NavTab>('create')
  const [step, setStep]       = useState(1)
  const [loading, setLoading] = useState(false)

  // Company creation wizard
  const [profile, setProfile]         = useState<CompanyProfile>(EMPTY_PROFILE)
  const createdCompanyId              = useRef<string | null>(null)
  const [ownerEmail, setOwnerEmail]   = useState('')
  const [ownerPass,  setOwnerPass]    = useState('')
  const [empEmail,   setEmpEmail]     = useState('')
  const [empPass,    setEmpPass]      = useState('')

  // Password reset
  const [resetEmail, setResetEmail] = useState('')
  const [resetPass,  setResetPass]  = useState('')

  // Companies list
  const [companies,   setCompanies]   = useState<Company[]>([])
  const [loadingList, setLoadingList] = useState(false)
  const [search,      setSearch]      = useState('')

  // Edit modal
  const [editTarget,  setEditTarget]  = useState<Company | null>(null)
  const [editProfile, setEditProfile] = useState<CompanyProfile>(EMPTY_PROFILE)
  const [editLoading, setEditLoading] = useState(false)

  // Delete confirmation
  const [deleteTarget, setDeleteTarget] = useState<Company | null>(null)
  const [deleteLoading, setDeleteLoading] = useState(false)

  // ── Logo upload (shared for create + edit) ────────────────────────────────

  const handleLogoUpload = useCallback((
    e: React.ChangeEvent<HTMLInputElement>,
    setter: (fn: (p: CompanyProfile) => CompanyProfile) => void
  ) => {
    const file = e.target.files?.[0]
    if (!file) return
    if (file.size > 500_000) { error('Logo must be under 500 KB'); return }
    const reader = new FileReader()
    reader.onload = ev => setter(p => ({ ...p, logoBase64: ev.target?.result as string }))
    reader.readAsDataURL(file)
  }, [error])

  // ── Step 1: Create company ────────────────────────────────────────────────

  const handleCreateCompany = useCallback(async (e: React.FormEvent) => {
    e.preventDefault()
    if (!profile.name.trim()) { error('Company name is required'); return }
    setLoading(true)
    try {
      const { data, err: dbErr } = await supabase.from('companies').insert([{
        name:        profile.name.trim(),
        address:     profile.address   || null,
        city:        profile.city      || null,
        phone:       profile.phone     || null,
        email:       profile.email     || null,
        website:     profile.website   || null,
        tax_number:  profile.taxNumber || null,
        tagline:     profile.tagline   || null,
        logo_base64: profile.logoBase64 || null,
      }]).select('id').single() as any

      if (dbErr) throw dbErr
      createdCompanyId.current = data.id
      success(`${profile.name} created — now set up the owner.`)
      setStep(2)
    } catch (err: any) {
      error(err.message ?? 'Failed to create company')
    } finally {
      setLoading(false)
    }
  }, [profile, success, error])

  // ── Step 2: Owner account ─────────────────────────────────────────────────

  const handleCreateOwner = useCallback(async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    try {
      const result = await adminCreateUser(ownerEmail, ownerPass, profile.name, 'owner')
      if (result.error) throw new Error(result.error)
      success(`Owner ${ownerEmail} created`)
      setOwnerEmail(''); setOwnerPass('')
      setStep(3)
    } catch (err: any) {
      error(err.message ?? 'Failed to create owner')
    } finally {
      setLoading(false)
    }
  }, [ownerEmail, ownerPass, profile.name, success, error])

  // ── Step 3: Add employee ──────────────────────────────────────────────────

  const handleAddEmployee = useCallback(async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    try {
      const result = await adminCreateUser(empEmail, empPass, profile.name, 'employee')
      if (result.error) throw new Error(result.error)
      success(`${empEmail} added as employee`)
      setEmpEmail(''); setEmpPass('')
    } catch (err: any) {
      error(err.message ?? 'Failed to add employee')
    } finally {
      setLoading(false)
    }
  }, [empEmail, empPass, profile.name, success, error])

  // ── Password reset ────────────────────────────────────────────────────────

  const handleReset = useCallback(async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    try {
      const result = await adminResetPassword(resetEmail, resetPass)
      if (!result.success) throw new Error(result.error)
      success(`Password updated for ${resetEmail}`)
      setResetEmail(''); setResetPass('')
    } catch (err: any) {
      error(err.message ?? 'Reset failed')
    } finally {
      setLoading(false)
    }
  }, [resetEmail, resetPass, success, error])

  // ── Fetch companies — no toast in deps, uses stable refs ──────────────────

  const fetchCompanies = useCallback(async () => {
    setLoadingList(true)
    try {
      const { data, error: dbErr } = await supabase
        .from('companies')
        .select('id, name, email, city, phone, address, website, tax_number, tagline, logo_base64, created_at')
        .order('created_at', { ascending: false })
      if (dbErr) throw dbErr
      setCompanies(data ?? [])
    } catch {
      errorRef.current?.('Could not load companies')
    } finally {
      setLoadingList(false)
    }
  }, []) // ← empty deps: stable forever, no toast object in here

  // Stable error ref for fetchCompanies to use without causing dep loops
  const errorRef = useRef<(msg: string) => void>(null!)
  useEffect(() => { errorRef.current = error }, [error])

  useEffect(() => {
    if (nav === 'companies') fetchCompanies()
  }, [nav, fetchCompanies])

  // ── Filtered companies ────────────────────────────────────────────────────

  const filteredCompanies = useMemo(() => {
    if (!search.trim()) return companies
    const q = search.toLowerCase()
    return companies.filter(c =>
      c.name.toLowerCase().includes(q) ||
      c.city?.toLowerCase().includes(q) ||
      c.email?.toLowerCase().includes(q)
    )
  }, [companies, search])

  // ── Delete company ────────────────────────────────────────────────────────

  const handleDelete = useCallback(async () => {
    if (!deleteTarget) return
    setDeleteLoading(true)
    try {
      const result = await adminDeleteCompany(deleteTarget.id)
      if (result.error) throw new Error(result.error)
      setCompanies(prev => prev.filter(c => c.id !== deleteTarget.id))
      success(`${deleteTarget.name} deleted`)
      setDeleteTarget(null)
    } catch (err: any) {
      error(err.message ?? 'Delete failed')
    } finally {
      setDeleteLoading(false)
    }
  }, [deleteTarget, success, error])

  // ── Edit company ──────────────────────────────────────────────────────────

  const openEdit = useCallback((company: Company) => {
    setEditTarget(company)
    setEditProfile({
      name:       company.name       ?? '',
      address:    company.address    ?? '',
      city:       company.city       ?? '',
      phone:      company.phone      ?? '',
      email:      company.email      ?? '',
      website:    company.website    ?? '',
      taxNumber:  company.tax_number ?? '',
      tagline:    company.tagline    ?? '',
      logoBase64: company.logo_base64 ?? '',
    })
  }, [])

  const handleEditSave = useCallback(async (e: React.FormEvent) => {
    e.preventDefault()
    if (!editTarget) return
    setEditLoading(true)
    try {
      const result = await adminUpdateCompany(editTarget.id, {
        name:        editProfile.name.trim(),
        address:     editProfile.address   || null,
        city:        editProfile.city      || null,
        phone:       editProfile.phone     || null,
        email:       editProfile.email     || null,
        website:     editProfile.website   || null,
        tax_number:  editProfile.taxNumber || null,
        tagline:     editProfile.tagline   || null,
        logo_base64: editProfile.logoBase64 || null,
      })
      if (result.error) throw new Error(result.error)

      // Update local list immediately — no refetch needed
      setCompanies(prev => prev.map(c =>
        c.id === editTarget.id
          ? { ...c, ...result.data }
          : c
      ))
      success(`${editProfile.name} updated`)
      setEditTarget(null)
    } catch (err: any) {
      error(err.message ?? 'Update failed')
    } finally {
      setEditLoading(false)
    }
  }, [editTarget, editProfile, success, error])

  // ── Logout ────────────────────────────────────────────────────────────────

  const handleLogout = useCallback(async () => {
    await supabase.auth.signOut()
    router.push('/login')
  }, [router])

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-gray-50 font-sans text-gray-900 flex">

      {/* ── Sidebar ── */}
      <aside className="w-60 shrink-0 bg-white border-r border-gray-100 flex flex-col h-screen sticky top-0 shadow-sm">
        <div className="px-6 py-6 border-b border-gray-100">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-indigo-600 flex items-center justify-center shadow-lg shadow-indigo-200">
              <Building2 size={16} className="text-white" />
            </div>
            <div>
              <p className="text-[10px] font-black tracking-widest uppercase text-indigo-500">SYSTEM</p>
              <p className="text-sm font-bold text-gray-800">Super Admin</p>
            </div>
          </div>
        </div>

        <nav className="flex-1 px-3 py-5 space-y-1">
          {([
            { id: 'create',    icon: <Plus size={16} />,      label: 'New Company' },
            { id: 'companies', icon: <Building2 size={16} />, label: 'All Companies' },
            { id: 'reset',     icon: <KeyRound size={16} />,  label: 'Password Reset' },
          ] as { id: NavTab; icon: React.ReactNode; label: string }[]).map(item => (
            <button
              key={item.id}
              onClick={() => {
                setNav(item.id)
                if (item.id === 'create') { setStep(1); setProfile(EMPTY_PROFILE) }
              }}
              className={`w-full flex items-center gap-3 px-4 py-2.5 rounded-xl text-sm font-semibold transition-all ${
                nav === item.id
                  ? 'bg-indigo-50 text-indigo-600 border border-indigo-100'
                  : 'text-gray-500 hover:text-gray-900 hover:bg-gray-50'
              }`}
            >
              {item.icon}{item.label}
            </button>
          ))}
        </nav>

        <div className="px-3 py-4 border-t border-gray-100">
          <button
            onClick={handleLogout}
            className="w-full flex items-center gap-3 px-4 py-2.5 rounded-xl text-sm font-semibold text-red-500 hover:bg-red-50 transition-all"
          >
            <LogOut size={16} /> Sign Out
          </button>
        </div>
      </aside>

      {/* ── Main ── */}
      <main className="flex-1 p-8 overflow-y-auto">
        <div className="max-w-2xl mx-auto">

          {/* ══ CREATE COMPANY ══ */}
          {nav === 'create' && (
            <div>
              <h1 className="text-2xl font-black mb-1">
                {step === 1 ? 'Company Profile' : step === 2 ? 'Owner Account' : 'Add Employees'}
              </h1>
              <p className="text-sm text-gray-500 mb-6">
                {step === 1 ? 'Set up branding and contact details'
                  : step === 2 ? 'Create the owner login credentials'
                  : `Adding staff to ${profile.name}`}
              </p>

              {/* Progress */}
              <div className="flex gap-2 mb-8">
                {['Company Profile', 'Owner Account', 'Employees'].map((label, i) => (
                  <div key={i} className="flex-1">
                    <div className={`h-1 rounded-full mb-1.5 transition-all duration-500 ${i + 1 <= step ? 'bg-indigo-500' : 'bg-gray-200'}`} />
                    <p className={`text-[10px] font-bold uppercase tracking-wider ${i + 1 <= step ? 'text-indigo-500' : 'text-gray-400'}`}>{label}</p>
                  </div>
                ))}
              </div>

              {/* Step 1 */}
              {step === 1 && (
                <form onSubmit={handleCreateCompany} className="bg-white rounded-3xl border border-gray-100 shadow-sm p-6 space-y-5">
                  {/* Logo */}
                  <div className="space-y-2">
                    <p className="text-[10px] font-bold uppercase tracking-wider text-gray-400 ml-1">Company Logo</p>
                    <div className="flex items-center gap-4">
                      <div className="w-20 h-20 rounded-2xl border-2 border-dashed border-gray-200 flex items-center justify-center overflow-hidden bg-gray-50 shrink-0">
                        {profile.logoBase64
                          ? <img src={profile.logoBase64} alt="Logo" className="w-full h-full object-contain p-1" />
                          : <Building2 size={28} className="text-gray-300" />
                        }
                      </div>
                      <div>
                        <label className="cursor-pointer inline-flex items-center gap-2 px-4 py-2 bg-gray-50 hover:bg-gray-100 border border-gray-200 rounded-xl text-sm font-semibold text-gray-600 transition-colors">
                          <Upload size={14} />
                          {profile.logoBase64 ? 'Change Logo' : 'Upload Logo'}
                          <input type="file" accept="image/*" className="hidden" onChange={e => handleLogoUpload(e, setProfile)} />
                        </label>
                        <p className="text-[10px] text-gray-400 mt-1.5">PNG, JPG · Max 500 KB</p>
                        {profile.logoBase64 && (
                          <button type="button" onClick={() => setProfile(p => ({ ...p, logoBase64: '' }))}
                            className="text-[10px] text-red-400 hover:text-red-600 mt-1 flex items-center gap-1">
                            <X size={10} /> Remove
                          </button>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div className="col-span-2">
                      <Field label="Company Name *" icon={<Building2 size={14} />} value={profile.name} onChange={v => setProfile(p => ({ ...p, name: v }))} placeholder="Acme Industries Ltd." required />
                    </div>
                    <div className="col-span-2">
                      <Field label="Tagline" icon={<Tag size={14} />} value={profile.tagline} onChange={v => setProfile(p => ({ ...p, tagline: v }))} placeholder="Quality you can trust" />
                    </div>
                    <div className="col-span-2">
                      <Field label="Street Address" icon={<MapPin size={14} />} value={profile.address} onChange={v => setProfile(p => ({ ...p, address: v }))} placeholder="123 Main Street, Block A" />
                    </div>
                    <Field label="City" icon={<MapPin size={14} />} value={profile.city} onChange={v => setProfile(p => ({ ...p, city: v }))} placeholder="Karachi" />
                    <Field label="Phone" icon={<Phone size={14} />} value={profile.phone} onChange={v => setProfile(p => ({ ...p, phone: v }))} placeholder="+92 300 1234567" />
                    <Field label="Email" icon={<Mail size={14} />} type="email" value={profile.email} onChange={v => setProfile(p => ({ ...p, email: v }))} placeholder="info@company.com" />
                    <Field label="Website" icon={<Globe size={14} />} value={profile.website} onChange={v => setProfile(p => ({ ...p, website: v }))} placeholder="www.company.com" />
                    <div className="col-span-2">
                      <Field label="Tax / NTN Number" icon={<Hash size={14} />} value={profile.taxNumber} onChange={v => setProfile(p => ({ ...p, taxNumber: v }))} placeholder="NTN-1234567-8" hint="Printed on every invoice for tax compliance" />
                    </div>
                  </div>

                  <button type="submit" disabled={loading}
                    className="w-full bg-indigo-600 hover:bg-indigo-700 disabled:bg-gray-200 disabled:cursor-not-allowed text-white py-3 rounded-2xl font-bold flex items-center justify-center gap-2 transition-colors shadow-lg shadow-indigo-100">
                    {loading ? <Loader2 className="animate-spin" size={16} /> : <ChevronRight size={16} />}
                    {loading ? 'Creating...' : 'Save Profile & Continue'}
                  </button>
                </form>
              )}

              {/* Step 2 */}
              {step === 2 && (
                <form onSubmit={handleCreateOwner} className="bg-white rounded-3xl border border-gray-100 shadow-sm p-6 space-y-4">
                  <div className="p-3 bg-indigo-50 border border-indigo-100 rounded-xl mb-2">
                    <p className="text-xs text-indigo-600 font-semibold flex items-center gap-2">
                      <CheckCircle2 size={14} /> Company <strong>{profile.name}</strong> created.
                    </p>
                  </div>
                  <Field label="Owner Email *" icon={<Mail size={14} />} type="email" value={ownerEmail} onChange={setOwnerEmail} placeholder="owner@company.com" required />
                  <Field label="Password *" icon={<KeyRound size={14} />} type="password" value={ownerPass} onChange={setOwnerPass} placeholder="Min. 8 characters" required hint="Owner can change this after first login" />
                  <button type="submit" disabled={loading}
                    className="w-full bg-indigo-600 hover:bg-indigo-700 disabled:bg-gray-200 text-white py-3 rounded-2xl font-bold flex items-center justify-center gap-2 transition-colors shadow-lg shadow-indigo-100">
                    {loading ? <Loader2 className="animate-spin" size={16} /> : <ChevronRight size={16} />}
                    {loading ? 'Creating...' : 'Create Owner & Continue'}
                  </button>
                  <button type="button" onClick={() => setStep(1)} className="w-full text-gray-400 hover:text-gray-600 text-sm py-2 transition-colors">
                    ← Back to company profile
                  </button>
                </form>
              )}

              {/* Step 3 */}
              {step === 3 && (
                <div className="space-y-4">
                  <div className="p-3 bg-emerald-50 border border-emerald-100 rounded-xl">
                    <p className="text-xs text-emerald-600 font-semibold flex items-center gap-2">
                      <CheckCircle2 size={14} /> <strong>{profile.name}</strong> is fully set up. Add employees one at a time.
                    </p>
                  </div>
                  <form onSubmit={handleAddEmployee} className="bg-white rounded-3xl border border-gray-100 shadow-sm p-6 space-y-4">
                    <Field label="Employee Email *" icon={<Mail size={14} />} type="email" value={empEmail} onChange={setEmpEmail} placeholder="employee@company.com" required />
                    <Field label="Password *" icon={<KeyRound size={14} />} type="password" value={empPass} onChange={setEmpPass} placeholder="Min. 8 characters" required />
                    <button type="submit" disabled={loading}
                      className="w-full bg-emerald-600 hover:bg-emerald-700 disabled:bg-gray-200 text-white py-3 rounded-2xl font-bold flex items-center justify-center gap-2 transition-colors">
                      {loading ? <Loader2 className="animate-spin" size={16} /> : <Plus size={16} />}
                      {loading ? 'Adding...' : 'Add Employee'}
                    </button>
                  </form>
                  <button onClick={() => { setStep(1); setProfile(EMPTY_PROFILE); createdCompanyId.current = null }}
                    className="w-full border-2 border-dashed border-gray-200 hover:border-indigo-300 hover:text-indigo-500 text-gray-400 py-3 rounded-2xl font-bold flex items-center justify-center gap-2 transition-all">
                    <Plus size={16} /> Start New Company
                  </button>
                </div>
              )}
            </div>
          )}

          {/* ══ ALL COMPANIES ══ */}
          {nav === 'companies' && (
            <div>
              <div className="flex items-center justify-between mb-6">
                <div>
                  <h1 className="text-2xl font-black">All Companies</h1>
                  <p className="text-sm text-gray-500 mt-0.5">{filteredCompanies.length} of {companies.length} shown</p>
                </div>
                <button onClick={fetchCompanies} className="p-2 text-gray-400 hover:text-gray-600 hover:bg-white border border-gray-100 rounded-xl transition-all shadow-sm">
                  <RefreshCcw size={16} className={loadingList ? 'animate-spin' : ''} />
                </button>
              </div>

              {/* Search */}
              <div className="relative mb-4">
                <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-300" size={16} />
                <input
                  type="text"
                  placeholder="Search by name, city or email..."
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  className="w-full pl-10 pr-4 py-3 bg-white border border-gray-100 rounded-2xl shadow-sm outline-none focus:ring-2 focus:ring-indigo-500 text-sm"
                />
              </div>

              {loadingList ? (
                <div className="flex items-center justify-center py-24 text-gray-400 gap-3">
                  <Loader2 className="animate-spin" size={20} />
                  <span className="text-sm font-bold">Loading companies...</span>
                </div>
              ) : filteredCompanies.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-24 text-gray-400 gap-3">
                  <Building2 size={40} className="opacity-30" />
                  <p className="text-sm font-bold">{search ? 'No companies match your search.' : 'No companies yet.'}</p>
                  {!search && (
                    <button onClick={() => setNav('create')} className="text-indigo-500 text-sm font-semibold hover:underline">
                      Create your first company →
                    </button>
                  )}
                </div>
              ) : (
                <div className="bg-white rounded-3xl shadow-sm border border-gray-100 overflow-hidden">
                  <table className="w-full text-left">
                    <thead className="bg-gray-50/50 border-b border-gray-100">
                      <tr className="text-gray-400 text-[10px] uppercase font-bold tracking-wider">
                        <th className="px-6 py-4">Company</th>
                        <th className="px-6 py-4">Contact</th>
                        <th className="px-6 py-4">Created</th>
                        <th className="px-6 py-4 text-right">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-50">
                      {filteredCompanies.map(company => (
                        <tr key={company.id} className="hover:bg-gray-50/40 transition-colors">
                          <td className="px-6 py-4">
                            <div className="flex items-center gap-3">
                              {company.logo_base64
                                ? <img src={company.logo_base64} className="w-9 h-9 rounded-xl object-contain bg-gray-50 border border-gray-100 p-0.5 shrink-0" alt="" />
                                : <div className="w-9 h-9 rounded-xl bg-indigo-50 flex items-center justify-center shrink-0"><Building2 size={16} className="text-indigo-400" /></div>
                              }
                              <div>
                                <p className="font-bold text-sm text-gray-900">{company.name}</p>
                                {company.city && <p className="text-[11px] text-gray-400 flex items-center gap-1"><MapPin size={9} />{company.city}</p>}
                              </div>
                            </div>
                          </td>
                          <td className="px-6 py-4">
                            <div className="space-y-0.5">
                              {company.email && <p className="text-[11px] text-gray-500 flex items-center gap-1"><Mail size={9} />{company.email}</p>}
                              {company.phone && <p className="text-[11px] text-gray-500 flex items-center gap-1"><Phone size={9} />{company.phone}</p>}
                            </div>
                          </td>
                          <td className="px-6 py-4 text-[11px] text-gray-400">
                            {new Date(company.created_at).toLocaleDateString()}
                          </td>
                          <td className="px-6 py-4">
                            <div className="flex justify-end gap-1">
                              <button onClick={() => openEdit(company)}
                                className="p-2 text-indigo-500 hover:bg-indigo-50 rounded-lg transition-colors" title="Edit company">
                                <Edit size={15} />
                              </button>
                              <button onClick={() => setDeleteTarget(company)}
                                className="p-2 text-red-400 hover:bg-red-50 rounded-lg transition-colors" title="Delete company">
                                <Trash2 size={15} />
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {/* ══ PASSWORD RESET ══ */}
          {nav === 'reset' && (
            <div>
              <h1 className="text-2xl font-black mb-1">Force Password Reset</h1>
              <p className="text-sm text-gray-500 mb-6">Override any user's password directly</p>

              <div className="p-4 bg-amber-50 border border-amber-100 rounded-2xl mb-5 flex gap-3">
                <AlertCircle size={16} className="text-amber-500 shrink-0 mt-0.5" />
                <p className="text-xs text-amber-700 font-medium">
                  This immediately invalidates the user's current session. They must log in again with the new password.
                </p>
              </div>

              <form onSubmit={handleReset} className="bg-white rounded-3xl border border-gray-100 shadow-sm p-6 space-y-4">
                <Field label="User Email *" icon={<Mail size={14} />} type="email" value={resetEmail} onChange={setResetEmail} placeholder="target@company.com" required />
                <Field label="New Password *" icon={<KeyRound size={14} />} type="password" value={resetPass} onChange={setResetPass} placeholder="Min. 8 characters" required />
                <button type="submit" disabled={loading}
                  className="w-full bg-red-500 hover:bg-red-600 disabled:bg-gray-200 text-white py-3 rounded-2xl font-bold flex items-center justify-center gap-2 transition-colors">
                  {loading ? <Loader2 className="animate-spin" size={16} /> : <KeyRound size={16} />}
                  {loading ? 'Processing...' : 'Reset Password'}
                </button>
              </form>
            </div>
          )}
        </div>
      </main>

      {/* ══ EDIT COMPANY MODAL ══ */}
      {editTarget && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-3xl w-full max-w-lg shadow-2xl overflow-hidden max-h-[90vh] flex flex-col">
            <div className="p-5 border-b border-gray-100 flex justify-between items-center bg-gray-50/50 shrink-0">
              <h2 className="text-lg font-bold">Edit {editTarget.name}</h2>
              <button onClick={() => setEditTarget(null)} className="text-gray-300 hover:text-red-500 transition-colors"><X size={20} /></button>
            </div>
            <form onSubmit={handleEditSave} className="p-6 space-y-4 overflow-y-auto">
              {/* Logo */}
              <div className="flex items-center gap-4">
                <div className="w-16 h-16 rounded-xl border-2 border-dashed border-gray-200 flex items-center justify-center overflow-hidden bg-gray-50 shrink-0">
                  {editProfile.logoBase64
                    ? <img src={editProfile.logoBase64} alt="" className="w-full h-full object-contain p-1" />
                    : <Building2 size={20} className="text-gray-300" />
                  }
                </div>
                <div>
                  <label className="cursor-pointer inline-flex items-center gap-2 px-3 py-1.5 bg-gray-50 hover:bg-gray-100 border border-gray-200 rounded-lg text-xs font-semibold text-gray-600 transition-colors">
                    <Upload size={12} /> Change Logo
                    <input type="file" accept="image/*" className="hidden" onChange={e => handleLogoUpload(e, setEditProfile)} />
                  </label>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="col-span-2">
                  <Field label="Company Name *" value={editProfile.name} onChange={v => setEditProfile(p => ({ ...p, name: v }))} required />
                </div>
                <div className="col-span-2">
                  <Field label="Tagline" value={editProfile.tagline} onChange={v => setEditProfile(p => ({ ...p, tagline: v }))} />
                </div>
                <div className="col-span-2">
                  <Field label="Address" value={editProfile.address} onChange={v => setEditProfile(p => ({ ...p, address: v }))} />
                </div>
                <Field label="City" value={editProfile.city} onChange={v => setEditProfile(p => ({ ...p, city: v }))} />
                <Field label="Phone" value={editProfile.phone} onChange={v => setEditProfile(p => ({ ...p, phone: v }))} />
                <Field label="Email" type="email" value={editProfile.email} onChange={v => setEditProfile(p => ({ ...p, email: v }))} />
                <Field label="Website" value={editProfile.website} onChange={v => setEditProfile(p => ({ ...p, website: v }))} />
                <div className="col-span-2">
                  <Field label="Tax / NTN Number" value={editProfile.taxNumber} onChange={v => setEditProfile(p => ({ ...p, taxNumber: v }))} />
                </div>
              </div>

              <button type="submit" disabled={editLoading}
                className="w-full bg-indigo-600 hover:bg-indigo-700 disabled:bg-gray-200 text-white py-3 rounded-2xl font-bold flex items-center justify-center gap-2 transition-colors">
                {editLoading ? <Loader2 className="animate-spin" size={16} /> : <Save size={16} />}
                {editLoading ? 'Saving...' : 'Save Changes'}
              </button>
            </form>
          </div>
        </div>
      )}

      {/* ══ DELETE CONFIRMATION MODAL ══ */}
      {deleteTarget && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-3xl w-full max-w-sm shadow-2xl p-6">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-full bg-red-50 flex items-center justify-center shrink-0">
                <Trash2 size={18} className="text-red-500" />
              </div>
              <div>
                <h2 className="font-bold text-gray-900">Delete Company</h2>
                <p className="text-xs text-gray-500">This action cannot be undone</p>
              </div>
            </div>
            <p className="text-sm text-gray-600 mb-6">
              Are you sure you want to delete <strong>{deleteTarget.name}</strong>? All associated data will be permanently removed.
            </p>
            <div className="flex gap-3">
              <button onClick={() => setDeleteTarget(null)}
                className="flex-1 border border-gray-200 text-gray-600 hover:bg-gray-50 py-2.5 rounded-xl font-semibold text-sm transition-colors">
                Cancel
              </button>
              <button onClick={handleDelete} disabled={deleteLoading}
                className="flex-1 bg-red-500 hover:bg-red-600 disabled:bg-gray-200 text-white py-2.5 rounded-xl font-bold text-sm flex items-center justify-center gap-2 transition-colors">
                {deleteLoading ? <Loader2 className="animate-spin" size={14} /> : <Trash2 size={14} />}
                {deleteLoading ? 'Deleting...' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ══ TOAST NOTIFICATIONS ══ */}
      <div className="fixed bottom-6 right-6 z-50 flex flex-col gap-3 pointer-events-none">
        {toasts.map(t => (
          <div key={t.id}
            className={`flex items-center gap-3 px-4 py-3 rounded-2xl shadow-xl text-sm font-semibold pointer-events-auto border ${
              t.type === 'success'
                ? 'bg-white border-emerald-100 text-emerald-700'
                : 'bg-white border-red-100 text-red-600'
            }`}>
            {t.type === 'success'
              ? <CheckCircle2 size={16} className="text-emerald-500 shrink-0" />
              : <AlertCircle  size={16} className="text-red-400 shrink-0" />
            }
            <span>{t.message}</span>
            <button onClick={() => remove(t.id)} className="ml-1 text-gray-300 hover:text-gray-500">
              <X size={14} />
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}