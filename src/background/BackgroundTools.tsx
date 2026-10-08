import { useEffect, useId, useRef, useState } from 'react';
import { Check, Eraser, LoaderCircle, RotateCcw, Sparkles, X } from 'lucide-react';
import { removeBackgroundAi } from './ai';
import { removeSolidBackground } from './colorClient';
import './background.css';

interface BackgroundToolsProps {
  language: 'ar' | 'en';
  source: File | null;
  disabled?: boolean;
  onResult: (blob: Blob | null) => void;
  onBusyChange: (busy: boolean) => void;
}

type Progress = {
  phase: 'download' | 'prepare' | 'process' | 'finish';
  loaded?: number;
  total?: number;
  percent?: number;
};

const translations = {
  ar: {
    title: 'إزالة الخلفية', optional: 'اختيارية',
    description: 'اختر الطريقة ثم اضغط إزالة الخلفية. لن تُعدّل الصورة تلقائيًا.',
    method: 'طريقة إزالة الخلفية', smart: 'فصل ذكي', solid: 'خلفية موحّدة',
    smartDescription: 'لفصل الأشخاص والأجسام عن الخلفيات المعقّدة مع الحفاظ على تفاصيل الحواف.',
    downloadNote: 'عند أول استخدام، يتم تنزيل أدوات الفصل (حوالي 190 ميغابايت). تتم المعالجة على جهازك وتبقى صورتك فيه.',
    solidDescription: 'للرسومات والشعارات ذات الخلفية المتقاربة في اللون.',
    automatic: 'اكتشاف لون الخلفية من الحواف', color: 'لون الخلفية',
    tolerance: 'نطاق الألوان المحذوفة', toleranceHint: 'ارفع القيمة لإزالة درجات أكثر قربًا من لون الخلفية.',
    softness: 'نعومة الحواف',
    contiguous: 'إزالة المناطق المتصلة بالحواف فقط',
    contiguousHint: 'يساعد على الحفاظ على التفاصيل داخل الرسم التي تشبه لون الخلفية.',
    manualNote: 'تُطبّق هذه الإعدادات عند الضغط على الزر فقط.',
    remove: 'إزالة الخلفية', repeat: 'إعادة إزالة الخلفية',
    cancel: 'إلغاء', restore: 'استعادة الأصل', upload: 'أضف صورة لتفعيل هذه الأداة.',
    download: 'تنزيل أدوات الفصل…', prepare: 'تجهيز الصورة…',
    process: 'جارٍ فصل الخلفية…', finish: 'تجهيز الصورة الشفافة…',
    complete: 'أُزيلت الخلفية. يمكنك حفظ الصورة بصيغة PNG مع الشفافية.',
    cancelled: 'أُلغيت العملية. احتُفظ بآخر صورة معروضة.',
    restored: 'استُعيدت الصورة الأصلية.',
    smartError: 'تعذّر الفصل الذكي. تحقّق من الاتصال وتوفّر الذاكرة ثم حاول مجددًا، أو جرّب طريقة الخلفية الموحّدة.',
    downloadError: 'تعذّر تنزيل أدوات الفصل. تحقّق من اتصالك ثم أعد المحاولة، أو استخدم الخلفية الموحّدة دون تنزيل.',
    browserError: 'الفصل الذكي غير متاح في هذا المتصفح. جرّب متصفحًا حديثًا أو استخدم الخلفية الموحّدة.',
    sizeError: 'الصورة كبيرة على أدوات الفصل. جرّب نسخة بأبعاد أصغر.',
    solidError: 'تعذّرت إزالة الخلفية. جرّب لونًا أو نطاقًا مختلفًا، ثم اضغط إزالة الخلفية مجددًا.',
    mb: 'ميغابايت',
  },
  en: {
    title: 'Remove background', optional: 'Optional',
    description: 'Choose a method, then press Remove background. Your image is never changed automatically.',
    method: 'Background removal method', smart: 'Smart cutout', solid: 'Solid background',
    smartDescription: 'Separate people and objects from complex backgrounds while preserving edge detail.',
    downloadNote: 'The first use downloads the cutout tools (about 190 MB). Processing happens on your device and your image stays there.',
    solidDescription: 'For drawings and logos with a background of similar colors.',
    automatic: 'Detect the background color from the edges', color: 'Background color',
    tolerance: 'Color tolerance', toleranceHint: 'Increase to remove a wider range of colors close to the background.',
    softness: 'Edge softness',
    contiguous: 'Only remove areas connected to the edges',
    contiguousHint: 'Helps preserve details inside the drawing that share the background color.',
    manualNote: 'These settings take effect only when you press the button.',
    remove: 'Remove background', repeat: 'Remove background again',
    cancel: 'Cancel', restore: 'Restore original', upload: 'Add an image to use this tool.',
    download: 'Downloading cutout tools…', prepare: 'Preparing the image…',
    process: 'Separating the background…', finish: 'Preparing the transparent image…',
    complete: 'Background removed. Save as PNG to preserve transparency.',
    cancelled: 'Cancelled. The last displayed image has been kept.',
    restored: 'Original image restored.',
    smartError: 'Smart cutout could not finish. Check your connection and available memory, then retry, or try Solid background.',
    downloadError: 'Could not download the cutout tools. Check your connection and retry, or use Solid background without a download.',
    browserError: 'Smart cutout is unavailable in this browser. Try a recent browser or use Solid background.',
    sizeError: 'This image is too large for the cutout tools. Try a copy with smaller dimensions.',
    solidError: 'Background removal could not finish. Try a different color or tolerance, then press Remove background again.',
    mb: 'MB',
  },
} as const;

