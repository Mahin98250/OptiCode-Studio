import { useEffect, useMemo, useRef, useState } from 'react';
import { ImagePlus, Link2, Loader2, RotateCcw, Layers3, Download, Pause, Play } from 'lucide-react';
import { GlassButton } from '../ui/GlassButton';
import { useGenerator } from './GeneratorContext';
import { encodeImageForQr, encodeImageForMultiQr } from '../../lib/imageQr';
import { toQrDataUrl } from '../../lib/qr';

export function GeneratorForm() {
  const { settings, setSettings } = useGenerator();
  const operationRef = useRef(0);
  const requestedMultiModeRef = useRef(false);
  const [imageMode, setImageMode] = useState(false);
  const [multiMode, setMultiMode] = useState(false);
  const [multiPlan, setMultiPlan] = useState<Awaited<ReturnType<typeof encodeImageForMultiQr>> | null>(null);
  const [multiQr, setMultiQr] = useState('');
  const [multiIndex, setMultiIndex] = useState(1);
  const [multiPlaying, setMultiPlaying] = useState(false);
  const [multiInterval, setMultiInterval] = useState(1000);
  const [imageName, setImageName] = useState('');
  const [imagePreview, setImagePreview] = useState('');
  const [imageInfo, setImageInfo] = useState('');
  const [error, setError] = useState('');
  const [encoding, setEncoding] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const isValid = useMemo(() => settings.value.trim().length > 0, [settings.value]);

  useEffect(() => {
    if (!multiPlan) {
      setMultiQr('');
      return;
    }

    let cancelled = false;
    setMultiQr('');

    void multiPlan.getChunk(multiIndex)
      .then(async chunk => {
        if (cancelled) return;
        setSettings(prev => ({ ...prev, value: chunk, errorCorrectionLevel: 'L' }));

        const frameUrl = await toQrDataUrl({
          ...settings,
          value: chunk,
          errorCorrectionLevel: 'L',
        });
        if (!cancelled) setMultiQr(frameUrl);
      })
      .catch(() => {
        if (!cancelled) setError('Unable to render this Large photo frame.');
      });

    return () => { cancelled = true; };
  }, [multiPlan, multiIndex, setSettings, settings.size, settings.margin, settings.dark, settings.light]);

  useEffect(() => {
    if (!multiPlaying || !multiPlan || multiPlan.total < 2) return;

    const timer = window.setInterval(() => {
      setMultiIndex(current => current >= multiPlan.total ? 1 : current + 1);
    }, multiInterval);

    return () => window.clearInterval(timer);
  }, [multiPlaying, multiPlan, multiInterval]);

  async function chooseImage(file?: File) {
    if (!file) return;
    const operation = ++operationRef.current;
    const useMultiMode = requestedMultiModeRef.current;
    setError(''); setEncoding(true); setMultiPlaying(false); setMultiPlan(null); setMultiQr(''); setMultiIndex(1);
    try {
      if (useMultiMode) {
        const encoded = await encodeImageForMultiQr(file);
        if (operation !== operationRef.current) return;
        const firstChunk = await encoded.getChunk(1);
        setImageMode(true); setImageName(file.name); setMultiPlan(encoded); setMultiIndex(1);
        setImagePreview(''); setImageInfo(`Original photo kept · ${(encoded.size / 1024 / 1024).toFixed(2)} MB · ${encoded.total} QR parts`);
        setSettings(prev => ({ ...prev, value: firstChunk, errorCorrectionLevel: 'L' }));
      } else {
        try {
          const encoded = await encodeImageForQr(file);
          if (operation !== operationRef.current) return;
          setImageMode(true); setImageName(file.name); setImagePreview(encoded.previewUrl);
          setImageInfo(`${encoded.width}×${encoded.height} · ${encoded.preservedDimensions ? 'original pixel dimensions preserved' : 'highest resolution that fits one QR'}`);
          setSettings(prev => ({ ...prev, value: encoded.payload, errorCorrectionLevel: 'L' }));
        } catch (singleError) {
          // Camera photos are usually too large for one QR. Automatically fall back
          // to lossless Large photo instead of leaving the previous QR visible.
          if (singleError instanceof Error && singleError.message.includes('Multi-QR Photo')) {
            const encoded = await encodeImageForMultiQr(file);
            if (operation !== operationRef.current) return;
            const firstChunk = await encoded.getChunk(1);
            setImageMode(true); setMultiMode(true); setImageName(file.name); setMultiPlan(encoded); setMultiIndex(1);
            setImagePreview(''); setImageInfo(`Original photo kept · ${(encoded.size / 1024 / 1024).toFixed(2)} MB · ${encoded.total} QR parts`);
            setSettings(prev => ({ ...prev, value: firstChunk, errorCorrectionLevel: 'L' }));
          } else {
            throw singleError;
          }
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to prepare this image.');
    } finally { setEncoding(false); }
  }
  function reset() {
    operationRef.current += 1;
    requestedMultiModeRef.current = false;
    setImageMode(false); setMultiMode(false); setImageName(''); setImagePreview(''); setImageInfo(''); setError(''); setMultiPlaying(false); setMultiPlan(null); setMultiQr(''); setMultiIndex(1);
    setSettings(prev => ({ ...prev, value: '' }));
  }

  return <div className="space-y-6">
    <div className="flex items-start gap-4">
      <div className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-gradient-to-br from-cyan-300/20 to-indigo-500/25 text-cyan-200">{imageMode ? <ImagePlus size={19}/> : <Link2 size={19}/>}</div>
      <div><h2 className="text-xl font-bold text-[var(--text)]">What do you want to put in the QR code?</h2><p className="mt-1 text-sm leading-6 text-[var(--text-muted)]">Add text, a link, or a photo. Large photos are automatically split into several QR codes.</p></div>
    </div>

    <div className="generator-mode-tabs grid grid-cols-3 gap-2 rounded-2xl border border-[var(--border)] bg-[var(--bg-soft)] p-1">
      <button type="button" onClick={() => { requestedMultiModeRef.current = false; setImageMode(false); setMultiMode(false); setMultiPlaying(false); setMultiPlan(null); setMultiQr(''); setMultiIndex(1); }} className={`rounded-xl px-4 py-3 text-sm font-bold ${!imageMode ? 'bg-[var(--text)] text-[var(--bg)] shadow-lg' : 'text-[var(--text-muted)]'}`}><Link2 size={15} className="mr-2 inline" />Text or link</button>
      <button type="button" onClick={() => { requestedMultiModeRef.current = false; setMultiMode(false); setMultiPlaying(false); setMultiPlan(null); setMultiQr(''); setMultiIndex(1); inputRef.current?.click(); }} disabled={encoding} className={`rounded-xl px-3 py-3 text-xs font-bold ${imageMode && !multiMode ? 'bg-[var(--text)] text-[var(--bg)] shadow-lg' : 'text-[var(--text-muted)]'}`}>{encoding ? <Loader2 size={15} className="mr-1 inline animate-spin" /> : <ImagePlus size={15} className="mr-1 inline" />}Photo to QR</button>
      <button type="button" onClick={() => { requestedMultiModeRef.current = true; setMultiMode(true); setMultiPlaying(false); setMultiPlan(null); setMultiQr(''); setMultiIndex(1); inputRef.current?.click(); }} disabled={encoding} className={`rounded-xl px-3 py-3 text-xs font-bold ${multiMode ? 'bg-[var(--text)] text-[var(--bg)] shadow-lg' : 'text-[var(--text-muted)]'}`}><Layers3 size={15} className="mr-1 inline" />Large photo</button>
    </div>
    <input ref={inputRef} type="file" accept="image/*" className="sr-only" onChange={e => { void chooseImage(e.target.files?.[0]); e.currentTarget.value=''; }} />
    <div className="generator-image-source grid grid-cols-2 gap-2">
      <button type="button" onClick={() => { const input = inputRef.current; if (input) { input.setAttribute('capture', 'environment'); input.click(); input.removeAttribute('capture'); } }} disabled={encoding} className="rounded-2xl border border-cyan-300/20 bg-cyan-300/[.06] px-4 py-3 text-xs font-bold text-cyan-100 transition hover:bg-cyan-300/10 disabled:opacity-50">Take photo</button>
      <button type="button" onClick={() => inputRef.current?.click()} disabled={encoding} className="rounded-2xl border border-[var(--border)] bg-[var(--bg-soft)] px-4 py-3 text-xs font-bold text-[var(--text)] transition hover:bg-white/5 disabled:opacity-50">Choose from gallery</button>
    </div>

    {imageMode ? <div className="rounded-[24px] border border-cyan-300/20 bg-cyan-300/[.06] p-4">
      <div className="flex gap-4">{imagePreview && <img src={imagePreview} alt="Selected photo" className="h-24 w-24 shrink-0 rounded-2xl object-cover" />}<div className="min-w-0"><p className="text-sm font-bold text-[var(--text)]">Photo ready</p><p className="mt-1 truncate text-xs text-[var(--text-muted)]">{imageName}</p><p className="mt-1 text-xs text-cyan-200">{imageInfo}</p><p className="mt-2 text-xs leading-5 text-[var(--text-muted)]">{multiMode ? 'Every original file byte is preserved. The photo is split across multiple QR parts and reconstructed byte-for-byte by the scanner. No server or upload is required.' : 'The photo is prepared on your device to fit into one QR code when possible. Nothing is uploaded.'}</p></div></div>
      {multiPlan && (
        <div className="mt-4 rounded-2xl border border-cyan-300/20 bg-black/10 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs font-bold text-[var(--text)]">
            <span>Part {multiIndex} / {multiPlan.total}</span>
            <button
              type="button"
              disabled={!multiQr}
              onClick={() => {
                const a = document.createElement('a');
                a.href = multiQr;
                a.download = `photo-qr-${String(multiIndex).padStart(5, '0')}.png`;
                a.click();
              }}
              className="inline-flex items-center gap-1 rounded-full bg-white px-3 py-2 text-slate-950 disabled:opacity-50"
            >
              <Download size={13}/> Save part
            </button>
          </div>
          {multiQr && <img src={multiQr} alt={`Large photo frame ${multiIndex} of ${multiPlan.total}`} className="mx-auto mt-4 max-h-[520px] w-full max-w-[720px] rounded-xl object-contain bg-white p-3" />}
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
            <button type="button" disabled={multiIndex <= 1} onClick={() => { setMultiPlaying(false); setMultiIndex(current => Math.max(1, current - 1)); }} className="rounded-full bg-white/10 px-4 py-2 text-xs font-bold disabled:opacity-40">Previous</button>
            <button type="button" disabled={multiPlan.total < 2} onClick={() => setMultiPlaying(current => !current)} className="inline-flex items-center gap-1 rounded-full bg-cyan-300 px-4 py-2 text-xs font-black text-slate-950">
              {multiPlaying ? <Pause size={13}/> : <Play size={13}/>} {multiPlaying ? 'Pause' : 'Play'}
            </button>
            <button type="button" disabled={multiIndex >= multiPlan.total} onClick={() => { setMultiPlaying(false); setMultiIndex(current => Math.min(multiPlan.total, current + 1)); }} className="rounded-full bg-white/10 px-4 py-2 text-xs font-bold disabled:opacity-40">Next</button>
            <label className="inline-flex items-center gap-2 text-[11px] text-[var(--text-muted)]">
              <span>Speed</span>
              <select value={multiInterval} onChange={event => setMultiInterval(Number(event.target.value))} className="rounded-full border border-white/10 bg-black/10 px-3 py-1.5">
                <option value="700">700ms</option>
                <option value="1000">1 sec</option>
                <option value="1300">1.3 sec</option>
                <option value="1600">1.6 sec</option>
              </select>
            </label>
          </div>
          <p className="mt-3 text-center text-[11px] leading-5 text-[var(--text-muted)]">The QR parts are shown one after another. Slower speeds can help another camera read them more easily.</p>
        </div>
      )}

      <div className="mt-4 flex gap-2"><GlassButton type="button" onClick={() => inputRef.current?.click()} disabled={encoding}><ImagePlus size={14}/> Choose another photo</GlassButton><GlassButton type="button" onClick={reset}><RotateCcw size={14}/> Reset</GlassButton></div>
    </div> : <div className="space-y-2.5">
      <div className="flex items-center justify-between"><label className="text-xs font-bold uppercase tracking-[.18em] text-[var(--text-muted)]">Text or link</label><span className="text-xs text-[var(--text-muted)]">{settings.value.length} chars</span></div>
      <textarea rows={6} value={settings.value} onChange={e=>setSettings(prev=>({...prev,value:e.target.value}))} placeholder="https://example.com" className="w-full resize-y rounded-[24px] border border-white/10 bg-black/10 px-4 py-4 text-sm leading-7 text-[var(--text)] outline-none placeholder:text-[var(--text-muted)]/60 focus:border-cyan-300/35" />
      {!isValid && <p className="text-sm text-rose-300">Enter some text or a link to create your QR code.</p>}
    </div>}

    {error && <p className="rounded-2xl border border-rose-300/20 bg-rose-400/10 p-3 text-sm text-rose-200">{error}</p>}
    <div className="grid gap-4 sm:grid-cols-2">
      <div className="rounded-2xl border border-white/8 bg-white/[.035] p-4"><div className="flex justify-between text-xs font-semibold text-[var(--text-muted)]"><span>QR size</span><span>{settings.size}px</span></div><input type="range" min="128" max="1024" value={settings.size} onChange={e=>setSettings(prev=>({...prev,size:Number(e.target.value)}))} className="mt-4 w-full accent-cyan-300"/></div>
      <div className="rounded-2xl border border-white/8 bg-white/[.035] p-4"><label className="text-xs font-semibold text-[var(--text-muted)]">Readability</label><select value={settings.errorCorrectionLevel} onChange={e=>setSettings(prev=>({...prev,errorCorrectionLevel:e.target.value as 'L'|'M'|'Q'|'H'}))} className="mt-3 w-full rounded-xl border border-white/10 bg-black/10 px-3 py-2.5 text-sm text-[var(--text)]"><option value="L">Low</option><option value="M">Medium</option><option value="Q">High</option><option value="H">Very high</option></select></div>
    </div>
    <div className="generator-primary-actions flex flex-wrap gap-3"><GlassButton type="button" className="bg-white text-slate-950 shadow-xl" disabled={!isValid || encoding}>Create QR code</GlassButton><GlassButton type="button" onClick={reset}><RotateCcw size={14}/> Reset</GlassButton></div>
  </div>;
}
