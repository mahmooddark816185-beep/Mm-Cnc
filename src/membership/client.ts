/// <reference types="vite/client" />
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL?.trim() || '';
const key = import.meta.env.VITE_SUPABASE_ANON_KEY?.trim() || '';
export const membershipConfigured = Boolean(url || key);
export const githubAuthEnabled = import.meta.env.VITE_ENABLE_GITHUB_AUTH === 'true';
export const emailAuthEnabled = import.meta.env.VITE_ENABLE_EMAIL_AUTH === 'true';

function isPublicKey(value: string) {
  if (value.startsWith('sb_secret_')) return false;
  if (value.startsWith('sb_publishable_')) return true;
  try {
    const payload = JSON.parse(atob(value.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))) as { role?: string };
    return payload.role === 'anon';
  } catch { return false; }
}

let client: SupabaseClient | null = null;
if (url && key && isPublicKey(key)) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'https:' || (parsed.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(parsed.hostname))) {
      client = createClient(url, key, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'pkce' },
      });
    }
  } catch { /* Configured but invalid must fail closed. */ }
}

export const membershipClient = client;

export function accountRedirectUrl() {
  const redirect = new URL(import.meta.env.BASE_URL, window.location.origin);
  redirect.hash = 'account';
  return redirect.href;
}