export function BackgroundTools({ language, source, disabled = false, onResult, onBusyChange }: BackgroundToolsProps) {
  const t = translations[language];
  const labelId = useId();
  const [method, setMethod] = useState<'smart' | 'solid'>('smart');
  const [automaticColor, setAutomaticColor] = useState(true);
  const [color, setColor] = useState('#ffffff');
  const [tolerance, setTolerance] = useState(24);
  const [softness, setSoftness] = useState(16);
  const [contiguous, setContiguous] = useState(true);
  const [busy, setBusy] = useState(false);
  const [hasResult, setHasResult] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [status, setStatus] = useState<'idle' | 'complete' | 'cancelled' | 'restored' | 'smartError' | 'solidError' | 'downloadError' | 'browserError' | 'sizeError'>('idle');
  const running = useRef<AbortController | null>(null);
  const currentSource = useRef(source);
  const callbacks = useRef({ onResult, onBusyChange });
  currentSource.current = source;
  callbacks.current = { onResult, onBusyChange };

  useEffect(() => {
    running.current?.abort();
    running.current = null;
    setBusy(false);
    setHasResult(false);
    setProgress(null);
    setStatus('idle');
    callbacks.current.onBusyChange(false);
    return () => {
      running.current?.abort();
      running.current = null;
      callbacks.current.onBusyChange(false);
    };
  }, [source]);

  function cancel() {
    running.current?.abort();
    running.current = null;
    setBusy(false);
    setProgress(null);
    setStatus('cancelled');
    callbacks.current.onBusyChange(false);
  }

  function restore() {
    if (busy || disabled || !hasResult) return;
    callbacks.current.onResult(null);
    setHasResult(false);
    setProgress(null);
    setStatus('restored');
  }

  async function remove() {
    if (!source || disabled || running.current) return;
    const operation = new AbortController();
    const operationSource = source;
    running.current = operation;
    setBusy(true);
    setStatus('idle');
    setProgress({ phase: method === 'solid' ? 'process' : 'prepare' });
    callbacks.current.onBusyChange(true);
    const isCurrent = () => running.current === operation &&
      currentSource.current === operationSource && !operation.signal.aborted;
    try {
      const output = method === 'smart'
        ? await removeBackgroundAi(operationSource, {
          signal: operation.signal,
          onProgress: (next) => { if (isCurrent()) setProgress(next); },
        })
        : await removeSolidBackground(operationSource, {
          signal: operation.signal,
          color: automaticColor ? undefined : [
            Number.parseInt(color.slice(1, 3), 16),
            Number.parseInt(color.slice(3, 5), 16),
            Number.parseInt(color.slice(5, 7), 16),
          ],
          tolerance,
          softness,
          contiguous,
        });
      if (!isCurrent()) return;
      callbacks.current.onResult(output);
      setHasResult(true);
      setStatus('complete');
    } catch (error) {
      if (isCurrent()) {
        const message = error instanceof Error ? error.message : '';
        if (message.includes('MODEL_DOWNLOAD_FAILED') || message.includes('MODEL_INCOMPLETE')) setStatus('downloadError');
        else if (message.includes('BROWSER_UNSUPPORTED')) setStatus('browserError');
        else if (message.includes('IMAGE_TOO_LARGE')) setStatus('sizeError');
        else setStatus(method === 'smart' ? 'smartError' : 'solidError');
      }
    } finally {
      if (running.current === operation) {
        running.current = null;
        setBusy(false);
        setProgress(null);
        callbacks.current.onBusyChange(false);
      }
    }
  }

  const controlsDisabled = disabled || busy || !source;
  const percent = typeof progress?.percent === 'number' && Number.isFinite(progress.percent)
    ? Math.min(100, Math.max(0, progress.percent)) : undefined;
  const downloadAmount = progress?.phase === 'download' && typeof progress.loaded === 'number'
    ? `${(progress.loaded / 1_000_000).toFixed(1)}${progress.total ? ` / ${(progress.total / 1_000_000).toFixed(1)}` : ''}`
    : null;
  const isError = status.endsWith('Error');

  return (
    <section className="background-tools" aria-labelledby={labelId}>
      <div className="background-heading">
        <Eraser size={17} aria-hidden="true" />
        <h3 id={labelId}>{t.title}</h3>
        <span className="background-optional">{t.optional}</span>
      </div>
      <p className="background-description">{t.description}</p>
      <fieldset className="background-controls" disabled={controlsDisabled}>
        <legend className="visually-hidden">{t.method}</legend>
        <div className="background-methods" role="group" aria-label={t.method}>
          <button type="button" aria-pressed={method === 'smart'} onClick={() => setMethod('smart')}>
            <Sparkles size={15} aria-hidden="true" />{t.smart}
          </button>
          <button type="button" aria-pressed={method === 'solid'} onClick={() => setMethod('solid')}>
            <Eraser size={15} aria-hidden="true" />{t.solid}
          </button>
        </div>
        {method === 'smart' ? (
          <div className="background-method-details">
            <p>{t.smartDescription}</p>
            <p className="background-download-note">{t.downloadNote}</p>
          </div>
        ) : (
          <div className="background-method-details">
            <p>{t.solidDescription}</p>
            <label className="background-check">
              <input type="checkbox" checked={automaticColor} onChange={(event) => setAutomaticColor(event.target.checked)} />
              <span>{t.automatic}</span>
            </label>
            {!automaticColor && (
              <label className="background-color">
                <span>{t.color}</span>
                <input type="color" value={color} onChange={(event) => setColor(event.target.value)} />
              </label>
            )}
            <label className="background-range">
              <span>{t.tolerance}<output>{tolerance}</output></span>
              <input type="range" min="0" max="150" step="1" value={tolerance}
                onChange={(event) => setTolerance(Number(event.target.value))} />
              <small>{t.toleranceHint}</small>
            </label>
            <label className="background-range">
              <span>{t.softness}<output>{softness}</output></span>
              <input type="range" min="0" max="50" step="1" value={softness}
                onChange={(event) => setSoftness(Number(event.target.value))} />
            </label>
            <label className="background-check">
              <input type="checkbox" checked={contiguous} onChange={(event) => setContiguous(event.target.checked)} />
              <span>{t.contiguous}<small>{t.contiguousHint}</small></span>
            </label>
            <p className="background-manual-note">{t.manualNote}</p>
          </div>
        )}
      </fieldset>
      <div className="background-actions">
        {busy ? (
          <button className="background-cancel" type="button" onClick={cancel}>
            <X size={15} aria-hidden="true" />{t.cancel}
          </button>
        ) : (
          <button className="background-apply" type="button" disabled={controlsDisabled} onClick={() => void remove()}>
            <Sparkles size={15} aria-hidden="true" />{hasResult ? t.repeat : t.remove}
          </button>
        )}
        <button className="background-restore" type="button" disabled={disabled || busy || !hasResult} onClick={restore}>
          <RotateCcw size={14} aria-hidden="true" />{t.restore}
        </button>
      </div>
      {!source && <p className="background-upload-hint">{t.upload}</p>}
      <div className="background-status" role="status" aria-live="polite" aria-atomic="true">
        {busy && progress && (
          <>
            <div className="background-progress-label">
              <LoaderCircle className="background-spinner" size={15} aria-hidden="true" />
              <span>{t[progress.phase]}</span>
              {percent !== undefined && <b>{Math.round(percent)}%</b>}
            </div>
            <progress max={100} value={percent} aria-label={t[progress.phase]} />
            {downloadAmount && <small><b dir="ltr">{downloadAmount}</b> {t.mb}</small>}
          </>
        )}
        {!busy && status !== 'idle' && (
          <p className={`background-message${isError ? ' background-error' : ''}`}>
            {status === 'complete' && <Check size={15} aria-hidden="true" />}
            <span>{t[status]}</span>
          </p>
        )}
      </div>
    </section>
  );
}
