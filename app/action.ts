'use server'

import { createClient } from '@supabase/supabase-js'
import { Resend } from 'resend';

// Initialize the Admin Client (God Mode)
const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

/**
 * UPDATED: Sends the generated PDF as an email attachment
 * Now pulls the API key securely from environment variables.
 */
export async function sendEmailWithAttachment(to: string, base64File: string, invNum: string) {
  // Pull from .env.local
  const apiKey = process.env.RESEND_API_KEY;

  if (!apiKey) {
    console.error("ERROR: RESEND_API_KEY is not defined in .env.local");
    return { success: false, error: "Email configuration missing on server." };
  }

  const resend = new Resend(apiKey);

  // Strip the base64 prefix (e.g., "data:application/pdf;base64,")
  const content = base64File.includes(',') ? base64File.split(',')[1] : base64File;

  try {
    const { data, error } = await resend.emails.send({
      // Keep 'onboarding@resend.dev' until you verify your custom domain in Resend
      from: 'POS System <onboarding@resend.dev>',
      to: [to],
      subject: `Your Receipt for Invoice #${invNum}`,
      html: `
        <div style="font-family: sans-serif; line-height: 1.5; color: #333; max-width: 600px; margin: auto; border: 1px solid #eee; padding: 20px; border-radius: 10px;">
          <h2 style="color: #4f46e5;">Thank you for your purchase!</h2>
          <p>Please find your attached receipt for invoice <strong>${invNum}</strong>.</p>
          <div style="background: #f9fafb; padding: 10px; border-radius: 5px; margin: 20px 0;">
            <p style="margin: 0; font-size: 14px;"><strong>Invoice Number:</strong> ${invNum}</p>
            <p style="margin: 0; font-size: 14px;"><strong>Date:</strong> ${new Date().toLocaleDateString()}</p>
          </div>
          <p>If you have any questions, feel free to contact us.</p>
          <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;" />
          <p style="font-size: 12px; color: #999; text-align: center;">Sent via your Indigo POS System</p>
        </div>
      `,
      attachments: [
        {
          filename: `Invoice_${invNum}.pdf`,
          content: content,
        },
      ],
    });

    if (error) {
      console.error("Resend API Error:", error.message);
      return { success: false, error: error.message };
    }

    return { success: true };
  } catch (error: any) {
    console.error("Email Action Error:", error);
    return { success: false, error: "Failed to send email" };
  }
}

/**
 * Gets the user role and company info directly from the profiles table.
 */
export async function getUserRole(userId: string) {
  try {
    const { data, error } = await supabaseAdmin
      .from('profiles')
      .select('role, company_id')
      .eq('id', userId)
      .single();

    if (error) {
      console.error("Action Error:", error.message);
      return { role: null, company_id: null, error: "Profile not found" };
    }
    
    return { role: data?.role, company_id: data?.company_id, error: null };
  } catch (err) {
    return { role: null, error: "Internal Server Error" };
  }
}

/**
 * Creates a new company account or employee and links them via company_id.
 */
export async function adminCreateUser(
  email: string, 
  password: string, 
  companyName: string, 
  role: 'owner' | 'employee' 
) {
  try {
    let companyId: string | null = null;

    if (role === 'owner') {
      const { data: newCompany, error: compError } = await supabaseAdmin
        .from('companies')
        .insert([{ name: companyName, owner_email: email }])
        .select()
        .single();

      if (compError) return { error: `Company creation failed: ${compError.message}` };
      companyId = newCompany.id;
    } else {
      const { data: existingComp, error: findError } = await supabaseAdmin
        .from('companies')
        .select('id')
        .eq('name', companyName)
        .single();

      if (findError || !existingComp) {
        return { error: `Company "${companyName}" not found.` };
      }
      companyId = existingComp.id;
    }

    const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });

    if (authError) return { error: authError.message };
    const userId = authData.user.id;

    const { error: profileError } = await supabaseAdmin
      .from('profiles')
      .insert([
        { 
          id: userId, 
          email: email, 
          company_id: companyId, 
          company_name: companyName, 
          role: role 
        }
      ]);

    if (profileError) {
      await supabaseAdmin.auth.admin.deleteUser(userId);
      return { error: `Profile creation failed: ${profileError.message}` };
    }

    return { success: true, userId: userId };

  } catch (err: any) {
    return { error: "An unexpected error occurred." };
  }
}

/**
 * Force resets a password in the Auth vault.
 */
export async function adminResetPassword(email: string, newPass: string) {
  try {
    const { data: userData, error: findError } = await supabaseAdmin.auth.admin.listUsers();
    if (findError) return { success: false, error: findError.message };

    const user = userData.users.find(u => u.email === email);
    if (!user) return { success: false, error: "User not found" };

    const { error: updateError } = await supabaseAdmin.auth.admin.updateUserById(
      user.id,
      { password: newPass }
    );

    return { success: !updateError, error: updateError?.message };
  } catch (err) {
    return { success: false, error: "Reset failed" };
  }
}

// Add these two functions to your existing app/action.ts file
// They use the service role key so they bypass RLS — only callable server-side





function getAdminClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}

// ─── Delete Company ───────────────────────────────────────────────────────────
// Deletes the company record. Cascade behavior depends on your FK constraints.
// Recommended: add ON DELETE CASCADE to profiles.company_id and products.company_id
// so all related data is cleaned up automatically.

export async function adminDeleteCompany(companyId: string) {
  try {
    const admin = getAdminClient()

    // 1. Nullify company_id on profiles so users aren't orphaned in auth
    await admin.from('profiles').update({ company_id: null }).eq('company_id', companyId)

    // 2. Delete the company
    const { error } = await admin.from('companies').delete().eq('id', companyId)
    if (error) throw error

    return { success: true, error: null }
  } catch (err: any) {
    console.error('adminDeleteCompany error:', err)
    return { success: false, error: err.message ?? 'Delete failed' }
  }
}

// ─── Update Company ───────────────────────────────────────────────────────────

export async function adminUpdateCompany(
  companyId: string,
  updates: {
    name:        string
    address?:    string | null
    city?:       string | null
    phone?:      string | null
    email?:      string | null
    website?:    string | null
    tax_number?: string | null
    tagline?:    string | null
    logo_base64?:string | null
  }
) {
  try {
    const admin = getAdminClient()

    const { data, error } = await admin
      .from('companies')
      .update(updates)
      .eq('id', companyId)
      .select('id, name, email, city, phone, address, website, tax_number, tagline, logo_base64, created_at')
      .single()

    if (error) throw error

    return { success: true, data, error: null }
  } catch (err: any) {
    console.error('adminUpdateCompany error:', err)
    return { success: false, data: null, error: err.message ?? 'Update failed' }
  }
}