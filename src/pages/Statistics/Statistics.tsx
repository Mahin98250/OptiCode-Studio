import { useEffect, useMemo, useState } from 'react';
import { BarChart3, CalendarDays, Heart, ScanBarcode, ScanLine, Sparkles, TrendingUp } from 'lucide-react';
import { GlassCard } from '../../components/ui/GlassCard';
import { GlassButton } from '../../components/ui/GlassButton';
import { getHistory, type HistoryItem } from '../../lib/storage';

export function Statistics() {
  const [items, setItems] = useState<HistoryItem[]>([]);
  useEffect(() => setItems(getHistory()), []);

  const stats = useMemo(() => {
    const byKind = new Map<string, number>();
    const byDay = new Map<string, number>();
    items.forEach((item) => {
      const kind = item.kind || (item.format?.toLowerCase().includes('qr') ? 'qr' : 'text');
      byKind.set(kind, (byKind.get(kind) || 0) + 1);
      const day = new Date(item.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
      byDay.set(day, (byDay.get(day) || 0) + 1);
    });
    return {
      total: items.length,
      qr: items.filter((item) => (item.format || '').toLowerCase().includes('qr')).length,
      barcode: items.filter((item) => item.kind === 'barcode').length,
      favorites: items.filter((item) => item.favorite).length,
      byKind: [...byKind.entries()].sort((a, b) => b[1] - a[1]),
      byDay: [...byDay.entries()].slice(0, 7),
    };
  }, [items]);

  const tagCounts = useMemo(() => {
    const counts = new Map<string, number>();
    items.forEach((item) => (item.tags || []).forEach((tag) => counts.set(tag, (counts.get(tag) || 0) + 1)));
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  }, [items]);
  const maxKind = Math.max(1, ...stats.byKind.map(([, count]) => count));
  const maxTag = Math.max(1, ...tagCounts.map(([, count]) => count));

  return (
    <section className="statistics-page mx-auto max-w-5xl py-8 sm:py-10">
      <div className="mb-7">
        <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-[var(--border)] bg-[var(--bg-soft)] px-3 py-1.5 text-[10px] font-bold uppercase tracking-[.16em] text-[var(--text-muted)]">
          <Sparkles size={12} className="text-cyan-300" /> Your activity
        </div>
        <h1 className="text-3xl font-semibold tracking-tight text-[var(--text)] sm:text-5xl">Scan activity</h1>
        <p className="mt-3 max-w-2xl text-sm leading-7 text-[var(--text-muted)] sm:text-base">
          A simple view of your saved scans. Nothing is uploaded to a server.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {([
          [ScanLine, 'Total scans', stats.total],
          [ScanBarcode, 'Barcodes', stats.barcode],
          [Heart, 'Favorites', stats.favorites],
          [TrendingUp, 'QR scans', stats.qr],
        ] as const).map(([Icon, label, value]) => (
          <div key={String(label)} className="glass-soft rounded-[24px] p-4">
            <Icon size={17} className="text-cyan-300" />
            <p className="mt-5 text-[10px] font-bold uppercase tracking-[.15em] text-[var(--text-muted)]">{String(label)}</p>
            <p className="mt-1 text-2xl font-black text-[var(--text)]">{String(value)}</p>
          </div>
        ))}
      </div>

      <div className="mt-5 grid gap-5 lg:grid-cols-2">
        <GlassCard>
          <div className="flex items-center gap-2">
            <BarChart3 size={18} className="text-cyan-300" />
            <div><h2 className="font-bold text-[var(--text)]">What you scan</h2><p className="text-xs text-[var(--text-muted)]">Your most common scan types</p></div>
          </div>
          <div className="mt-6 space-y-4">
            {stats.byKind.length === 0 ? (
              <p className="py-8 text-center text-sm text-[var(--text-muted)]">Scan something to start building your private analytics.</p>
            ) : stats.byKind.map(([kind, count]) => (
              <div key={kind}>
                <div className="mb-1.5 flex justify-between text-xs font-semibold">
                  <span className="capitalize text-[var(--text)]">{kind.replace('-', ' ')}</span>
                  <span className="text-[var(--text-muted)]">{count}</span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-[var(--bg-soft)]">
                  <div className="h-full rounded-full bg-gradient-to-r from-cyan-300 to-indigo-500" style={{ width: (count / maxKind) * 100 + '%' }} />
                </div>
              </div>
            ))}
          </div>
        </GlassCard>

        <GlassCard>
          <div className="flex items-center gap-2">
            <CalendarDays size={18} className="text-cyan-300" />
            <div><h2 className="font-bold text-[var(--text)]">Recent activity</h2><p className="text-xs text-[var(--text-muted)]">Last seven active days in your library</p></div>
          </div>
          <div className="mt-6 space-y-3">
            {stats.byDay.length === 0 ? (
              <p className="py-8 text-center text-sm text-[var(--text-muted)]">No scan activity yet.</p>
            ) : stats.byDay.map(([day, count]) => (
              <div key={day} className="flex items-center justify-between rounded-2xl border border-[var(--border)] bg-[var(--bg-soft)] px-4 py-3">
                <span className="text-sm font-semibold text-[var(--text)]">{day}</span>
                <span className="rounded-full bg-[var(--bg-elevated)] px-3 py-1 text-xs font-bold text-[var(--text-muted)]">{count} {count === 1 ? 'scan' : 'scans'}</span>
              </div>
            ))}
          </div>
        </GlassCard>
      </div>

      <div className="mt-5">
        <GlassCard>
          <div className="flex items-center gap-2"><BarChart3 size={18} className="text-cyan-300" /><div><h2 className="font-bold text-[var(--text)]">Saved labels</h2><p className="text-xs text-[var(--text-muted)]">Labels you use most often</p></div></div>
          <div className="mt-5 grid gap-3 sm:grid-cols-2">
            {tagCounts.length === 0 ? <p className="text-sm text-[var(--text-muted)]">Add labels to saved scans to group them.</p> : tagCounts.map(([tag, count]) => (
              <div key={tag} className="rounded-2xl border border-[var(--border)] bg-[var(--bg-soft)] p-3">
                <div className="flex justify-between text-xs font-semibold"><span className="text-[var(--text)]">#{tag}</span><span className="text-[var(--text-muted)]">{count}</span></div>
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-[var(--bg-soft)]"><div className="h-full rounded-full bg-gradient-to-r from-cyan-300 to-indigo-500" style={{ width: (count / maxTag) * 100 + '%' }} /></div>
              </div>
            ))}
          </div>
        </GlassCard>
      </div>

      <div className="mt-5 flex flex-wrap gap-3">
        <GlassButton onClick={() => window.location.hash = '#/scanner'}><ScanLine size={15} /> Scan now</GlassButton>
        <GlassButton onClick={() => window.location.hash = '#/history'}><BarChart3 size={15} /> Open library</GlassButton>
      </div>
    </section>
  );
}
