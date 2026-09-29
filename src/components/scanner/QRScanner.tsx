import { useEffect, useRef, useState } from 'react';
import jsQR from 'jsqr';
import { BrowserMultiFormatReader } from '@zxing/browser';
import {
  Camera,
  CameraOff,
  CheckCircle2,
  Clipboard,
  ExternalLink,
  Flashlight,
  ImageUp,
  RefreshCw,
  RotateCcw,
  Save,
  ScanLine,
  Sparkles,
  Square,
  Upload,
  ZoomIn,
  ScanBarcode,
} from 'lucide-react';
import { GlassButton } from '../ui/GlassButton';
import { saveHistoryItem } from '../../lib/storage';
import { analyzeScan, type ScanAnalysis } from '../../lib/scan';
import { clearMultiImage, decodeImageQr, getMultiImageMissingFrames, isImageQr, isMultiImageQr, addMultiImageChunk, reconstructMultiImage, parseMultiImageQr } from '../../lib/imageQr';

type ScanMode = 'auto' | 'qr' | 'barcode';

type BarcodeResult = { rawValue?: string; format?: string };

type BatchResult = { value: string; format: string; analysis: ScanAnalysis };

type BarcodeDetectorLike = {
  detect: (source: CanvasImageSource) => Promise<BarcodeResult[]>;
};

type BarcodeDetectorConstructor = {
  new (options?: { formats?: string[] }): BarcodeDetectorLike;
  getSupportedFormats?: () => Promise<string[]>;
};

declare global {
  interface Window {
    BarcodeDetector?: BarcodeDetectorConstructor;
  }
}

const COMMON_BARCODE_FORMATS = [
  'aztec',
  'code_128',
  'code_39',
  'code_93',
  'codabar',
  'data_matrix',
  'ean_13',
  'ean_8',
  'itf',
  'pdf417',
  'qr_code',
  'upc_a',
  'upc_e',
];

function normalizeFormat(value?: string) {
  if (!value) return 'CODE';
  return value
    .replace(/^BarcodeFormat\./, '')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (letter: string) => letter.toUpperCase());
}

function isWebUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

