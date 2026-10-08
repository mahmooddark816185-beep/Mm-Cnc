import { useEffect, useState, type FormEvent } from 'react';
import { Check, Clock3, CreditCard, Github, LogOut, RefreshCw, ShieldCheck, UserRound } from 'lucide-react';
import { membershipCopy } from './copy';
import type { Membership } from './useMembership';
import type { AdminPaymentClaim } from './types';
import './membership.css';

type Language = 'ar' | 'en';

function showDate(value: string | null, language: Language) {
  if (!value) return '—';
  const date = new Date(value);
  if (!Number.isFinite(date.valueOf())) return '—';
  return new Intl.DateTimeFormat(language === 'ar' ? 'ar-SY' : 'en-GB', { year: 'numeric', month: 'short', day: 'numeric' }).format(date);
}

function AdminReview({ payment, language, membership }: { payment: AdminPaymentClaim; language: Language; membership: Membership }) {
  const t = membershipCopy[language];
  const [verified, setVerified] = useState(false);
  const [reason, setReason] = useState('');
  return (
    <article className="membership-review">
      <div className="membership-review-header"><strong dir="ltr">{payment.email}</strong><span>{showDate(payment.created_at, language)}</span></div>
      <dl className="membership-payment-details">
        <div><dt>{t.reference}</dt><dd dir="auto">{payment.reference}</dd></div>
        {payment.sender_name && <div><dt>{t.sender}</dt><dd dir="auto">{payment.sender_name}</dd></div>}
      </dl>
      <label className="membership-received"><input type="checkbox" checked={verified} disabled={membership.busy}
        onChange={event => setVerified(event.target.checked)} /><span>{t.received}</span></label>
      <button type="button" className="membership-primary" disabled={membership.busy || !verified}
        onClick={() => void membership.reviewPayment(payment.id, true, verified)}><Check size={16} aria-hidden="true" />{t.approve}</button>
      <div className="membership-reject-row">
        <label><span>{t.rejectReason}</span><input type="text" value={reason} maxLength={500} minLength={3}
          disabled={membership.busy} onChange={event => setReason(event.target.value)} /></label>
        <button type="button" className="membership-reject" disabled={membership.busy || reason.trim().length < 3}
          onClick={() => void membership.reviewPayment(payment.id, false, false, reason)}>{t.reject}</button>
      </div>
    </article>
  );
}

