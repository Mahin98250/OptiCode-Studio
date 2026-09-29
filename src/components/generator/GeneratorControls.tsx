import { SlidersHorizontal } from 'lucide-react';
import { useGenerator } from './GeneratorContext';
import { GlassButton } from '../ui/GlassButton';

export function GeneratorControls() {
  const { settings, setSettings } = useGenerator();
  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3"><span className="grid h-10 w-10 place-items-center rounded-xl bg-white/7 text-violet-300"><SlidersHorizontal size={17}/></span><div><h2 className="font-bold text-[var(--text)]">Customize</h2><p className="text-xs text-[var(--text-muted)]">Change the look of your QR code if you want.</p></div></div>
      <div className="space-y-2"><label className="text-xs font-bold uppercase tracking-[.18em] text-[var(--text-muted)]">Quick settings</label><select value="custom" onChange={(e)=>{if(e.target.value==='url')setSettings(p=>({...p,value:'https://example.com'}));if(e.target.value==='text')setSettings(p=>({...p,value:'Hello from OptiCode Studio'}));}} className="w-full rounded-2xl border border-white/10 bg-black/10 px-4 py-3 text-sm text-[var(--text)] outline-none"><option value="custom">Your content</option><option value="url">Example URL</option><option value="text">Example text</option></select></div>
      <div className="rounded-2xl border border-white/8 bg-white/[.035] p-4"><div className="flex justify-between text-xs font-semibold text-[var(--text-muted)]"><span>Space around code</span><span>{settings.margin}</span></div><input aria-label="QR margin" type="range" min="0" max="8" value={settings.margin} onChange={(e)=>setSettings(p=>({...p,margin:Number(e.target.value)}))} className="mt-4 w-full accent-violet-300"/></div>
      <div className="flex flex-wrap gap-2"><GlassButton type="button" className="bg-white text-slate-950" onClick={()=>setSettings(p=>({...p,value:'https://example.com'}))}>Use example</GlassButton><GlassButton type="button" onClick={()=>setSettings(p=>({...p,value:''}))}>Clear</GlassButton></div>
    </div>
  );
}