import { motion } from 'framer-motion';
import { Link } from 'react-router-dom';
import { ArrowLeft, Sparkles } from 'lucide-react';
import { GlassCard } from '../../components/ui/GlassCard';
import { GeneratorForm } from '../../components/generator/GeneratorForm';
import { QRPreview } from '../../components/generator/QRPreview';
import { GeneratorProvider } from '../../components/generator/GeneratorContext';
import { QRCodeActions } from '../../components/generator/QRCodeActions';
import { GeneratorControls } from '../../components/generator/GeneratorControls';

export function Generator() {
  return (
    <GeneratorProvider>
      <section className="generator-page mx-auto max-w-7xl py-8 sm:py-12">
        <motion.div initial={{opacity:0,y:12}} animate={{opacity:1,y:0}} className="mb-7 flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
          <div className="space-y-4">
            <Link to="/" className="inline-flex items-center gap-2 text-xs font-semibold text-[var(--text-muted)] hover:text-[var(--text)]"><ArrowLeft size={14}/> Back home</Link>
            <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-[.22em] text-cyan-300"><Sparkles size={14}/> QR code maker</div>
            <h1 className="max-w-3xl text-4xl font-black tracking-[-.04em] text-[var(--text)] sm:text-6xl">Make a QR code <span className="text-gradient">in seconds.</span></h1>
            <p className="max-w-2xl text-sm leading-7 text-[var(--text-muted)] sm:text-base">Enter what you want to share, preview the QR code, and save it as an image.</p>
          </div>
          <div className="glass-soft hidden rounded-2xl px-4 py-3 text-right sm:block"><p className="text-[10px] uppercase tracking-[.2em] text-[var(--text-muted)]">Your device</p><p className="mt-1 text-sm font-bold text-[var(--text)]">Saved locally · No account</p></div>
        </motion.div>

        <div className="grid gap-5 lg:grid-cols-[1fr_.86fr] lg:items-start">
          <div className="space-y-5">
            <GlassCard><GeneratorForm /></GlassCard>
            <GlassCard><GeneratorControls /></GlassCard>
          </div>
          <div className="space-y-5 lg:sticky lg:top-24">
            <GlassCard><QRPreview /></GlassCard>
            <GlassCard><QRCodeActions /></GlassCard>
          </div>
        </div>
      </section>
    </GeneratorProvider>
  );
}