export function MembershipPanel({ language, membership }: { language: Language; membership: Membership }) {
  const t = membershipCopy[language];
  const [mode, setMode] = useState<'signin' | 'signup' | 'reset'>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [sender, setSender] = useState('');
  const [reference, setReference] = useState('');
  const qrUrl = `${import.meta.env.BASE_URL}sham-cash-payment.jpg`;
  const pending = membership.payments.some(payment => payment.status === 'pending');
  const disabled = membership.busy || membership.loading;
  useEffect(() => { setPassword(''); setSender(''); setReference(''); }, [membership.user?.id]);
  if (!membership.configured) return null;

  async function handleAuthentication(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (membership.recoveringPassword) {
      if (await membership.updatePassword(password)) setPassword('');
    } else if (mode === 'reset') await membership.resetPassword(email);
    else if (await membership.authenticate(mode, email, password)) setPassword('');
  }

  async function handlePayment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (await membership.submitPayment(reference, sender)) { setSender(''); setReference(''); }
  }

  return (
    <section id="account" className="membership-panel" aria-labelledby="membership-title" tabIndex={-1}>
      <div className="membership-title-row">
        <div><div className="membership-eyebrow"><UserRound size={16} aria-hidden="true" />{t.eyebrow}</div>
          <h2 id="membership-title">{t.title}</h2><p>{membership.user || membership.emailAuthEnabled || membership.githubAuthEnabled ? t.description : t.authUnavailable}</p></div>
        {membership.user && <button type="button" className="membership-secondary" disabled={disabled} onClick={() => void membership.signOut()}>
          <LogOut size={15} aria-hidden="true" />{t.signOut}</button>}
      </div>
      {membership.error && <p className="membership-alert" role="alert">{membership.error}</p>}
      {membership.notice && <p className="membership-notice" role="status">{membership.notice}</p>}
      {membership.loading && <p className="membership-loading" role="status">{t.loading}</p>}
      {(!membership.user || membership.recoveringPassword) ? (
        <div className="membership-auth">
          {membership.emailAuthEnabled && <>
          {!membership.recoveringPassword &&
          <div className="membership-auth-tabs" role="group" aria-label={t.signedIn}>
            <button type="button" aria-pressed={mode === 'signin'} disabled={disabled} onClick={() => setMode('signin')}>{t.signIn}</button>
            <button type="button" aria-pressed={mode === 'signup'} disabled={disabled} onClick={() => setMode('signup')}>{t.signUp}</button>
          </div>}
          <form onSubmit={event => void handleAuthentication(event)}>
            <fieldset disabled={disabled}>
              {!membership.recoveringPassword &&
              <label><span>{t.email}</span><input type="email" autoComplete="email" required maxLength={254} dir="ltr"
                value={email} onChange={event => setEmail(event.target.value)} /></label>}
              {(mode !== 'reset' || membership.recoveringPassword) &&
              <label><span>{membership.recoveringPassword ? t.newPassword : t.password}</span><input type="password" autoComplete={mode === 'signup' || membership.recoveringPassword ? 'new-password' : 'current-password'}
                required minLength={mode === 'signup' || membership.recoveringPassword ? 8 : 1} maxLength={128} value={password} onChange={event => setPassword(event.target.value)} />
                {(mode === 'signup' || membership.recoveringPassword) && <small>{t.passwordHint}</small>}</label>}
              {mode === 'signup' && <p className="membership-help">{t.verifyHint}</p>}
              <button className="membership-primary" type="submit">{membership.busy ? t.working : membership.recoveringPassword ? t.savePassword : mode === 'reset' ? t.resetPassword : mode === 'signin' ? t.signIn : t.signUp}</button>
            </fieldset>
          </form>
          {mode === 'signin' && !membership.recoveringPassword && <button className="membership-forgot" type="button" disabled={disabled} onClick={() => setMode('reset')}>{t.forgotPassword}</button>}
          </>}
          {membership.githubAuthEnabled && <button type="button" className="membership-github" disabled={disabled}
            onClick={() => void membership.signInWithGithub()}><Github size={17} aria-hidden="true" />{t.github}</button>}
        </div>
      ) : (
        <>
          <div className="membership-account-header"><span dir="ltr">{membership.user.email}</span>
            <button type="button" className="membership-secondary" disabled={disabled} onClick={() => void membership.refresh()}>
              <RefreshCw size={15} aria-hidden="true" />{t.refresh}</button></div>
          {membership.account && (
            <>
              <div className="membership-stats">
                <div><span>{membership.account.is_subscribed ? t.planRemaining : t.remaining}</span>
                  <strong className={membership.account.is_subscribed ? 'membership-unlimited' : undefined}>{membership.account.is_subscribed ? t.unlimited : membership.account.free_remaining}</strong></div>
                <div><span>{t.used}</span><strong>{membership.account.used_count}</strong></div>
                <div className="membership-plan"><span className={membership.account.is_subscribed ? 'membership-active' : ''}>
                  {membership.account.is_subscribed ? <ShieldCheck size={16} aria-hidden="true" /> : <Clock3 size={16} aria-hidden="true" />}
                  {membership.account.is_subscribed ? t.active : membership.account.expires_at ? t.expired : membership.account.free_remaining > 0 ? t.trial : t.empty}
                </span>{membership.account.expires_at && <small>{t.expires} {showDate(membership.account.expires_at, language)}</small>}</div>
              </div>
              <p className="membership-help">{t.countedOnce}</p>
              <div className="membership-payment-grid">
                <div className="membership-payment-info">
                  <div className="membership-payment-heading"><CreditCard size={19} aria-hidden="true" /><h3>{t.subscription}</h3></div>
                  <strong className="membership-price">{t.price}</strong>
                  <p>{t.paymentInstructions}</p>
                  <a className="membership-qr" href={qrUrl} target="_blank" rel="noopener noreferrer" aria-label={t.openQr}>
                    <img src={qrUrl} alt={t.qrAlt} loading="lazy" />
                  </a>
                  <p>{t.calendarYear}</p>
                </div>
                <div className="membership-payment-form">
                  <p className="membership-approval-note">{t.manualApproval}</p>
                  {pending ? <p className="membership-notice"><Clock3 size={16} aria-hidden="true" />{t.pendingHint}</p> : (
                    <form onSubmit={event => void handlePayment(event)}>
                      <fieldset disabled={disabled}>
                        <label><span>{t.sender}</span><input type="text" value={sender} maxLength={120} autoComplete="name"
                          onChange={event => setSender(event.target.value)} /></label>
                        <label><span>{t.reference}</span><input type="text" value={reference} minLength={3} maxLength={128} required dir="auto"
                          onChange={event => setReference(event.target.value)} /></label>
                        <button type="submit" className="membership-primary">{membership.busy ? t.working : t.submitPayment}</button>
                      </fieldset>
                    </form>
                  )}
                  <h3 className="membership-history-title">{t.history}</h3>
                  {!membership.payments.length && <p className="membership-help">{t.noHistory}</p>}
                  <ul className="membership-history">
                    {membership.payments.map(payment => (
                      <li key={payment.id}>
                        <div><strong dir="auto">{payment.reference}</strong><span className={`membership-badge membership-badge-${payment.status}`}>{t[payment.status]}</span></div>
                        <small>{t.date}: {showDate(payment.created_at, language)}</small>
                        {payment.status === 'approved' && payment.expires_at && <small>{t.expires}: {showDate(payment.expires_at, language)}</small>}
                        {payment.status === 'rejected' && payment.rejection_reason && <p>{t.rejection}: {payment.rejection_reason}</p>}
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
              {membership.account.is_admin && <div className="membership-admin">
                <h3><ShieldCheck size={18} aria-hidden="true" />{t.adminTitle}</h3><p className="membership-help">{t.adminHint}</p>
                {!membership.pendingPayments.length && <p>{t.adminEmpty}</p>}
                {membership.pendingPayments.map(payment => <AdminReview key={payment.id} payment={payment} language={language} membership={membership} />)}
                {membership.pendingPayments.length >= 50 && membership.pendingPayments.length % 50 === 0 && <button type="button"
                  className="membership-secondary" disabled={disabled} onClick={() => void membership.loadMorePending()}>{t.loadMore}</button>}
              </div>}
            </>
          )}
        </>
      )}
      <p className="membership-privacy">{t.privacy}</p>
    </section>
  );
}
