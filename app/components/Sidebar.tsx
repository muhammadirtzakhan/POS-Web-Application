'use client'

import { Box, FileText, LogOut } from 'lucide-react'
import { useRouter, usePathname } from 'next/navigation'
import { supabase } from '@/lib/supabase'

export default function Sidebar() {
  const router = useRouter()
  const pathname = usePathname()

  const menuItems = [
    { name: 'Inventory Management', icon: <Box size={20} />, path: '/dashboard/employee/inventory' },
    { name: 'Create Invoice', icon: <FileText size={20} />, path: '/dashboard/employee/invoice' },
  ]

  const handleLogout = async () => {
    await supabase.auth.signOut()
    router.push('/login')
  }

  return (
    <div className="w-64 h-screen bg-white border-r border-gray-100 flex flex-col p-6 sticky top-0">
      <div className="mb-10">
        <h1 className="text-2xl font-black text-indigo-600">Billing System</h1>
      </div>

      <nav className="flex-1 space-y-2">
        {menuItems.map((item) => (
          <button
            key={item.path}
            onClick={() => router.push(item.path)}
            className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl font-medium transition-all ${
              pathname === item.path 
                ? 'bg-indigo-50 text-indigo-600' 
                : 'text-gray-500 hover:bg-gray-50'
            }`}
          >
            {item.icon}
            {item.name}
          </button>
        ))}
      </nav>

      <button 
        onClick={handleLogout}
        className="flex items-center gap-3 px-4 py-3 text-red-500 font-medium hover:bg-red-50 rounded-xl transition-all"
      >
        <LogOut size={20} />
        Logout
      </button>
    </div>
  )
}