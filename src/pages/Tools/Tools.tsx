import { useMemo, useState } from 'react';
import {
  BarChart3,
  CheckCircle2,
  Clipboard,
  Copy,
  Database,
  Download,
  FlaskConical,
  QrCode,
  Heart,
  History as HistoryIcon,
  Layers3,
  MoonStar,
  Search,
  ScanBarcode,
  ScanLine,
  Settings2,
  ShieldCheck,
  Sparkles,
  Upload,
  XCircle,
  Zap,
  Binary,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { GlassCard } from '../../components/ui/GlassCard';
import { GlassButton } from '../../components/ui/GlassButton';
import { runProtocolDiagnostics, type ProtocolDiagnosticResult } from '../../lib/protocolSelfTest';

type Detected = { type: string; valid: boolean | null; clean: string; message: string };

function checkDigit(code: string) {
  const body = code.slice(0, -1).split('').reverse().map(Number);
  const sum = body.reduce((total, digit, index) => total + digit * (index % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10;
}

function isbn10Valid(code: string) {
  const chars = code.toUpperCase().replace(/[-\s]/g, '');
  if (!/^\d{9}[\dX]$/.test(chars)) return false;
  const sum = chars.split('').reduce((total, char, index) => total + (char === 'X' ? 10 : Number(char)) * (10 - index), 0);
  return sum % 11 === 0;
}

function detect(input: string): Detected {
  const clean = input.toUpperCase().replace(/[-\s]/g, '');
  if (!clean) return { type: 'Waiting for input', valid: null, clean, message: 'Paste a barcode, ISBN or product code to inspect it locally.' };
  if (/^97[89]\d{10}$/.test(clean)) {
    const valid = checkDigit(clean) === Number(clean.at(-1));
    return { type: 'ISBN-13 / EAN-13', valid, clean, message: valid ? 'Check digit matches.' : 'Check digit does not match.' };
  }
  if (/^\d{12}$/.test(clean)) {
    const valid = checkDigit(clean) === Number(clean.at(-1));
    return { type: 'UPC-A', valid, clean, message: valid ? 'Check digit matches.' : 'Check digit does not match.' };
  }
  if (/^\d{8}$/.test(clean)) {
    const valid = checkDigit(clean) === Number(clean.at(-1));
    return { type: 'EAN-8', valid, clean, message: valid ? 'Check digit matches.' : 'Check digit does not match.' };
  }
  if (/^\d{9}[\dX]$/.test(clean)) {
    const valid = isbn10Valid(clean);
    return { type: 'ISBN-10', valid, clean, message: valid ? 'ISBN-10 checksum matches.' : 'ISBN-10 checksum does not match.' };
  }
  if (/^\d{13}$/.test(clean)) return { type: '13-digit code', valid: null, clean, message: 'Numeric code detected; no single standard is assumed.' };
  if (/^[A-Z0-9._\-]{4,80}$/.test(clean)) return { type: 'Alphanumeric code', valid: null, clean, message: 'Code detected; format is not assumed.' };
  return { type: 'Text / unknown', valid: null, clean, message: 'This does not look like a common product-code format.' };
}

const tools = [
  { to: '/generator', icon: QrCode, eyebrow: 'Create', title: 'QR Code Generator', text: 'Create QR codes from text and links, tune size/ECC, and export PNG, SVG or JPEG.', badge: 'Core' },
  { to: '/generator', icon: Layers3, eyebrow: 'Create', title: 'Photo → QR + Multi-QR', text: 'Encode a photo into one QR when it fits or split the original bytes across lossless Multi-QR frames.', badge: 'Advanced' },
  { to: '/scanner', icon: ScanLine, eyebrow: 'Scan', title: 'QR + Barcode Scanner', text: 'Use the camera or images for QR, EAN, UPC, Code 128/39, Data Matrix, PDF417 and more.', badge: 'Core' },
  { to: '/transfer', icon: Zap, eyebrow: 'Transfer', title: 'Optical File Transfer', text: 'Send files screen-to-camera with four QR lanes, fountain recovery and an on-device benchmark.', badge: 'OR Transfer 2.0' },
  { to: '/optiframe', icon: Binary, eyebrow: 'Experimental', title: 'OptiFrame Lab', text: 'Test a custom 2-bit optical symbol surface beyond QR with metadata and CRC-32.', badge: 'Phase 2' },
  { to: '/tools', icon: ScanBarcode, eyebrow: 'Inspect', title: 'Check a product code', text: 'Normalize UPC/EAN/ISBN values and verify check digits locally without a product database.', badge: 'Local' },
  { to: '/history', icon: HistoryIcon, eyebrow: 'Organize', title: 'Scan Library', text: 'Search, tag, favorite, copy, open and back up your local scan history.', badge: 'Private' },
  { to: '/statistics', icon: BarChart3, eyebrow: 'Analyze', title: 'Scan Analytics', text: 'See scan totals, barcode/QR mix, favorites, activity and tag collections.', badge: 'Private' },
  { to: '/settings', icon: Database, eyebrow: 'Manage', title: 'Backup & Restore', text: 'Export your local library as JSON and restore it on another device.', badge: 'Portable' },
  { to: '/settings', icon: MoonStar, eyebrow: 'Personalize', title: 'Theme & Privacy', text: 'Switch light/dark/system appearance and review the local-only data model.', badge: 'Device' },
];

export function Tools() {
  const [value, setValue] = useState('');
  const result = useMemo(() => detect(value), [value]);
  const [diagnosticRunning, setDiagnosticRunning] = useState(false);
  const [diagnostics, setDiagnostics] = useState<ProtocolDiagnosticResult[]>([]);

  async function runDiagnostics() {
    setDiagnosticRunning(true);
    try {
      setDiagnostics(await runProtocolDiagnostics());
    } finally {
      setDiagnosticRunning(false);
    }
  }

  async function copy() {
    if (!result.clean || !navigator.clipboard) return;
    await navigator.clipboard.writeText(result.clean);
  }

  function openSearch(engine: 'google' | 'shopping') {
    if (!result.clean) return;
    const base = engine === 'shopping'
      ? 'https://www.google.com/search?tbm=shop&q='
      : 'https://www.google.com/search?q=';
    window.open(base + encodeURIComponent(result.clean), '_blank', 'noopener,noreferrer');
  }

  return (
    <section className="tools-page mx-auto max-w-6xl py-8 sm:py-12">
      <div className="relative overflow-hidden rounded-[34px] border border-[var(--border)] bg-[var(--bg-elevated)] p-6 shadow-glass backdrop-blur-2xl sm:p-10">
        <div className="pointer-events-none absolute -right-24 -top-24 h-72 w-72 rounded-full bg-cyan-400/15 blur-3xl" />
        <div className="pointer-events-none absolute -left-24 bottom-[-120px] h-72 w-72 rounded-full bg-violet-500/15 blur-3xl" />
        <div className="relative">
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-2 rounded-full border border-cyan-300/20 bg-cyan-300/10 px-3 py-1.5 text-[10px] font-bold uppercase tracking-[.18em] text-cyan-300">
              <Sparkles size={12} /> Everything in one place
            </span>
            <span className="inline-flex items-center gap-2 rounded-full border border-[var(--border)] bg-[var(--bg-soft)] px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[.15em] text-[var(--text-muted)]">
              <ShieldCheck size={12} /> Stays on this device
            </span>
          </div>
          <h1 className="mt-5 max-w-4xl text-4xl font-black tracking-[-.045em] text-[var(--text)] sm:text-6xl">
            All your tools, <span className="text-gradient">in one place.</span>
          </h1>
          <p className="mt-4 max-w-3xl text-sm leading-7 text-[var(--text-muted)] sm:text-base">
            Create, scan, share files, and manage your saved scans from one simple app.
          </p>
          <div className="mt-6 grid gap-3 sm:grid-cols-3">
            <Link to="/generator" className="group rounded-[22px] border border-cyan-300/20 bg-cyan-300/10 p-4 transition hover:-translate-y-0.5 hover:bg-cyan-300/15">
              <QrCode className="text-cyan-300" size={20} />
              <p className="mt-3 font-bold text-[var(--text)]">Create</p>
              <p className="mt-1 text-xs leading-5 text-[var(--text-muted)]">QR codes and photos</p>
            </Link>
            <Link to="/scanner" className="group rounded-[22px] border border-emerald-300/20 bg-emerald-400/10 p-4 transition hover:-translate-y-0.5 hover:bg-emerald-400/15">
              <ScanLine className="text-emerald-300" size={20} />
              <p className="mt-3 font-bold text-[var(--text)]">Scan</p>
              <p className="mt-1 text-xs leading-5 text-[var(--text-muted)]">QR codes and barcodes</p>
            </Link>
            <Link to="/transfer" className="group rounded-[22px] border border-violet-300/20 bg-violet-400/10 p-4 transition hover:-translate-y-0.5 hover:bg-violet-400/15">
              <Zap className="text-violet-300" size={20} />
              <p className="mt-3 font-bold text-[var(--text)]">Transfer</p>
              <p className="mt-1 text-xs leading-5 text-[var(--text-muted)]">Share files without internet</p>
            </Link>
          </div>
        </div>
      </div>

      <div className="mt-6">
        <div className="mb-3 flex items-end justify-between gap-3">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[.18em] text-cyan-300">Toolbox</p>
            <h2 className="mt-1 text-2xl font-black tracking-tight text-[var(--text)]">All tools</h2>
          </div>
          <p className="hidden text-xs text-[var(--text-muted)] sm:block">{tools.length} tools</p>
        </div>
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
          {tools.map(({ to, icon: Icon, eyebrow, title, text: description, badge }) => (
            <Link
              key={title}
              to={to}
              onClick={(event) => {
                if (title === 'Check a product code') {
                  event.preventDefault();
                  document.getElementById('barcode-lab')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                }
              }}
              className="group"
            >
              <GlassCard>
                <div className="flex items-start gap-4">
                  <span className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-gradient-to-br from-cyan-300/15 to-indigo-500/15 text-cyan-300 transition group-hover:scale-105">
                    <Icon size={19} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-[9px] font-black uppercase tracking-[.16em] text-[var(--text-muted)]">{eyebrow}</p>
                      <span className="rounded-full border border-[var(--border)] bg-[var(--bg-soft)] px-2 py-0.5 text-[9px] font-bold uppercase tracking-[.1em] text-[var(--text-muted)]">{badge}</span>
                    </div>
                    <h3 className="mt-1 font-bold text-[var(--text)] group-hover:text-cyan-700 dark:group-hover:text-cyan-300">{title}</h3>
                    <p className="mt-1.5 text-xs leading-5 text-[var(--text-muted)]">{description}</p>
                  </div>
                </div>
              </GlassCard>
            </Link>
          ))}
        </div>
      </div>

      <div id="barcode-lab" className="mt-6 scroll-mt-24">
        <GlassCard>
          <div className="flex items-start gap-3">
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-2xl bg-cyan-300/10 text-cyan-300"><ScanBarcode size={18} /></span>
            <div className="min-w-0">
              <p className="text-[10px] font-bold uppercase tracking-[.16em] text-cyan-300">Code checker</p>
              <h2 className="mt-1 text-xl font-black text-[var(--text)]">Check a product code</h2>
              <p className="mt-1 text-sm leading-6 text-[var(--text-muted)]">Paste a product code or ISBN to check whether its number looks correct. This does not look up product details.</p>
            </div>
          </div>

          <textarea
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder="e.g. 8901234567890"
            className="mt-5 min-h-28 w-full resize-none rounded-[22px] border border-[var(--border)] bg-[var(--bg-soft)] p-4 text-sm text-[var(--text)] outline-none placeholder:text-[var(--text-muted)] focus:border-cyan-300/35"
          />
          <div className="mt-3 flex flex-wrap gap-2">
            <GlassButton onClick={() => void copy()} disabled={!result.clean}><Copy size={14} /> Copy</GlassButton>
            <GlassButton onClick={() => openSearch('google')} disabled={!result.clean}><Search size={14} /> Search online</GlassButton>
            <GlassButton onClick={() => openSearch('shopping')} disabled={!result.clean}><Search size={14} /> Shopping</GlassButton>
            <Link to="/scanner" className="inline-flex min-h-10 items-center justify-center gap-2 rounded-full border border-[var(--border)] bg-[var(--bg-elevated)] px-4 py-2 text-sm font-medium text-[var(--text)] transition hover:bg-white/10">
              <ScanLine size={14} /> Scan in camera
            </Link>
          </div>

          <div className="mt-5 grid gap-3 lg:grid-cols-[1fr_1fr]">
            <div className="rounded-[22px] border border-[var(--border)] bg-[var(--bg-soft)] p-4">
              <p className="text-[10px] font-bold uppercase tracking-[.14em] text-[var(--text-muted)]">Result</p>
              <div className="mt-3 flex items-center gap-3">
                {result.valid === true ? <CheckCircle2 className="text-emerald-300" /> : result.valid === false ? <XCircle className="text-rose-300" /> : <ScanBarcode className="text-cyan-300" />}
                <div>
                  <p className="font-bold text-[var(--text)]">{result.type}</p>
                  <p className="mt-1 text-xs leading-5 text-[var(--text-muted)]">{result.message}</p>
                </div>
              </div>
              <div className="mt-4 rounded-2xl border border-[var(--border)] bg-[var(--bg-elevated)] p-3">
                <p className="text-[10px] font-bold uppercase tracking-[.14em] text-[var(--text-muted)]">Cleaned code</p>
                <p className="mt-1 break-all font-mono text-sm text-[var(--text)]">{result.clean || '—'}</p>
              </div>
            </div>
            <div className="rounded-[22px] border border-[var(--border)] bg-[var(--bg-soft)] p-4">
              <div className="flex items-center gap-2">
                <Clipboard size={16} className="text-cyan-300" />
                <p className="font-bold text-[var(--text)]">What can be checked</p>
              </div>
              <p className="mt-2 text-xs leading-5 text-[var(--text-muted)]">Common product numbers and ISBNs can be checked here. Other codes are shown without guessing whether they are valid.</p>
              <Link to="/scanner" className="mt-4 inline-flex items-center gap-2 rounded-full border border-[var(--border)] bg-[var(--bg-elevated)] px-4 py-2 text-xs font-bold text-[var(--text)] hover:bg-white/10">
                <ScanLine size={14} /> Open scanner
              </Link>
            </div>
          </div>
        </GlassCard>
      </div>

      <div className="mt-6">
        <GlassCard>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="flex items-start gap-3">
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-2xl bg-violet-300/10 text-violet-300"><FlaskConical size={18} /></span>
              <div>
                <p className="text-[10px] font-bold uppercase tracking-[.16em] text-violet-300">Advanced tools</p>
                <h2 className="mt-1 text-xl font-black text-[var(--text)]">System check</h2>
                <p className="mt-1 max-w-3xl text-sm leading-6 text-[var(--text-muted)]">This checks that the file-sharing system is working correctly. Most users do not need to use this.</p>
              </div>
            </div>
            <GlassButton onClick={() => void runDiagnostics()} disabled={diagnosticRunning}>
              <FlaskConical size={14} /> {diagnosticRunning ? 'Running…' : 'Run system check'}
            </GlassButton>
          </div>

          {diagnostics.length > 0 && (
            <div className="mt-5 space-y-2">
              <div className="flex items-center justify-between rounded-2xl border border-[var(--border)] bg-[var(--bg-soft)] px-4 py-3">
                <p className="text-xs font-bold uppercase tracking-[.14em] text-[var(--text-muted)]">Latest check</p>
                <p className={diagnostics.every((item) => item.passed) ? 'text-xs font-bold text-emerald-300' : 'text-xs font-bold text-rose-300'}>
                  {diagnostics.filter((item) => item.passed).length} / {diagnostics.length} passed
                </p>
              </div>
              {diagnostics.map((item) => (
                <div key={item.name} className="rounded-2xl border border-[var(--border)] bg-[var(--bg-soft)] px-4 py-3">
                  <div className="flex items-start gap-3">
                    {item.passed ? <CheckCircle2 size={17} className="mt-0.5 shrink-0 text-emerald-300" /> : <XCircle size={17} className="mt-0.5 shrink-0 text-rose-300" />}
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-baseline justify-between gap-2">
                        <p className="text-sm font-bold text-[var(--text)]">{item.name}</p>
                        <span className="text-[10px] font-semibold uppercase tracking-[.12em] text-[var(--text-muted)]">{item.durationMs} ms</span>
                      </div>
                      <p className="mt-1 break-words text-xs leading-5 text-[var(--text-muted)]">{item.detail}</p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </GlassCard>
      </div>

      <div className="mt-6 grid gap-3 sm:grid-cols-3">
        <Link to="/history" className="glass-soft rounded-[24px] p-5 hover:bg-white/10">
          <Heart size={18} className="text-pink-400" />
          <p className="mt-3 font-bold text-[var(--text)]">Saved scans</p>
          <p className="mt-1 text-xs leading-5 text-[var(--text-muted)]">Your saved scans, labels, and favorites stay on this device.</p>
        </Link>
        <Link to="/settings" className="glass-soft rounded-[24px] p-5 hover:bg-white/10">
          <Settings2 size={18} className="text-cyan-300" />
          <p className="mt-3 font-bold text-[var(--text)]">Settings</p>
          <p className="mt-1 text-xs leading-5 text-[var(--text-muted)]">Theme, backup, restore and privacy controls.</p>
        </Link>
        <Link to="/transfer" className="glass-soft rounded-[24px] p-5 hover:bg-white/10">
          <Zap size={18} className="text-violet-300" />
          <p className="mt-3 font-bold text-[var(--text)]">File sharing</p>
          <p className="mt-1 text-xs leading-5 text-[var(--text-muted)]">High-speed screen-to-camera file movement.</p>
        </Link>
      </div>
    </section>
  );
}
