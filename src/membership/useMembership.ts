import { useCallback, useEffect, useRef, useState } from 'react';
import type { User } from '@supabase/supabase-js';
import { accountRedirectUrl, emailAuthEnabled, githubAuthEnabled, membershipClient as client, membershipConfigured } from './client';
import { membershipCopy, membershipErrorCode, type MembershipError, type MembershipNotice } from './copy';
import type { AccountState, AdminPaymentClaim, ImageClaim, PaymentClaim } from './types';

function validAccount(value: unknown): value is AccountState {
  const data = value as AccountState | null;
  return Boolean(data && typeof data.user_id === 'string' && Number.isInteger(data.used_count) &&
    Number.isInteger(data.free_remaining) && data.free_remaining >= 0 && data.free_remaining <= 10 &&
    typeof data.is_subscribed === 'boolean' && typeof data.is_admin === 'boolean');
}

export function useMembership(language: 'ar' | 'en') {
  const [user, setUser] = useState<User | null>(null);
  const [account, setAccount] = useState<AccountState | null>(null);
  const [payments, setPayments] = useState<PaymentClaim[]>([]);
  const [pendingPayments, setPendingPayments] = useState<AdminPaymentClaim[]>([]);
  const [loading, setLoading] = useState(membershipConfigured);
  const [busy, setBusy] = useState(false);
  const [recoveringPassword, setRecoveringPassword] = useState(false);
  const [errorCode, setErrorCode] = useState<MembershipError | null>(membershipConfigured && !client ? 'config' : null);
  const [noticeCode, setNoticeCode] = useState<MembershipNotice | null>(null);
  const alive = useRef(false);
  const currentUser = useRef<User | null>(null);
  const epoch = useRef(0);
  const refreshSequence = useRef(0);
  const accountRevision = useRef(0);
  const currentAccount = useRef(account);
  currentAccount.current = account;
  const requests = useRef(new Set<AbortController>());
  const hashes = useRef(new WeakMap<Blob, Promise<string>>());
  const claims = useRef(new Map<string, Promise<boolean>>());

  const stillCurrent = useCallback((version: number) => alive.current && version === epoch.current, []);

  const rpc = useCallback(async <T,>(name: string, args: Record<string, unknown> = {}): Promise<T> => {
    if (!client) throw new Error('Account service unavailable');
    const controller = new AbortController();
    requests.current.add(controller);
    const timer = window.setTimeout(() => controller.abort(), 20_000);
    try {
      const { data, error } = await client.rpc(name, args).abortSignal(controller.signal);
      if (error) throw error;
      return data as T;
    } finally {
      window.clearTimeout(timer);
      requests.current.delete(controller);
    }
  }, []);

  const refresh = useCallback(async () => {
    if (!client || !currentUser.current) return;
    const version = epoch.current;
    const sequence = ++refreshSequence.current;
    const snapshotRevision = accountRevision.current;
    const id = currentUser.current.id;
    setLoading(true);
    setErrorCode(null);
    try {
      const state = await rpc<unknown>('get_account_state');
      if (!validAccount(state) || state.user_id !== id) throw new Error('Invalid account response');
      const [history, pending] = await Promise.all([
        rpc<PaymentClaim[]>('list_my_payment_claims'),
        state.is_admin ? rpc<AdminPaymentClaim[]>('admin_list_pending_payments', { p_limit: 50, p_offset: 0 }) : Promise.resolve([]),
      ]);
      if (!Array.isArray(history) || !Array.isArray(pending)) throw new Error('Invalid payment response');
      if (!stillCurrent(version) || sequence !== refreshSequence.current) return;
      // A successful export may have changed the count while payment history loaded.
      if (snapshotRevision === accountRevision.current) setAccount(state);
      setPayments(history);
      setPendingPayments(pending);
    } catch (error) {
      if (!stillCurrent(version) || sequence !== refreshSequence.current) return;
      if (snapshotRevision === accountRevision.current) setAccount(null);
      setPayments([]);
      setPendingPayments([]);
      setErrorCode(membershipErrorCode(error, 'network'));
    } finally {
      if (stillCurrent(version) && sequence === refreshSequence.current) setLoading(false);
    }
  }, [rpc, stillCurrent]);

  useEffect(() => {
    alive.current = true;
    if (!client) { setLoading(false); return () => { alive.current = false; }; }
    let refreshTimer: number | undefined;
    const { data: { subscription } } = client.auth.onAuthStateChange((_event, session) => {
      if (!alive.current) return;
      const next = session?.user ?? null;
      if (_event === 'PASSWORD_RECOVERY' && emailAuthEnabled) setRecoveringPassword(true);
      if (!next) setRecoveringPassword(false);
      const changed = next?.id !== currentUser.current?.id || next?.email_confirmed_at !== currentUser.current?.email_confirmed_at;
      if (changed || _event === 'INITIAL_SESSION' || _event === 'SIGNED_OUT') {
        epoch.current++;
        requests.current.forEach(controller => controller.abort());
        currentUser.current = next;
        setUser(next);
        setAccount(null);
        setPayments([]);
        setPendingPayments([]);
        setErrorCode(null);
        setNoticeCode(null);
        setBusy(false);
        setLoading(Boolean(next));
        window.clearTimeout(refreshTimer);
        // Never await another auth request inside the SDK auth callback.
        if (next) refreshTimer = window.setTimeout(() => { void refresh(); }, 0);
      } else if (next) {
        currentUser.current = next;
        setUser(next);
      }
    });
    return () => {
      alive.current = false;
      epoch.current++;
      window.clearTimeout(refreshTimer);
      requests.current.forEach(controller => controller.abort());
      subscription.unsubscribe();
    };
  }, [refresh]);

  async function authenticate(mode: 'signin' | 'signup', email: string, password: string) {
    if (!client || !emailAuthEnabled) { setErrorCode('config'); return false; }
    setBusy(true);
    setErrorCode(null);
    setNoticeCode(null);
    const version = epoch.current;
    try {
      const result = mode === 'signup'
        ? await client.auth.signUp({ email: email.trim(), password, options: { emailRedirectTo: accountRedirectUrl() } })
        : await client.auth.signInWithPassword({ email: email.trim(), password });
      if (result.error) throw result.error;
      if (!alive.current) return false;
      if (mode === 'signup' && !result.data.session && stillCurrent(version)) setNoticeCode('confirmEmail');
      return true;
    } catch (error) {
      if (stillCurrent(version)) setErrorCode(membershipErrorCode(error, 'auth'));
      return false;
    } finally { if (stillCurrent(version)) setBusy(false); }
  }

  async function signInWithGithub() {
    if (!client || !githubAuthEnabled) return;
    setBusy(true);
    setErrorCode(null);
    const version = epoch.current;
    try {
      const { error } = await client.auth.signInWithOAuth({ provider: 'github', options: { redirectTo: accountRedirectUrl() } });
      if (error) throw error;
    } catch (error) { if (stillCurrent(version)) setErrorCode(membershipErrorCode(error, 'auth')); }
    finally { if (stillCurrent(version)) setBusy(false); }
  }

  async function resetPassword(email: string) {
    if (!client || !emailAuthEnabled) return false;
    const version = epoch.current;
    setBusy(true); setErrorCode(null); setNoticeCode(null);
    try {
      const { error } = await client.auth.resetPasswordForEmail(email.trim(), { redirectTo: accountRedirectUrl() });
      if (error) throw error;
      if (stillCurrent(version)) setNoticeCode('passwordResetSent');
      return true;
    } catch (error) { if (stillCurrent(version)) setErrorCode(membershipErrorCode(error, 'auth')); return false; }
    finally { if (stillCurrent(version)) setBusy(false); }
  }

  async function updatePassword(password: string) {
    if (!client || !emailAuthEnabled || !recoveringPassword) return false;
    const version = epoch.current;
    setBusy(true); setErrorCode(null); setNoticeCode(null);
    try {
      const { error } = await client.auth.updateUser({ password });
      if (error) throw error;
      if (stillCurrent(version)) { setNoticeCode('passwordUpdated'); setRecoveringPassword(false); }
      return true;
    } catch (error) { if (stillCurrent(version)) setErrorCode(membershipErrorCode(error, 'auth')); return false; }
    finally { if (stillCurrent(version)) setBusy(false); }
  }

  async function signOut() {
    if (!client) return;
    setBusy(true);
    setErrorCode(null);
    const version = epoch.current;
    try {
      const { error } = await client.auth.signOut({ scope: 'local' });
      if (error) throw error;
    } catch (error) { if (stillCurrent(version)) setErrorCode(membershipErrorCode(error, 'network')); }
    finally { if (stillCurrent(version)) setBusy(false); }
  }

  const getAuthVersion = useCallback(() => epoch.current, []);

  async function authorizeImage(source: Blob, expectedAuthVersion?: number, isCurrent?: () => boolean): Promise<boolean> {
    if (!membershipConfigured) return true;
    if (isCurrent && !isCurrent()) return false;
    if (!client) { setErrorCode('config'); return false; }
    const version = epoch.current;
    if (expectedAuthVersion !== undefined && expectedAuthVersion !== version) { setErrorCode('accountChanged'); return false; }
    const authenticated = currentUser.current;
    setErrorCode(null);
    setNoticeCode(null);
    if (!authenticated) { setErrorCode('AUTH_REQUIRED'); return false; }
    if (!authenticated.email_confirmed_at) { setErrorCode('EMAIL_NOT_VERIFIED'); return false; }
    let digest: string;
    try {
      let hashing = hashes.current.get(source);
      if (!hashing) {
        hashing = source.arrayBuffer().then(buffer => crypto.subtle.digest('SHA-256', buffer))
          .then(buffer => Array.from(new Uint8Array(buffer), byte => byte.toString(16).padStart(2, '0')).join(''));
        hashes.current.set(source, hashing);
      }
      digest = await hashing;
    } catch {
      if (stillCurrent(version)) setErrorCode('hash');
      hashes.current.delete(source);
      return false;
    }
    if (!stillCurrent(version) || (isCurrent && !isCurrent())) return false;
    const key = `${version}:${authenticated.id}:${digest}`;
    const existing = claims.current.get(key);
    if (existing) return existing;
    const claim = (async () => {
      try {
        const result = await rpc<ImageClaim>('claim_image', { p_sha256: digest });
        if (!stillCurrent(version)) return false;
        if (!result || typeof result.allowed !== 'boolean' || !Number.isInteger(result.used_count) || !Number.isInteger(result.free_remaining)) {
          throw new Error('Invalid image authorization');
        }
        accountRevision.current++;
        setAccount(previous => previous ? { ...previous, used_count: result.used_count, free_remaining: result.free_remaining,
          expires_at: result.expires_at, is_subscribed: result.is_subscribed, server_time: result.server_time } : null);
        if (!currentAccount.current) void refresh();
        if (!result.allowed) setErrorCode('quota');
        return result.allowed === true;
      } catch (error) {
        if (stillCurrent(version)) { setAccount(null); setErrorCode(membershipErrorCode(error, 'network')); }
        return false;
      } finally { claims.current.delete(key); }
    })();
    claims.current.set(key, claim);
    return claim;
  }

  async function submitPayment(reference: string, sender: string) {
    if (!currentUser.current || !client) { setErrorCode('AUTH_REQUIRED'); return false; }
    const version = epoch.current;
    setBusy(true); setErrorCode(null); setNoticeCode(null);
    try {
      await rpc<PaymentClaim>('submit_payment_claim', { p_reference: reference.trim(), p_sender_name: sender.trim() || null });
      if (!stillCurrent(version)) return false;
      await refresh();
      if (!stillCurrent(version)) return false;
      setNoticeCode('paymentSent');
      return true;
    } catch (error) {
      if (stillCurrent(version)) setErrorCode(membershipErrorCode(error, 'payment'));
      return false;
    } finally { if (stillCurrent(version)) setBusy(false); }
  }

  async function reviewPayment(id: string, approve: boolean, verifiedReceipt: boolean, reason = '') {
    if (!account?.is_admin || !currentUser.current) { setErrorCode('ADMIN_REQUIRED'); return false; }
    if (approve && !verifiedReceipt) { setErrorCode('confirmation'); return false; }
    if (!approve && reason.trim().length < 3) { setErrorCode('reason'); return false; }
    const version = epoch.current;
    setBusy(true); setErrorCode(null); setNoticeCode(null);
    try {
      await rpc(approve ? 'admin_approve_payment' : 'admin_reject_payment',
        approve ? { p_payment_id: id } : { p_payment_id: id, p_reason: reason.trim() });
      if (!stillCurrent(version)) return false;
      await refresh();
      if (!stillCurrent(version)) return false;
      setNoticeCode(approve ? 'paymentApproved' : 'paymentRejected');
      return true;
    } catch (error) {
      if (stillCurrent(version)) setErrorCode(membershipErrorCode(error, 'review'));
      return false;
    } finally { if (stillCurrent(version)) setBusy(false); }
  }

  async function loadMorePending() {
    if (!account?.is_admin || busy) return;
    const version = epoch.current;
    setBusy(true);
    try {
      const more = await rpc<AdminPaymentClaim[]>('admin_list_pending_payments', { p_limit: 50, p_offset: pendingPayments.length });
      if (stillCurrent(version) && Array.isArray(more)) {
        setPendingPayments(previous => [...previous, ...more.filter(item => !previous.some(existing => existing.id === item.id))]);
      }
    } catch (error) { if (stillCurrent(version)) setErrorCode(membershipErrorCode(error, 'network')); }
    finally { if (stillCurrent(version)) setBusy(false); }
  }

  return {
    configured: membershipConfigured, emailAuthEnabled, githubAuthEnabled, user, account, payments, pendingPayments, loading, busy, recoveringPassword,
    error: errorCode ? membershipCopy[language].errors[errorCode] : '',
    notice: noticeCode ? membershipCopy[language].notices[noticeCode] : '',
    authenticate, signInWithGithub, signOut, resetPassword, updatePassword, refresh, getAuthVersion, authorizeImage, submitPayment, reviewPayment, loadMorePending,
  };
}

export type Membership = ReturnType<typeof useMembership>;