export function QRScanner() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const frameRef = useRef<number | null>(null);
  const scanTimerRef = useRef<number | null>(null);
  const detectorRef = useRef<BarcodeDetectorLike | null>(null);
  const zxingRef = useRef<BrowserMultiFormatReader | null>(null);
  const zxingControlsRef = useRef<{ stop: () => void } | null>(null);
  const lastScanRef = useRef(0);
  const scanDelayRef = useRef(70);
  const recentMultiFrameRef = useRef<Map<string, number>>(new Map());

  const [result, setResult] = useState('');
  const [format, setFormat] = useState('QR CODE');
  const [error, setError] = useState('');
  const [scanning, setScanning] = useState(false);
  const [facingMode, setFacingMode] = useState<'environment' | 'user'>('environment');
  const [torch, setTorch] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [zoomRange, setZoomRange] = useState({ min: 1, max: 1, step: .1 });
  const [dragActive, setDragActive] = useState(false);
  const [mode, setMode] = useState<ScanMode>('auto');
  const [engine, setEngine] = useState('Getting scanner ready');
  const [supportedFormats, setSupportedFormats] = useState<string[]>([]);
  const [analysis, setAnalysis] = useState<ScanAnalysis | null>(null);
  const [batchResults, setBatchResults] = useState<BatchResult[]>([]);
  const [imageResult, setImageResult] = useState('');
  const [multiImageResult, setMultiImageResult] = useState<{ url:string; name:string; size:number } | null>(null);
  const [multiProgress, setMultiProgress] = useState<{ id:string; received:number; total:number; missingCount:number; missing:number[] | null } | null>(null);

  useEffect(() => () => stopCamera(), []);
  useEffect(() => () => {
    if (multiImageResult?.url) URL.revokeObjectURL(multiImageResult.url);
  }, [multiImageResult]);

  function stopCamera() {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    if (scanTimerRef.current !== null) window.clearTimeout(scanTimerRef.current);
    frameRef.current = null;
    scanTimerRef.current = null;

    zxingControlsRef.current?.stop();
    zxingControlsRef.current = null;

    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    detectorRef.current = null;
    recentMultiFrameRef.current.clear();

    setScanning(false);
    setTorch(false);
  }

  async function createNativeDetector(nextMode: ScanMode) {
    const Constructor = window.BarcodeDetector;
    if (!Constructor) return false;

    try {
      const available = (await Constructor.getSupportedFormats?.()) ?? COMMON_BARCODE_FORMATS;
      const requested = nextMode === 'qr'
        ? ['qr_code']
        : nextMode === 'barcode'
          ? available.filter((item) => item !== 'qr_code')
          : available;

      if (!requested.length) return false;

      detectorRef.current = new Constructor({ formats: requested });
      setSupportedFormats(available);
      setEngine(`Scanner ready`);
      return true;
    } catch {
      detectorRef.current = null;
      return false;
    }
  }

  function isFormatAllowed(foundFormat: string, nextMode = mode) {
    const normalized = foundFormat.toLowerCase().replace(/[_-]/g, ' ');
    const isQr = normalized.includes('qr');
    if (nextMode === 'qr') return isQr;
    if (nextMode === 'barcode') return !isQr;
    return true;
  }

  async function startZXing(video: HTMLVideoElement, nextMode: ScanMode = mode) {
    try {
      const reader = new BrowserMultiFormatReader();
      zxingRef.current = reader;
      let stopAfterDecode = false;

      const controls = await reader.decodeFromVideoElement(video, (decoded, decodeError) => {
        if (decoded?.getText()) {
          const value = decoded.getText().trim();
          const foundFormat = normalizeFormat(decoded.getBarcodeFormat()?.toString());
          if (!isFormatAllowed(foundFormat, nextMode)) return;

          void handleDecoded(value, foundFormat);
          if (!isMultiImageQr(value)) stopAfterDecode = true;
          return;
        }
        void decodeError;
      });

      zxingControlsRef.current = controls;
      if (stopAfterDecode) {
        controls.stop();
        zxingControlsRef.current = null;
      }
      setEngine('Backup scanner');
    } catch {
      setEngine('Basic scanner');
      scanFrame();
    }
  }

  async function startCamera(nextFacing = facingMode, nextMode: ScanMode = mode) {
    setError('');
    setResult('');
    setAnalysis(null);
    setImageResult('');
    if (multiImageResult?.url) URL.revokeObjectURL(multiImageResult.url);
    setMultiImageResult(null);
    setMultiProgress(null);
    stopCamera();
    scanDelayRef.current = 70;

    if (!navigator.mediaDevices?.getUserMedia) {
      setError('Camera access is unavailable here. Open the installed app or an HTTPS page.');
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: nextFacing },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
        audio: false,
      });

      streamRef.current = stream;
      const track = stream.getVideoTracks()[0];
      const capabilities = (track?.getCapabilities?.() ?? {}) as MediaTrackCapabilities & {
        torch?: boolean;
        zoom?: { min: number; max: number; step?: number };
      };

      if (capabilities.zoom) {
        setZoomRange({
          min: capabilities.zoom.min,
          max: capabilities.zoom.max,
          step: capabilities.zoom.step || .1,
        });
        setZoom(capabilities.zoom.min);
      } else {
        setZoomRange({ min: 1, max: 1, step: .1 });
      }

      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }

      setFacingMode(nextFacing);
      setScanning(true);

      const nativeReady = await createNativeDetector(nextMode);

      if (nativeReady) {
        scanFrame();
      } else if (videoRef.current) {
        await startZXing(videoRef.current, nextMode);
      }
    } catch (cameraError) {
      const name = cameraError instanceof DOMException ? cameraError.name : '';
      if (name === 'NotAllowedError') setError('Camera access was blocked. Allow camera access and try again.');
      else if (name === 'NotFoundError') setError('No camera was found on this device.');
      else setError('The camera could not start. Try again or choose a photo instead.');
    }
  }

  async function scanFrame() {
    const video = videoRef.current;
    if (!video || !streamRef.current || !detectorRef.current) return;

    const now = performance.now();
    if (now - lastScanRef.current < 90) {
      frameRef.current = requestAnimationFrame(scanFrame);
      return;
    }
    lastScanRef.current = now;
    const started = now;
    let foundCount = 0;

    try {
      if (video.readyState >= 2) {
        const found = await detectorRef.current.detect(video);
        foundCount = found.length;
        if (foundCount) await handleBatchDecoded(found);
      }
    } catch {
      // Keep scanning through transient camera/detector errors.
    }

    const elapsed = performance.now() - started;
    if (elapsed > 80) scanDelayRef.current = Math.min(140, Math.max(scanDelayRef.current, Math.round(elapsed * 0.9)));
    else if (foundCount > 0) scanDelayRef.current = Math.max(30, scanDelayRef.current - 6);
    else scanDelayRef.current = Math.min(85, scanDelayRef.current + 1);

    scanTimerRef.current = window.setTimeout(() => {
      scanTimerRef.current = null;
      if (streamRef.current && detectorRef.current) void scanFrame();
    }, scanDelayRef.current);
  }

  async function handleBatchDecoded(results: BarcodeResult[]) {
    const values = results
      .filter((item) => item.rawValue)
      .map((item) => ({ value: item.rawValue!.trim(), format: normalizeFormat(item.format) }))
      .filter((item, index, arr) => arr.findIndex(other => other.value === item.value) === index);

    const multiValues = values.filter(item => isMultiImageQr(item.value));
    if (multiValues.length) {
      for (const item of multiValues) await handleDecoded(item.value, item.format);
      const normalValues = values.filter(item => !isMultiImageQr(item.value));
      if (!normalValues.length) return;
      // If an image contains both transfer frames and ordinary codes, keep the
      // ordinary codes available as a secondary batch result.
      const batch = normalValues.map(item => ({
        value: item.value,
        format: item.format,
        analysis: analyzeScan(item.value, item.format),
      }));
      setBatchResults(batch);
      batch.forEach(item => saveHistoryItem(item.value, { format: item.format, kind: item.analysis.kind, title: item.analysis.title }));
      return;
    }

    const seen = new Set<string>();
    const batch: BatchResult[] = values
      .map(item => ({ value: item.value, format: item.format, analysis: analyzeScan(item.value, item.format) }))
      .filter(item => {
        if (seen.has(item.value)) return false;
        seen.add(item.value);
        return true;
      });
    if (!batch.length) return;
    setResult('');
    setAnalysis(null);
    setBatchResults(batch);
    batch.forEach((item) => saveHistoryItem(item.value, { format: item.format, kind: item.analysis.kind, title: item.analysis.title }));
    stopCamera();
  }

  async function handleDecoded(value: string, foundFormat = 'qr_code') {
    if (!value) return;
    if (isMultiImageQr(value)) {
      const now = performance.now();
      const previous = recentMultiFrameRef.current.get(value);
      if (previous && now - previous < 600) return;
      recentMultiFrameRef.current.set(value, now);

      if (recentMultiFrameRef.current.size > 300) {
        for (const [key, timestamp] of recentMultiFrameRef.current) {
          if (now - timestamp > 5000) recentMultiFrameRef.current.delete(key);
        }
      }
      const parsed = parseMultiImageQr(value);
      if (!parsed) { setError('This Multi-QR photo frame is invalid.'); return; }

      try {
        const progress = await addMultiImageChunk(value);
        if (!progress) { setError('This Multi-QR photo frame is invalid.'); return; }

        setMultiProgress({
          id: parsed.id,
          received: progress.received,
          total: progress.total,
          missingCount: progress.missingCount,
          missing: null,
        });
        setResult('');
        setAnalysis(null);
        setImageResult('');

        if (progress.complete) {
          const rebuilt = await reconstructMultiImage(parsed.id);
          if (rebuilt) {
            if (multiImageResult?.url) URL.revokeObjectURL(multiImageResult.url);
            setMultiImageResult(rebuilt);
            setMultiProgress(null);
            stopCamera();
          }
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Unable to store this Multi-QR frame.');
      }
      return;
    }

    const displayFormat = normalizeFormat(foundFormat);
    const nextAnalysis = analyzeScan(value, displayFormat);
    setResult(value);
    setFormat(displayFormat);
    setAnalysis(nextAnalysis);
    const imageData = decodeImageQr(value);
    setImageResult(imageData || '');
    saveHistoryItem(value, { format: displayFormat, kind: nextAnalysis.kind, title: nextAnalysis.title });
    stopCamera();
  }

  async function handleFile(file: File) {
    setError('');
    setResult('');
    setAnalysis(null);

    if (!file.type.startsWith('image/')) {
      setError('Please choose a PNG, JPEG, WebP or another image file.');
      return;
    }

    try {
      const source = URL.createObjectURL(file);
      const image = new Image();

      image.onload = async () => {
        try {
          if (window.BarcodeDetector) {
            try {
              const Constructor = window.BarcodeDetector;
              const available = (await Constructor.getSupportedFormats?.()) ?? COMMON_BARCODE_FORMATS;
              const requested = mode === 'qr'
                ? ['qr_code']
                : mode === 'barcode'
                  ? available.filter((item) => item !== 'qr_code')
                  : available;

              if (requested.length) {
                const detector = new Constructor({ formats: requested });
                const found = await detector.detect(image);
                if (found.length) {
                  URL.revokeObjectURL(source);
                  await handleBatchDecoded(found);
                  return;
                }
              }
            } catch {
              // Fall through to ZXing.
            }
          }

          try {
            const reader = new BrowserMultiFormatReader();
            const decoded = await reader.decodeFromImageElement(image);
            if (decoded?.getText()) {
              const foundFormat = normalizeFormat(decoded.getBarcodeFormat()?.toString());
              if (!isFormatAllowed(foundFormat)) {
                throw new Error('Barcode is not allowed in the selected scan mode.');
              }
              URL.revokeObjectURL(source);
              handleDecoded(decoded.getText(), foundFormat);
              return;
            }
          } catch {
            // Fall through to the lightweight QR decoder.
          }

          const canvas = document.createElement('canvas');
          const maxDimension = 1600;
          const scale = Math.min(1, maxDimension / Math.max(image.naturalWidth, image.naturalHeight));
          const width = Math.max(1, Math.round(image.naturalWidth * scale));
          const height = Math.max(1, Math.round(image.naturalHeight * scale));
          canvas.width = width;
          canvas.height = height;
          const context = canvas.getContext('2d', { willReadFrequently: true });

          if (!context) throw new Error('canvas');
          context.imageSmoothingEnabled = false;
          context.drawImage(image, 0, 0, width, height);
          let pixels = context.getImageData(0, 0, width, height);
          let code = jsQR(pixels.data, pixels.width, pixels.height, { inversionAttempts: 'attemptBoth' });

          // A 4K photo is expensive to scan and rarely needs its full raster.
          // Retry at original resolution only when the fast pass cannot find a QR.
          if (!code?.data && scale < 1) {
            canvas.width = image.naturalWidth;
            canvas.height = image.naturalHeight;
            context.imageSmoothingEnabled = false;
            context.drawImage(image, 0, 0);
            pixels = context.getImageData(0, 0, canvas.width, canvas.height);
            code = jsQR(pixels.data, pixels.width, pixels.height, { inversionAttempts: 'attemptBoth' });
          }

          URL.revokeObjectURL(source);

          if (code?.data) handleDecoded(code.data, 'qr_code');
          else setError('I couldn't read a code from that photo. Try a clearer, brighter photo.');
        } catch {
          URL.revokeObjectURL(source);
          setError('Unable to read this image.');
        }
      };

      image.onerror = () => {
        URL.revokeObjectURL(source);
        setError('Unable to load the selected image.');
      };
      image.src = source;
    } catch {
      setError('Unable to scan the selected image.');
    }
  }

  async function copyResult() {
    if (!result || !navigator.clipboard) return;
    await navigator.clipboard.writeText(result);
  }

  async function applyCameraControl(name: 'torch' | 'zoom', value: boolean | number) {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track) return;

    try {
      if (name === 'torch') {
        await track.applyConstraints({ advanced: [{ torch: Boolean(value) } as MediaTrackConstraintSet] });
        setTorch(Boolean(value));
      } else {
        await track.applyConstraints({ advanced: [{ zoom: Number(value) } as MediaTrackConstraintSet] });
        setZoom(Number(value));
      }
    } catch {
      setError('This camera does not support that control.');
    }
  }

  function toggleCamera() {
    void startCamera(facingMode === 'environment' ? 'user' : 'environment');
  }

  function changeMode(nextMode: ScanMode) {
    setMode(nextMode);
    if (scanning) void startCamera(facingMode, nextMode);
  }

  return (
    <div className="scanner-tool space-y-5">
      <div className="scanner-modebar glass-soft flex flex-col gap-3 rounded-[24px] p-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-xs font-bold uppercase tracking-[.16em] text-[var(--text-muted)]">What do you want to scan?</p>
          <p className="mt-1 text-sm text-[var(--text-muted)]">Scan QR codes or barcodes. You can change this anytime.</p>
        </div>
        <div className="grid grid-cols-3 gap-1 rounded-2xl border border-[var(--border)] bg-[var(--bg-elevated)] p-1">
          {([
            ['auto', 'Auto'],
            ['qr', 'QR codes'],
            ['barcode', 'Barcode'],
          ] as const).map(([value, label]) => (
            <button
              key={value}
              onClick={() => changeMode(value)}
              className={`rounded-xl px-3 py-2 text-xs font-bold transition ${mode === value ? 'bg-[var(--text)] text-[var(--bg)] shadow-lg' : 'text-[var(--text-muted)] hover:bg-white/5'}`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="grid gap-5 lg:grid-cols-[1.35fr_.65fr]">
        <div className="scanner-camera relative overflow-hidden rounded-[30px] border border-[var(--border)] bg-black shadow-2xl shadow-black/20">
          <div className="absolute inset-x-0 top-0 z-10 flex items-center justify-between bg-gradient-to-b from-black/75 to-transparent p-4">
            <div className="flex items-center gap-2 text-xs font-semibold text-white">
              <span className={`h-2 w-2 rounded-full ${scanning ? 'animate-pulse bg-emerald-400' : 'bg-white/30'}`} />
              {scanning ? 'Scanning…' : 'Ready to scan'}
            </div>
            <span className="rounded-full border border-white/15 bg-black/35 px-3 py-1 text-[10px] font-bold uppercase tracking-[.16em] text-white/75">
              {format}
            </span>
          </div>

          <div className="relative min-h-[min(76vh,760px)] h-[min(76vh,760px)] sm:min-h-[560px] sm:h-[min(78vh,820px)]">
            <video ref={videoRef} className="h-full w-full bg-black object-cover" muted playsInline />
            {!scanning && (
              <div className="absolute inset-0 grid place-items-center bg-[radial-gradient(circle_at_center,rgba(99,229,255,.12),transparent_42%)]">
                <div className="text-center">
                  <span className="mx-auto grid h-16 w-16 place-items-center rounded-2xl border border-white/10 bg-white/10 text-white backdrop-blur-xl">
                    <ScanLine size={30} />
                  </span>
                  <p className="mt-4 text-sm font-semibold text-white">Scan a QR code or barcode</p>
                  <p className="mt-1 text-xs text-white/50">Place the code inside the box and keep it clear.</p>
                </div>
              </div>
            )}
            {scanning && (
              <div className="pointer-events-none absolute inset-0 grid place-items-center">
                <div className={`relative ${mode === 'barcode' ? 'h-[34%] w-[88%] max-w-[760px]' : 'h-[78%] w-[78%] max-w-[560px]'} rounded-[28px] border-2 border-white/70 shadow-[0_0_0_999px_rgba(0,0,0,.25)]`}>
                  <span className="absolute -left-1 -top-1 h-8 w-8 rounded-tl-xl border-l-4 border-t-4 border-cyan-300" />
                  <span className="absolute -right-1 -top-1 h-8 w-8 rounded-tr-xl border-r-4 border-t-4 border-cyan-300" />
                  <span className="absolute -bottom-1 -left-1 h-8 w-8 rounded-bl-xl border-b-4 border-l-4 border-cyan-300" />
                  <span className="absolute -bottom-1 -right-1 h-8 w-8 rounded-br-xl border-b-4 border-r-4 border-cyan-300" />
                  <span className="absolute left-5 right-5 top-1/2 h-px animate-pulse bg-cyan-300 shadow-[0_0_16px_rgba(103,232,249,.9)]" />
                </div>
              </div>
            )}
          </div>

          <div className="scanner-camera-actions flex flex-wrap items-center gap-2 border-t border-white/10 bg-black/50 p-3 backdrop-blur-xl">
            <GlassButton onClick={() => void startCamera()} className="bg-white text-slate-950">
              <Camera size={15} /> {scanning ? 'Restart' : 'Start scanning'}
            </GlassButton>
            <GlassButton onClick={stopCamera}><CameraOff size={15} /> Stop scanning</GlassButton>
            <GlassButton onClick={toggleCamera} disabled={!streamRef.current} aria-label="Switch camera"><RotateCcw size={15} /></GlassButton>
            <GlassButton onClick={() => void applyCameraControl('torch', !torch)} disabled={!streamRef.current} aria-label="Toggle flashlight"><Flashlight size={15} /></GlassButton>
          </div>
        </div>

        <div className="space-y-3">
          <label
            className={`scanner-image-card group flex min-h-[250px] cursor-pointer flex-col items-center justify-center rounded-[30px] border border-dashed p-7 text-center transition ${dragActive ? 'border-cyan-300 bg-cyan-300/10' : 'border-[var(--border)] bg-[var(--bg-soft)] hover:bg-white/5'}`}
            onDragOver={(event) => { event.preventDefault(); setDragActive(true); }}
            onDragLeave={() => setDragActive(false)}
            onDrop={(event) => {
              event.preventDefault();
              setDragActive(false);
              const file = event.dataTransfer.files[0];
              if (file) void handleFile(file);
            }}
          >
            <span className="grid h-14 w-14 place-items-center rounded-2xl bg-gradient-to-br from-cyan-300/20 to-indigo-500/20 text-cyan-300">
              {dragActive ? <Upload size={24} /> : <ImageUp size={24} />}
            </span>
            <span className="mt-4 text-sm font-bold text-[var(--text)]">Scan a photo</span>
            <span className="mt-2 max-w-[240px] text-xs leading-5 text-[var(--text-muted)]">Use a photo, screenshot, ticket, or product label.</span>
            <span className="mt-5 rounded-full border border-[var(--border)] bg-[var(--bg-elevated)] px-4 py-2 text-xs font-semibold text-[var(--text)]">Choose a photo</span>
            <input type="file" accept="image/*" className="sr-only" onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void handleFile(file);
              event.currentTarget.value = '';
            }} />
          </label>

          <div className="scanner-engine glass-soft rounded-[24px] p-4">
            <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-[.16em] text-[var(--text-muted)]">
              <Sparkles size={14} className="text-cyan-300" /> {engine}
            </div>
            <p className="mt-2 text-sm leading-6 text-[var(--text-muted)]">
              The app can read QR codes and many common barcodes. What it can read depends on your device.
            </p>
            {supportedFormats.length > 0 && (
              <p className="mt-2 text-[11px] leading-5 text-[var(--text-muted)]">
                Code types available on this device: {supportedFormats.map(normalizeFormat).join(' · ')}
              </p>
            )}
          </div>
        </div>
      </div>

      {scanning && zoomRange.max > zoomRange.min && (
        <div className="glass-soft flex items-center gap-4 rounded-[22px] p-4">
          <ZoomIn size={17} className="shrink-0 text-[var(--text-muted)]" />
          <input aria-label="Camera zoom" type="range" min={zoomRange.min} max={zoomRange.max} step={zoomRange.step} value={zoom}
            onChange={(event) => void applyCameraControl('zoom', Number(event.target.value))} className="w-full accent-[var(--primary)]" />
          <span className="w-12 text-right text-xs font-semibold text-[var(--text-muted)]">{zoom.toFixed(1)}×</span>
        </div>
      )}

      {error && (
        <div className="flex items-start gap-3 rounded-[22px] border border-rose-300/20 bg-rose-400/10 p-4 text-sm text-rose-100">
          <span className="mt-0.5"><Square size={15} /></span>
          <p className="leading-6">{error}</p>
        </div>
      )}

      {batchResults.length > 0 && (
        <div className="overflow-hidden rounded-[28px] border border-cyan-300/20 bg-cyan-300/[.06] p-5">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-xs font-bold uppercase tracking-[.16em] text-cyan-300">Multiple codes found</p>
              <p className="mt-1 text-sm text-[var(--text-muted)]">{batchResults.length} codes were found and saved to your saved scans.</p>
            </div>
            <button onClick={() => setBatchResults([])} className="rounded-full p-2 text-[var(--text-muted)] hover:bg-white/10" aria-label="Clear batch results"><RefreshCw size={16} /></button>
          </div>
          <div className="mt-4 grid gap-3 lg:grid-cols-2">
            {batchResults.map((item, index) => (
              <div key={item.value + item.format} className="rounded-2xl border border-[var(--border)] bg-[var(--bg-elevated)] p-4">
                <div className="flex items-start gap-3">
                  <span className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-cyan-300/10 text-cyan-300 text-xs font-black">{index + 1}</span>
                  <div className="min-w-0">
                    <p className="text-sm font-bold text-[var(--text)]">{item.analysis.title}</p>
                    <p className="mt-1 text-[10px] font-semibold uppercase tracking-[.12em] text-[var(--text-muted)]">{item.format}</p>
                  </div>
                </div>
                <p className="mt-3 break-words text-xs leading-5 text-[var(--text)]">{item.value}</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <GlassButton onClick={() => navigator.clipboard?.writeText(item.value)}><Clipboard size={14} /> Copy</GlassButton>
                  {item.analysis.actionUrl && <a href={item.analysis.actionUrl} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-10 items-center gap-2 rounded-full bg-white px-4 py-2 text-xs font-bold text-slate-950"><ExternalLink size={14} /> {item.analysis.actionLabel || 'Open'}</a>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {multiProgress && (
        <div className="overflow-hidden rounded-[28px] border border-cyan-300/20 bg-cyan-300/[.06] p-5">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-xs font-bold uppercase tracking-[.16em] text-cyan-300">Photo from multiple QR codes</p>
              <p className="mt-1 text-sm text-[var(--text-muted)]">{multiProgress.received} of {multiProgress.total} parts received. They can arrive in any order.</p>
            </div>
            <span className="text-sm font-black text-[var(--text)]">{Math.round(multiProgress.received / multiProgress.total * 100)}%</span>
          </div>
          <div className="mt-4 h-2 overflow-hidden rounded-full bg-white/10"><div className="h-full rounded-full bg-cyan-300 transition-all" style={{ width: `${Math.min(100, multiProgress.received / multiProgress.total * 100)}%` }} /></div>
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0 text-xs leading-5 text-[var(--text-muted)]">
              {multiProgress.missingCount > 0
                ? <span>{multiProgress.missingCount} frame{multiProgress.missingCount === 1 ? '' : 's'} still missing. Keep the other device showing the codes and keep scanning.</span>
                : <span className="text-emerald-300">Everything received. Putting the photo back together…</span>}
              {multiProgress.missing && multiProgress.missing.length > 0 && (
                <p className="mt-1 break-words">Missing: {multiProgress.missing.slice(0, 40).join(', ')}{multiProgress.missing.length > 40 ? ` +${multiProgress.missing.length - 40} more` : ''}</p>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              {multiProgress.missingCount > 0 && (
                <GlassButton onClick={() => { void (async () => {
                  const missing = await getMultiImageMissingFrames(multiProgress.id);
                  setMultiProgress(prev => prev ? { ...prev, missing } : prev);
                })(); }}>
                  <ScanLine size={14}/> Show missing parts
                </GlassButton>
              )}
              <GlassButton onClick={() => { void clearMultiImage(multiProgress.id); setMultiProgress(null); setError(''); }}>
                <RefreshCw size={14}/> Start over
              </GlassButton>
            </div>
          </div>
        </div>
      )}

      {multiImageResult && (
        <div className="overflow-hidden rounded-[28px] border border-emerald-300/20 bg-emerald-400/[.06] p-5 text-center">
          <p className="text-xs font-bold uppercase tracking-[.16em] text-emerald-300">Photo restored</p>
          <img src={multiImageResult.url} alt={`Original image reconstructed from Multi-QR frames: ${multiImageResult.name}`} className="mx-auto mt-4 max-h-[640px] max-w-full rounded-2xl object-contain" />
          <p className="mt-3 break-words text-sm font-bold text-[var(--text)]">{multiImageResult.name}</p>
          <p className="mt-1 text-xs text-[var(--text-muted)]">{(multiImageResult.size / 1024 / 1024).toFixed(2)} MB · original quality preserved</p>
          <p className="mt-3 text-xs text-[var(--text-muted)]">The original photo was kept as-is.</p>
          <a href={multiImageResult.url} download={multiImageResult.name} className="mt-3 inline-flex min-h-10 items-center gap-2 rounded-full bg-white px-4 py-2 text-xs font-bold text-slate-950"><Save size={14}/> Save photo</a>
          <GlassButton onClick={() => { URL.revokeObjectURL(multiImageResult.url); setMultiImageResult(null); }} className="ml-2"><RefreshCw size={14}/> Clear</GlassButton>
        </div>
      )}
      {result && (
        <div className="overflow-hidden rounded-[28px] border border-emerald-300/20 bg-emerald-400/[.06] p-5">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-[.16em] text-emerald-300">
              {format.includes('QR') ? <CheckCircle2 size={16} /> : <ScanBarcode size={16} />}
              {format} found
            </div>
            <button onClick={() => { setResult(''); setError(''); setAnalysis(null); setBatchResults([]); }} className="rounded-full p-2 text-[var(--text-muted)] hover:bg-white/10" aria-label="Clear result">
              <RefreshCw size={16} />
            </button>
          </div>
          {analysis && (
            <div className="mt-3 rounded-2xl border border-[var(--border)] bg-[var(--bg-elevated)] p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-bold text-[var(--text)]">{analysis.title}</p>
                  <p className="mt-1 break-words text-xs text-[var(--text-muted)]">{analysis.subtitle}</p>
                </div>
                {analysis.actionUrl && analysis.actionLabel && (
                  <a href={analysis.actionUrl} target="_blank" rel="noopener noreferrer" className="shrink-0 rounded-full bg-white px-3 py-2 text-xs font-bold text-slate-950 shadow-lg">
                    {analysis.actionLabel}
                  </a>
                )}
              </div>
              {Object.keys(analysis.meta).length > 0 && (
                <div className="mt-3 grid gap-2 sm:grid-cols-2">
                  {Object.entries(analysis.meta).map(([label, value]) => (
                    <div key={label} className="rounded-xl border border-[var(--border)] bg-[var(--bg-soft)] px-3 py-2">
                      <p className="text-[10px] font-bold uppercase tracking-[.14em] text-[var(--text-muted)]">{label}</p>
                      <p className="mt-1 break-words text-xs text-[var(--text)]">{value}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          {imageResult && isImageQr(result) && <div className="mt-3 rounded-2xl border border-cyan-300/20 bg-black/20 p-3 text-center"><img src={imageResult} alt="Image reconstructed from QR" className="mx-auto max-h-[520px] w-auto rounded-xl object-contain" /><p className="mt-2 text-xs text-[var(--text-muted)]">Image reconstructed locally from the QR payload.</p><a href={imageResult} download="qr-image.jpg" className="mt-2 inline-flex min-h-10 items-center gap-2 rounded-full bg-white px-4 py-2 text-xs font-bold text-slate-950"><Save size={14}/> Save image</a></div>}
          <p className="mt-3 break-words rounded-2xl border border-[var(--border)] bg-[var(--bg-elevated)] p-4 text-sm leading-6 text-[var(--text)]">{result}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <GlassButton onClick={() => void copyResult()}><Clipboard size={15} /> Copy</GlassButton>
            <GlassButton onClick={() => saveHistoryItem(result)}><Save size={15} /> Save</GlassButton>
            {isWebUrl(result) && (
              <a href={result} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-10 items-center gap-2 rounded-full bg-white px-4 py-2 text-sm font-semibold text-slate-950 shadow-lg">
                <ExternalLink size={15} /> Open link
              </a>
            )}
            <GlassButton onClick={() => void startCamera()}><ScanLine size={15} /> Scan another</GlassButton>
          </div>
        </div>
      )}
    </div>
  );
}
