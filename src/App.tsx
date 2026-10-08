import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, DragEvent } from 'react';
import {
  ArrowDownRight, ArrowUpRight, Check, Crosshair, Download, FileImage,
  FileText, Layers3, MessageCircle, MoveUpRight, ScanLine, Settings2,
  ShieldCheck, SlidersHorizontal, UploadCloud,
} from 'lucide-react';
import { copy, type Language } from './i18n';
import {
  exportDxf, exportGcode, exportSvg, vectorizeImageData,
  type ImageDataLike, type VectorResult,
} from './engine';
import { exportBinaryMaskToStl } from './engine/stl';
import { assertSafeImageDimensions, probeImageDimensions } from './imageProbe';

const PHONE_DISPLAY = '00963981512543';
const WHATSAPP_URL = 'https://wa.me/963981512543';
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const SUPPORTED_IMAGE = /\.(png|jpe?g|webp|bmp)$/i;
type ExportFormat = 'dxf' | 'svg' | 'stl' | 'gcode';

function getInitialLanguage(): Language {
  try {
    return window.localStorage.getItem('mm-cnc-language') === 'en' ? 'en' : 'ar';
  } catch {
    return 'ar';
  }
}

function saveBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

function NumberField({ label, value, onChange, min, max, step = 1, suffix }: {
  label: string; value: number; onChange: (next: number) => void;
  min: number; max: number; step?: number; suffix?: string;
}) {
  return (
    <label className="number-field">
      <span>{label}</span>
      <span className="number-input-wrap">
        <input type="number" min={min} max={max} step={step} value={value}
          onChange={(event) => onChange(Number(event.target.value))} />
        {suffix && <em>{suffix}</em>}
      </span>
    </label>
  );
}

function DemoArtwork({ language }: { language: Language }) {
  const t = copy[language];
  return (
    <svg viewBox="0 0 540 348" fill="none" aria-hidden="true" className="demo-artwork">
      <defs>
        <pattern id="blueprintGrid" width="24" height="24" patternUnits="userSpaceOnUse">
          <path d="M 24 0 L 0 0 0 24" stroke="#d4e0e1" strokeWidth="1" />
        </pattern>
        <pattern id="fineHatch" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="8" stroke="#9ec8c6" strokeWidth="2" />
        </pattern>
      </defs>
      <rect width="540" height="348" fill="#eef4f3" />
      <rect width="540" height="348" fill="url(#blueprintGrid)" />
      <path d="M124 91 H362 Q380 91 380 109 V142 H426 V206 H380 V239 Q380 257 362 257 H124 Q106 257 106 239 V109 Q106 91 124 91 Z" fill="url(#fineHatch)" stroke="#2d7f80" strokeWidth="3" />
      <circle cx="166" cy="174" r="25" fill="#eef4f3" stroke="#2d7f80" strokeWidth="3" />
      <circle cx="316" cy="174" r="25" fill="#eef4f3" stroke="#2d7f80" strokeWidth="3" />
      <path d="M82 76 H397 M82 270 H397" stroke="#718e92" strokeDasharray="4 5" />
      <path d="M106 283 V300 M380 283 V300 M106 292 H380" stroke="#486e73" strokeWidth="1.5" />
      <path d="m106 292 9-5 v10 z M380 292 l-9-5 v10 z" fill="#486e73" />
      <text x="233" y="318" fill="#41676c" fontFamily="Space Grotesk, sans-serif" fontSize="12" letterSpacing="1">120.00 MM</text>
      <circle cx="380" cy="174" r="6" fill="#ec744c" />
      <path d="M386 174 H458 V138" stroke="#ec744c" strokeWidth="1.5" />
      <rect x="425" y="105" width="94" height="34" rx="3" fill="#173d45" />
      <text x="472" y="127" textAnchor="middle" fill="white" fontFamily="IBM Plex Sans Arabic, Space Grotesk, sans-serif" fontSize="10">{t.demoPath}</text>
      <path d="M107 258 V282 H83" stroke="#ec744c" strokeWidth="1.5" />
      <rect x="23" y="279" width="79" height="28" rx="3" fill="#ec744c" />
      <text x="62" y="297" textAnchor="middle" fill="white" fontFamily="IBM Plex Sans Arabic, Space Grotesk, sans-serif" fontSize="9">{t.demoOrigin}</text>
    </svg>
  );
}

