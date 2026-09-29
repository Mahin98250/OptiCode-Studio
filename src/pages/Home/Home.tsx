import { ArrowRight, Camera, Check, Download, QrCode, ScanLine, ShieldCheck, Sparkles, Zap } from 'lucide-react';
import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { GlassCard } from '../../components/ui/GlassCard';

const features = [
  { icon: Zap, title: 'Create QR codes', text: 'Turn text, links, or photos into a QR code.' },
  { icon: ScanLine, title: 'Scan QR codes and barcodes', text: 'Use your camera or a photo to scan QR codes and barcodes.' },
  { icon: ShieldCheck, title: 'Private and on your device', text: 'Your saved scans and settings stay on this device.' },
];

export function Home() {
  return (
    <section className="home-page mx-auto max-w-6xl py-10 sm:py-16">
      <div className="relative overflow-hidden rounded-[36px] border border-white/10 bg-white/[.035] px-5 py-10 shadow-glass backdrop-blur-xl sm:px-10 sm:py-16">
        <div className="pointer-events-none absolute -left-20 -top-28 h-72 w-72 rounded-full bg-indigo-500/20 blur-3xl" />
        <div className="pointer-events-none absolute -right-20 top-10 h-72 w-72 rounded-full bg-cyan-400/15 blur-3xl" />

        <div className="relative grid items-center gap-10 lg:grid-cols-[1.05fr_.95fr]">
          <motion.div initial={{ opacity:0, y:18 }} animate={{ opacity:1, y:0 }} transition={{ duration:.55 }} className="space-y-7">
            <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/7 px-3 py-1.5 text-xs font-semibold text-[var(--text-muted)] backdrop-blur-xl">
              <Sparkles size={13} className="text-cyan-300" /> Private · Fast · Offline-friendly
            </div>
            <div className="space-y-5">
              <h1 className="max-w-3xl text-5xl font-black leading-[.98] tracking-[-.045em] text-[var(--text)] sm:text-7xl">
                Everything you need. <span className="text-gradient">In one place.</span>
              </h1>
              <p className="max-w-xl text-base leading-7 text-[var(--text-muted)] sm:text-lg">
                Create QR codes, scan codes, share files without internet, and keep your saved scans in one simple app.
              </p>
            </div>
            <div className="flex flex-wrap gap-3">
              <Link to="/generator" className="inline-flex h-12 items-center justify-center gap-2 rounded-full bg-white px-5 text-sm font-bold text-slate-950 shadow-xl shadow-black/20 transition hover:-translate-y-0.5">
                Create a QR <ArrowRight size={16} />
              </Link>
              <Link to="/scanner" className="glass-soft inline-flex h-12 items-center justify-center gap-2 rounded-full px-5 text-sm font-semibold text-[var(--text)] transition hover:bg-white/10">
                <Camera size={16} /> Scan
              </Link>
              <Link to="/tools" className="glass-soft inline-flex h-12 items-center justify-center gap-2 rounded-full px-5 text-sm font-semibold text-[var(--text)] transition hover:bg-white/10">
                <Sparkles size={16} /> All tools
              </Link>
            </div>
            <div className="flex flex-wrap gap-x-5 gap-y-2 text-xs font-medium text-[var(--text-muted)]">
              <span className="inline-flex items-center gap-1.5"><Check size={14} className="text-emerald-300" /> No account required</span>
              <span className="inline-flex items-center gap-1.5"><Check size={14} className="text-emerald-300" /> Local history</span>
              <span className="inline-flex items-center gap-1.5"><Check size={14} className="text-emerald-300" /> Save as PNG / SVG / JPEG</span>
            </div>
          </motion.div>

          <motion.div initial={{ opacity:0, scale:.96 }} animate={{ opacity:1, scale:1 }} transition={{ duration:.6, delay:.08 }} className="relative">
            <div className="absolute inset-8 rounded-[40px] bg-indigo-500/20 blur-3xl" />
            <GlassCard>
              <div className="relative rounded-[25px] border border-white/10 bg-white/[.035] p-4">
                <div className="mb-4 flex items-center justify-between">
                  <div>
                    <p className="text-xs font-bold uppercase tracking-[.2em] text-[var(--text-muted)]">Preview</p>
                    <p className="mt-1 text-sm font-semibold text-[var(--text)]">Your QR code</p>
                  </div>
                  <span className="grid h-9 w-9 place-items-center rounded-xl bg-white/8 text-cyan-300"><QrCode size={18} /></span>
                </div>
                <div className="grid aspect-square place-items-center rounded-[28px] bg-white p-7 shadow-2xl shadow-black/20">
                  <div className="grid aspect-square w-full place-items-center rounded-[10px] bg-[repeating-conic-gradient(#101426_0_25%,#fff_0_50%)_50%/18px_18px] p-3">
                    <div className="h-3/4 w-3/4 rounded-[4px] bg-white/95 shadow-[0_0_0_12px_white]" />
                  </div>
                </div>
                <div className="mt-4 grid grid-cols-3 gap-2 text-center text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                  <span className="glass-soft rounded-xl px-2 py-2">Fast</span><span className="glass-soft rounded-xl px-2 py-2">Private</span><span className="glass-soft rounded-xl px-2 py-2">Local</span>
                </div>
              </div>
            </GlassCard>
          </motion.div>
        </div>
      </div>

      <div className="mt-5 grid gap-4 md:grid-cols-3">
        {features.map(({ icon: Icon, title, text }) => (
          <GlassCard key={title}>
            <div className="flex gap-4">
              <span className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-gradient-to-br from-white/15 to-white/5 text-cyan-300"><Icon size={19} /></span>
              <div><h2 className="font-bold text-[var(--text)]">{title}</h2><p className="mt-1 text-sm leading-6 text-[var(--text-muted)]">{text}</p></div>
            </div>
          </GlassCard>
        ))}
      </div>

      <div className="mt-6 grid gap-4 sm:grid-cols-2">
        <GlassCard><div className="flex items-center gap-4"><Download className="text-violet-300" /><div><p className="font-semibold text-[var(--text)]">Easy to save</p><p className="text-sm text-[var(--text-muted)]">Save your QR code as an image in the format you need.</p></div></div></GlassCard>
        <GlassCard><div className="flex items-center gap-4"><ShieldCheck className="text-emerald-300" /><div><p className="font-semibold text-[var(--text)]">Your data stays on this device</p><p className="text-sm text-[var(--text-muted)]">Your saved scans and preferences stay on this device.</p></div></div></GlassCard>
      </div>
    </section>
  );
}