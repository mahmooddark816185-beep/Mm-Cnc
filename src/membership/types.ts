export interface AccountState {
  user_id: string;
  used_count: number;
  free_remaining: number;
  expires_at: string | null;
  is_subscribed: boolean;
  is_admin: boolean;
  annual_price_usd: number;
  server_time: string;
}

export interface PaymentClaim {
  id: string;
  status: 'pending' | 'approved' | 'rejected';
  reference: string;
  sender_name: string | null;
  amount_usd: number;
  currency: string;
  created_at: string;
  decided_at: string | null;
  rejection_reason: string | null;
  expires_at: string | null;
}

export interface AdminPaymentClaim extends PaymentClaim { user_id: string; email: string; }

export interface ImageClaim {
  allowed: boolean;
  already_counted: boolean;
  reason: 'trial' | 'subscription' | 'already_counted' | 'quota_exhausted';
  used_count: number;
  free_remaining: number;
  expires_at: string | null;
  is_subscribed: boolean;
  server_time: string;
}