export default function App() {
  const [language, setLanguage] = useState<Language>(getInitialLanguage);
  const t = copy[language];
  const inputRef = useRef<HTMLInputElement>(null);
  const fileSelectionId = useRef(0);
  const [source, setSource] = useState<File | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [imageData, setImageData] = useState<ImageDataLike | null>(null);
  const [vectorUrl, setVectorUrl] = useState<string | null>(null);
  const [fileError, setFileError] = useState('');
  const [exportError, setExportError] = useState('');
  const [isDragging, setIsDragging] = useState(false);
  const [busyFormat, setBusyFormat] = useState<ExportFormat | null>(null);
  const [threshold, setThreshold] = useState(128);
  const [invert, setInvert] = useState(false);
  const [resolution, setResolution] = useState(320);
  const [noise, setNoise] = useState(3);
  const [smooth, setSmooth] = useState(0.75);
  const [widthMm, setWidthMm] = useState(120);
  const [thicknessMm, setThicknessMm] = useState(3);
  const [safeZ, setSafeZ] = useState(5);
  const [cutDepth, setCutDepth] = useState(1);
  const [feedRate, setFeedRate] = useState(300);
  const [plungeRate, setPlungeRate] = useState(100);
  const [spindleRpm, setSpindleRpm] = useState(10000);
  const [machineReviewed, setMachineReviewed] = useState(false);
  const [compare, setCompare] = useState(50);

  useEffect(() => {
    document.documentElement.lang = language;
    document.documentElement.dir = language === 'ar' ? 'rtl' : 'ltr';
    try { window.localStorage.setItem('mm-cnc-language', language); } catch { /* private mode */ }
  }, [language]);

  useEffect(() => {
    if (!source) {
      setImageData(null);
      setImageUrl(null);
      return;
    }
    let cancelled = false;
    const url = URL.createObjectURL(source);
    const image = new Image();
    setImageData(null);
    setImageUrl(null);
    setFileError('');
    image.onload = () => {
      if (cancelled) return;
      try {
        if (!image.naturalWidth || !image.naturalHeight ||
          image.naturalWidth > 20_000 || image.naturalHeight > 20_000 ||
          image.naturalWidth * image.naturalHeight > 16_000_000) {
          throw new Error('Invalid image dimensions');
        }
        const shortest = Math.min(image.naturalWidth, image.naturalHeight);
        let scale = Math.min(1, resolution / Math.max(image.naturalWidth, image.naturalHeight));
        if (shortest > 1 && shortest * scale < 8) scale = Math.min(1, 8 / shortest);
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
        const context = canvas.getContext('2d', { willReadFrequently: true });
        if (!context) throw new Error('Canvas unavailable');
        context.imageSmoothingEnabled = true;
        context.imageSmoothingQuality = 'high';
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        setImageData(context.getImageData(0, 0, canvas.width, canvas.height));
        setImageUrl(canvas.toDataURL('image/png'));
      } catch {
        setFileError(t.decodeError);
      }
    };
    image.onerror = () => { if (!cancelled) setFileError(t.decodeError); };
    image.src = url;
    return () => {
      cancelled = true;
      URL.revokeObjectURL(url);
    };
  }, [source, resolution, t.decodeError]);

  const processed = useMemo<{ result: VectorResult | null; error: boolean }>(() => {
    if (!imageData) return { result: null, error: false };
    try {
      return {
        result: vectorizeImageData(imageData, {
          threshold, invert, minArea: noise, simplifyTolerance: smooth,
        }),
        error: false,
      };
    } catch {
      return { result: null, error: true };
    }
  }, [imageData, threshold, invert, noise, smooth]);
  const result = processed.result;

  useEffect(() => {
    if (!result) { setVectorUrl(null); return; }
    const svg = exportSvg(result, { stroke: '#1d6973', strokeWidth: 1.25 });
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
    setVectorUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [result]);

  const mmPerPixel = result ? widthMm / result.width : 1;
  const heightMm = result && Number.isFinite(mmPerPixel) ? result.height * mmPerPixel : 0;
  const canExport = Boolean(result && result.contours.length > 0 && !busyFormat);

  async function acceptFile(file?: File): Promise<void> {
    if (!file) return;
    const selectionId = ++fileSelectionId.current;
    if (!SUPPORTED_IMAGE.test(file.name)) { setFileError(t.unsupported); return; }
    if (file.size > MAX_FILE_BYTES) { setFileError(t.fileTooLarge); return; }
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      assertSafeImageDimensions(probeImageDimensions(bytes));
    } catch (error) {
      if (fileSelectionId.current === selectionId) {
        setFileError(error instanceof RangeError ? t.imageTooLarge : t.decodeError);
      }
      return;
    }
    if (fileSelectionId.current !== selectionId) return;
    setFileError('');
    setExportError('');
    setSource(file);
  }

  function handleChoose(event: ChangeEvent<HTMLInputElement>): void {
    void acceptFile(event.target.files?.[0]);
    event.target.value = '';
  }

  function handleDrop(event: DragEvent<HTMLElement>): void {
    event.preventDefault();
    setIsDragging(false);
    void acceptFile(event.dataTransfer.files?.[0]);
  }

  function makeSample(): void {
    const canvas = document.createElement('canvas');
    canvas.width = 520;
    canvas.height = 360;
    const context = canvas.getContext('2d');
    if (!context) return;
    context.fillStyle = '#fff';
    context.fillRect(0, 0, 520, 360);
    context.fillStyle = '#16343c';
    context.beginPath();
    context.roundRect(70, 45, 380, 270, 35);
    context.fill();
    context.fillStyle = '#fff';
    context.fillRect(375, 132, 95, 96);
    for (const x of [155, 280]) {
      context.beginPath();
      context.arc(x, 180, 28, 0, Math.PI * 2);
      context.fill();
    }
    canvas.toBlob((blob) => {
      if (blob) void acceptFile(new File([blob], 'mm-cnc-sample.png', { type: 'image/png' }));
    }, 'image/png');
    document.getElementById('studio')?.scrollIntoView({ behavior: 'smooth' });
  }

  async function download(format: ExportFormat): Promise<void> {
    if (!result || !canExport) return;
    setExportError('');
    if (!Number.isFinite(mmPerPixel) || mmPerPixel <= 0 || widthMm > 3000 ||
      (format === 'stl' && (!Number.isFinite(thicknessMm) || thicknessMm <= 0))) {
      setExportError(t.invalidDimensions);
      return;
    }
    if (format === 'gcode' && !machineReviewed) { setExportError(t.gcodeReview); return; }
    setBusyFormat(format);
    await new Promise<void>((resolve) => window.setTimeout(resolve, 20));
    try {
      const basename = (source?.name || 'drawing').replace(/\.[^.]+$/, '')
        .replace(/[^\p{L}\p{N}._-]+/gu, '-').slice(0, 60) || 'drawing';
      if (format === 'dxf') {
        saveBlob(new Blob([exportDxf(result, { mmPerPixel })], { type: 'application/dxf' }), `${basename}.dxf`);
      } else if (format === 'svg') {
        saveBlob(new Blob([exportSvg(result, { scale: mmPerPixel, unit: 'mm' })], { type: 'image/svg+xml' }), `${basename}.svg`);
      } else if (format === 'stl') {
        const bytes = exportBinaryMaskToStl(result.mask, result.width, result.height,
          { pixelSizeMm: mmPerPixel, thicknessMm });
        saveBlob(new Blob([new Uint8Array(bytes)], { type: 'model/stl' }), `${basename}.stl`);
      } else {
        const program = exportGcode(result, {
          mmPerPixel, safeZ, cutZ: -cutDepth, feedRate, plungeRate, spindleRpm,
        });
        saveBlob(new Blob([program], { type: 'text/plain' }), `${basename}.nc`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      setExportError(format === 'stl' && /exceed|large|limit|triangle/i.test(message)
        ? t.stlTooLarge : t.exportError);
    } finally {
      setBusyFormat(null);
    }
  }

  const formats = [
    { key: 'dxf' as const, icon: <Crosshair size={22} strokeWidth={1.7} />, title: t.dxfTitle, body: t.dxfBody, tag: 'CAD' },
    { key: 'svg' as const, icon: <ScanLine size={22} strokeWidth={1.7} />, title: t.svgTitle, body: t.svgBody, tag: 'VECTOR' },
    { key: 'stl' as const, icon: <Layers3 size={22} strokeWidth={1.7} />, title: t.stlTitle, body: t.stlBody, tag: '3D MESH' },
    { key: 'gcode' as const, icon: <Settings2 size={22} strokeWidth={1.7} />, title: t.gcodeTitle, body: t.gcodeBody, tag: 'CNC' },
  ];

  return (
    <div className="site-shell">
      <header className="site-header">
        <a className="brand" href="#top" aria-label="Mm Cnc">
          <span className="brand-mark"><span /><span /><span /><span /></span>
          <span className="brand-name">Mm <strong>Cnc</strong><small>IMAGE → GEOMETRY</small></span>
        </a>
        <nav className="top-nav" aria-label={language === 'ar' ? 'القائمة الرئيسية' : 'Main navigation'}>
          <a href="#studio">{t.navStudio}</a>
          <a href="#formats">{t.navFormats}</a>
          <a href="#how">{t.navHow}</a>
        </nav>
        <div className="header-actions">
          <button className="language-switch" type="button" onClick={() => setLanguage(language === 'ar' ? 'en' : 'ar')}
            aria-label={language === 'ar' ? 'Switch to English' : 'التبديل إلى العربية'}>
            <span className={language === 'ar' ? 'active' : ''}>ع</span><i />
            <span className={language === 'en' ? 'active' : ''}>EN</span>
          </button>
          <a className="header-contact" href={WHATSAPP_URL} target="_blank" rel="noopener noreferrer">
            <MessageCircle size={17} /><span>{t.contact}</span><ArrowUpRight size={16} />
          </a>
        </div>
      </header>

      <main id="top">
        <section className="hero section-pad">
          <div className="hero-copy">
            <div className="eyebrow"><span className="eyebrow-line" />{t.heroEyebrow}</div>
            <h1><span>{t.heroTitleA}</span><br /><em>{t.heroTitleB}</em></h1>
            <p>{t.heroBody}</p>
            <div className="hero-ctas">
              <a className="primary-button" href="#studio"><span>{t.start}</span><ArrowDownRight size={20} /></a>
              <button className="text-button" type="button" onClick={makeSample}>{t.trySample}<ArrowUpRight size={17} /></button>
            </div>
            <div className="hero-flow">
              <span>{t.signalOne}</span><i /><span>{t.signalTwo}</span><i /><span>{t.signalThree}</span>
            </div>
          </div>
          <div className="hero-visual">
            <div className="visual-topline"><span className="visual-signal"><span />{t.liveWorkspace}</span><span>MM / 001</span></div>
            <div className="visual-heading"><span>{t.heroCardEyebrow}</span><Crosshair size={19} /></div>
            <div className="demo-stage"><DemoArtwork language={language} /><span className="demo-axis demo-axis-x">X</span><span className="demo-axis demo-axis-y">Y</span></div>
            <div className="visual-foot"><span><span className="status-dot" />{t.heroCardLabel}</span><span>DXF&nbsp; / &nbsp;STL&nbsp; / &nbsp;GCODE</span></div>
            <div className="visual-note">{t.heroCardFoot}</div>
          </div>
        </section>

        <div className="ticker" aria-hidden="true"><span>{t.tickerRaster}</span><i /><span>{t.tickerVector}</span><i /><span>{t.tickerScale}</span><i /><span>{t.tickerCad}</span><i /><span>MM CNC</span></div>

        <section className="studio section-pad" id="studio">
          <div className="section-heading">
            <div><div className="eyebrow"><span className="eyebrow-line" />{t.studioEyebrow}</div><h2>{t.studioTitle}</h2><p>{t.studioBody}</p></div>
            <div className="local-badge"><ShieldCheck size={18} />{t.localBadge}</div>
          </div>
          <div className="studio-grid">
            <div className="settings-panel">
              <div className="panel-head"><span className="panel-index">{t.inputPanel}</span><span className="panel-head-icon"><FileImage size={18} /></span></div>
              <div className={`upload-zone${isDragging ? ' drag-active' : ''}`} onDragOver={(event) => { event.preventDefault(); setIsDragging(true); }} onDragLeave={() => setIsDragging(false)} onDrop={handleDrop}>
                <input ref={inputRef} type="file" accept=".png,.jpg,.jpeg,.webp,.bmp,image/png,image/jpeg,image/webp,image/bmp" onChange={handleChoose} className="visually-hidden" aria-label={t.browse} />
                <div className="upload-icon"><UploadCloud size={28} strokeWidth={1.5} /></div>
                <strong>{source ? t.selected : t.dropTitle}</strong>
                <span className={source ? 'filename' : 'muted'}>{source ? source.name : t.dropBody}</span>
                <div className="upload-actions"><button type="button" className="outline-button" onClick={() => inputRef.current?.click()}>{source ? t.change : t.browse}<ArrowUpRight size={16} /></button>
                  {!source && <button type="button" className="subtle-button" onClick={makeSample}>{t.sample}</button>}
                </div>
              </div>
              {(fileError || processed.error) && <div role="alert" className="inline-alert">{fileError || t.processingError}</div>}
              <div className="setting-title"><SlidersHorizontal size={18} /><h3>{t.controls}</h3></div>
              <div className="range-setting"><div className="setting-label"><label htmlFor="threshold">{t.threshold}</label><b>{threshold}</b></div><input id="threshold" type="range" min="0" max="255" value={threshold} onChange={(event) => setThreshold(Number(event.target.value))} /><small>{t.thresholdHelp}</small></div>
              <div className="range-setting"><div className="setting-label"><label htmlFor="noise">{t.noise}</label><b>{noise} px</b></div><input id="noise" type="range" min="1" max="64" value={noise} onChange={(event) => setNoise(Number(event.target.value))} /><small>{t.noiseHelp}</small></div>
              <div className="range-setting"><div className="setting-label"><label htmlFor="smooth">{t.smooth}</label><b>{smooth.toFixed(1)}</b></div><input id="smooth" type="range" min="0" max="3" step="0.25" value={smooth} onChange={(event) => setSmooth(Number(event.target.value))} /><small>{t.smoothHelp}</small></div>
              <label className="toggle-row"><span><strong>{t.invert}</strong><small>{t.invertHelp}</small></span><input type="checkbox" checked={invert} onChange={(event) => setInvert(event.target.checked)} /><span className="toggle-track" /></label>
              <div className="select-setting"><div><label htmlFor="resolution">{t.resolution}</label><small>{t.resolutionHelp}</small></div><select id="resolution" value={resolution} onChange={(event) => setResolution(Number(event.target.value))}><option value="160">160 px</option><option value="256">256 px</option><option value="320">320 px</option><option value="400">400 px</option></select></div>
              <div className="setting-title dimensions-title"><Crosshair size={18} /><h3>{t.dimensions}</h3></div>
              <div className="dimension-grid"><NumberField label={t.widthMm} value={widthMm} onChange={setWidthMm} min={1} max={3000} suffix="mm" /><div className="number-field"><span>{t.heightMm}</span><div className="calculated-value">{result ? heightMm.toFixed(1) : '—'} <em>mm</em></div></div></div>
              <div className="thickness-field"><NumberField label={t.thickness} value={thicknessMm} onChange={setThicknessMm} min={0.1} max={1000} step={0.5} suffix="mm" /></div>
            </div>

            <div className="preview-panel">
              <div className="panel-head"><span className="panel-index">{t.previewPanel}</span><span className="panel-head-icon"><ScanLine size={18} /></span></div>
              <div className="preview-title"><h3>{t.preview}</h3><span>{result ? `${result.width} × ${result.height} ${t.pixels}` : '— × —'}</span></div>
              <div className="preview-stage">
                {imageUrl && result && vectorUrl ? <>
                  <div className="preview-image-layer"><img src={imageUrl} alt={t.original} /></div>
                  <div className="preview-vector-layer" style={{ clipPath: `inset(0 0 0 ${compare}%)` }}><img src={vectorUrl} alt={t.vector} /></div>
                  <div className="comparison-line" style={{ left: `${compare}%` }}><span>↔</span></div>
                  <div className="preview-chip chip-original">{t.original}</div><div className="preview-chip chip-vector">{t.vector}</div>
                </> : <div className="empty-preview"><div className="empty-graphic"><span className="empty-circle" /><span className="empty-square" /><Crosshair size={27} /></div><strong>{t.previewEmptyTitle}</strong><p>{t.previewEmptyBody}</p></div>}
              </div>
              {result && vectorUrl && <div className="comparison-control"><label htmlFor="compare">{t.compare}</label><input id="compare" type="range" min="0" max="100" value={compare} onChange={(event) => setCompare(Number(event.target.value))} /></div>}
              <div className="preview-bottom"><span><span className="status-dot" />{result ? `${result.contours.length} ${t.contours}` : t.localBadge}</span><span>{result && widthMm > 0 ? `${widthMm.toFixed(1)} × ${heightMm.toFixed(1)} mm` : 'DXF / SVG / STL / NC'}</span></div>
              {result && result.contours.length === 0 && <div className="inline-alert" role="status">{t.noContours}</div>}
            </div>
          </div>
        </section>

        <section className="exports section-pad" id="formats">
          <div className="section-heading"><div><div className="eyebrow"><span className="eyebrow-line" />{t.exportsEyebrow}</div><h2>{t.exportsTitle}</h2><p>{t.exportsBody}</p></div><span className="file-count">{t.formatCount}</span></div>
          <div className="export-grid">{formats.map((format, index) => <article className="export-card" key={format.key}>
            <div className="export-top"><span className="format-icon">{format.icon}</span><span className="format-index">0{index + 1} / {format.tag}</span></div>
            <div><h3>{format.title}</h3><p>{format.body}</p></div>
            <button type="button" className="download-button" disabled={!canExport || (format.key === 'gcode' && !machineReviewed)}
              title={!canExport ? (!source ? t.downloadReady : result?.contours.length === 0 ? t.noContours : undefined) : undefined} onClick={() => void download(format.key)}>
              <span>{busyFormat === format.key ? t.downloadBusy : `${t.download} .${format.key === 'gcode' ? 'nc' : format.key}`}</span><Download size={17} />
            </button>
          </article>)}</div>
          <details className="machine-settings"><summary><Settings2 size={18} />{t.machineDetails}<span className="summary-plus">+</span></summary>
            <div className="machine-fields"><NumberField label={t.safeZ} value={safeZ} onChange={setSafeZ} min={0.1} max={1000} step={0.5} suffix="mm" /><NumberField label={t.cutDepth} value={cutDepth} onChange={setCutDepth} min={0.1} max={1000} step={0.5} suffix="mm" /><NumberField label={t.feedRate} value={feedRate} onChange={setFeedRate} min={1} max={100000} suffix="mm/min" /><NumberField label={t.plungeRate} value={plungeRate} onChange={setPlungeRate} min={1} max={100000} suffix="mm/min" /><NumberField label={t.spindleRpm} value={spindleRpm} onChange={setSpindleRpm} min={1} max={100000} suffix="RPM" /></div>
          </details>
          <div className="machine-safety"><div className="safety-icon"><ShieldCheck size={20} /></div><div><strong>{t.safetyTitle}</strong><p>{t.safetyBody}</p><label className="review-checkbox"><input type="checkbox" checked={machineReviewed} onChange={(event) => setMachineReviewed(event.target.checked)} /><span>{t.acknowledge}</span></label></div></div>
          {exportError && <div className="inline-alert export-alert" role="alert">{exportError}</div>}
        </section>

        <section className="how-section section-pad" id="how"><div className="eyebrow"><span className="eyebrow-line" />{t.howEyebrow}</div><h2>{t.howTitle}</h2>
          <div className="steps-grid"><article><span>01</span><div className="step-icon"><UploadCloud size={24} /></div><h3>{t.stepOneTitle}</h3><p>{t.stepOneBody}</p></article><article><span>02</span><div className="step-icon"><SlidersHorizontal size={24} /></div><h3>{t.stepTwoTitle}</h3><p>{t.stepTwoBody}</p></article><article><span>03</span><div className="step-icon"><FileText size={24} /></div><h3>{t.stepThreeTitle}</h3><p>{t.stepThreeBody}</p></article></div>
        </section>

        <section className="truth-section section-pad"><div className="truth-main"><span className="truth-icon"><MoveUpRight size={24} /></span><h2>{t.formatsTitle}</h2><p>{t.formatsBody}</p></div><div className="truth-list"><div><Check size={17} />{t.formatsDxf}</div><div><Check size={17} />{t.formatsStl}</div><div><Check size={17} />{t.formatsGcode}</div></div></section>
      </main>

      <footer className="site-footer section-pad"><div className="footer-top"><div><div className="footer-brand">Mm <strong>Cnc</strong><span>™</span></div><p>{t.footerLine}</p></div><a href={WHATSAPP_URL} target="_blank" rel="noopener noreferrer" className="footer-contact"><MessageCircle size={20} /><span><small>{t.footerContact}</small><b dir="ltr">{PHONE_DISPLAY}</b></span><ArrowUpRight size={19} /></a></div><div className="footer-bottom"><span>© {new Date().getFullYear()} Mm Cnc</span><span><ShieldCheck size={15} />{t.footerLocal}</span><span>{t.footerLabel}</span></div></footer>
    </div>
  );
}
