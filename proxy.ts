import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

// ─── Role → allowed path prefixes ─────────────────────────────────────────────
// Add new roles here — nowhere else needs changing.
const ROLE_ROUTES: Record<string, string[]> = {
  super_admin: ['/admin', '/dashboard'],
  owner:       ['/dashboard/owner/ownerDashboard','/dashboard/employee/inventory','/dashboard/owner/businessInsight','/dashboard/owner/report'],
  employee:    ['/dashboard/employee/invoice','/dashboard/employee/inventory'],
}

// Routes that require authentication (any valid role)
const PROTECTED_PREFIXES = ['/dashboard', '/admin']

// ─── Helpers ──────────────────────────────────────────────────────────────────

function redirect(request: NextRequest, response: NextResponse, path: string) {
  const url = request.nextUrl.clone()
  url.pathname = path
  const redirectResponse = NextResponse.redirect(url)
  // Carry over any updated auth cookies from the supabase client
  response.cookies.getAll().forEach(c => redirectResponse.cookies.set(c.name, c.value))
  return redirectResponse
}

function isAllowed(role: string, pathname: string): boolean {
  const allowed = ROLE_ROUTES[role]
  if (!allowed) return false
  return allowed.some(prefix => pathname.startsWith(prefix))
}

// ─── Middleware ───────────────────────────────────────────────────────────────

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl

  // 1. Skip static assets immediately — no auth needed
  if (
    pathname.startsWith('/_next') ||
    pathname.startsWith('/api') ||
    pathname.includes('.') ||
    request.headers.has('x-nextjs-data') ||
    request.headers.get('accept')?.includes('text/x-component')
  ) {
    return NextResponse.next()
  }

  // 2. Build Supabase SSR client — this also refreshes the session cookie if needed
  let response = NextResponse.next({ request: { headers: request.headers } })

  const supabaseClient = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll()            { return request.cookies.getAll() },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value))
          response = NextResponse.next({ request })
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options)
          )
        },
      },
    }
  )

  // 3. Verify session — getUser() validates the JWT server-side (more secure than getSession)
  //    Bug fix: removed the forged-cookie bypass. If there's no valid JWT, user is not authenticated.
  const { data: { user }, error: userError } = await supabaseClient.auth.getUser()

  const isProtected = PROTECTED_PREFIXES.some(p => pathname.startsWith(p))
  const isLoginPage = pathname === '/login'

  // 4. Not authenticated → guard protected routes
  if (!user || userError) {
    if (isProtected) return redirect(request, response, '/login')
    return response  // allow public pages
  }

  // 5. Authenticated — fetch role from profiles table
  //    Bug fix: removed createClient(SERVICE_ROLE_KEY) on every request.
  //    The anon client + RLS is sufficient here since users can only read their own profile.
  let role: string | null = null

  try {
    const { data: profile } = await supabaseClient
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .single()

    role = profile?.role ?? null
  } catch {
    // DB unreachable (network issue) — fail closed: don't grant access
    // This is intentionally strict. A POS terminal that can't verify role
    // should not be trusted to access dashboards.
    if (isProtected) return redirect(request, response, '/login')
    return response
  }

  if (!role) {
    // Authenticated user with no role assigned — send to login
    if (isProtected) return redirect(request, response, '/login')
    return response
  }

  // 6. Role-based route enforcement
  //    Bug fix: ALL dashboard routes are now checked, not just /dashboard/employee.
  //    Bug fix: removed 'offline_verified' bypass — role must be a real role.
  if (isProtected && !isAllowed(role, pathname)) {
    // User is logged in but accessing a route their role doesn't permit
    // Redirect to their own dashboard instead of login
    const ownRoutes = ROLE_ROUTES[role]
    const fallback  = ownRoutes?.[0] ?? '/login'
    return redirect(request, response, fallback)
  }

  // 7. Already logged in — don't show login page again
  if (isLoginPage) {
    const ownRoutes = ROLE_ROUTES[role]
    const home      = ownRoutes?.[0] ?? '/dashboard/employee'
    return redirect(request, response, home)
  }

  return response
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)'],
}