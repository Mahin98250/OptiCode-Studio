import { useRef, useState } from 'react';
import { Database, Download, HardDrive, MoonStar, ShieldCheck, Trash2, Upload } from 'lucide-react';
import { GlassCard } from '../../components/ui/GlassCard';
import { GlassButton } from '../../components/ui/GlassButton';
import { useTheme } from '../../components/providers/ThemeProvider';
import { clearHistory, exportHistory, getHistory, getStorageUsageBytes, importHistory } from '../../lib/storage';

export function Settings() {
  const { theme, setTheme } = useTheme();
  const [notice, setNotice] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);
  const items = getHistory();
  const usage = getStorageUsageBytes();

  function downloadBackup() {
    const blob = new Blob([exportHistory()], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `opticode-studio-library-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    setNotice('Backup saved.');
  }

  async function restore(file: File) {
    try {
      const result = importHistory(await file.text());
      setNotice(`Restored ${result.imported} new item${result.imported === 1 ? '' : 's'}.`);
    } catch {
      setNotice('Backup could not be restored. Choose an OptiCode Studio JSON backup.');
    }
  }

  function clear() {
    if (!window.confirm('Clear every saved scan from this device? This cannot be undone unless you have a backup.')) return;
    clearHistory();
    setNotice('All saved scans were deleted.');
  }

  return (
    <section className="settings-page mx-auto max-w-4xl py-8 sm:py-10">
      <div className="mb-7">
        <h1 className="text-3xl font-semibold tracking-tight text-[var(--text)] sm:text-5xl">Settings</h1>
        <p className="mt-3 text-sm leading-7 text-[var(--text-muted)] sm:text-base">Simple controls for appearance, saved scans, backups, and privacy.</p>
      </div>

      {notice && <div className="mb-5 rounded-2xl border border-cyan-300/20 bg-cyan-300/10 px-4 py-3 text-sm font-semibold text-cyan-100">{notice}</div>}

      <div className="space-y-5">
        <GlassCard>
          <div className="flex items-start gap-3">
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-2xl bg-cyan-300/10 text-cyan-300"><MoonStar size={18} /></span>
            <div className="flex-1">
              <h2 className="font-bold text-[var(--text)]">Appearance</h2>
              <p className="mt-1 text-sm text-[var(--text-muted)]">Choose how the interface follows your device.</p>
              <select value={theme} onChange={(event) => setTheme(event.target.value as 'light' | 'dark' | 'system')} className="mt-4 w-full rounded-[18px] border border-[var(--border)] bg-[var(--bg-soft)] px-4 py-3 text-sm text-[var(--text)] outline-none">
                <option value="system">System</option>
                <option value="dark">Dark</option>
                <option value="light">Light</option>
              </select>
            </div>
          </div>
        </GlassCard>

        <GlassCard>
          <div className="flex items-start gap-3">
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-2xl bg-cyan-300/10 text-cyan-300"><Database size={18} /></span>
            <div className="flex-1">
              <h2 className="font-bold text-[var(--text)]">Saved</h2>
              <p className="mt-1 text-sm text-[var(--text-muted)]">Saved only on this device. No account is required.</p>
              <div className="mt-4 grid grid-cols-2 gap-3">
                <div className="rounded-2xl border border-[var(--border)] bg-[var(--bg-soft)] p-4"><p className="text-[10px] font-bold uppercase tracking-[.15em] text-[var(--text-muted)]">Saved</p><p className="mt-1 text-xl font-black text-[var(--text)]">{items.length}</p></div>
                <div className="rounded-2xl border border-[var(--border)] bg-[var(--bg-soft)] p-4"><p className="text-[10px] font-bold uppercase tracking-[.15em] text-[var(--text-muted)]">Space used</p><p className="mt-1 text-xl font-black text-[var(--text)]">{usage < 1024 ? usage + ' B' : (usage / 1024).toFixed(1) + ' KB'}</p></div>
              </div>
            </div>
          </div>
        </GlassCard>

        <GlassCard>
          <div className="flex items-start gap-3">
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-2xl bg-cyan-300/10 text-cyan-300"><HardDrive size={18} /></span>
            <div className="flex-1">
              <h2 className="font-bold text-[var(--text)]">Backup and restore</h2>
              <p className="mt-1 text-sm text-[var(--text-muted)]">Save a backup of your scans, or restore one on another device.</p>
              <div className="mt-4 flex flex-wrap gap-2">
                <GlassButton onClick={downloadBackup}><Download size={14} /> Save backup</GlassButton>
                <GlassButton onClick={() => inputRef.current?.click()}><Upload size={14} /> Restore backup</GlassButton>
                <input ref={inputRef} type="file" accept="application/json,.json" className="sr-only" onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void restore(file);
                  event.currentTarget.value = '';
                }} />
              </div>
            </div>
          </div>
        </GlassCard>

        <GlassCard>
          <div className="flex items-start gap-3">
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-2xl bg-emerald-400/10 text-emerald-300"><ShieldCheck size={18} /></span>
            <div>
              <h2 className="font-bold text-[var(--text)]">Privacy</h2>
              <p className="mt-1 text-sm leading-6 text-[var(--text-muted)]">Your camera images, QR data, and saved scans stay on this device. If you choose to open a website, call, email, map, or payment link, that action leaves the app.</p>
            </div>
          </div>
        </GlassCard>

        <GlassCard>
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="font-bold text-[var(--text)]">Delete saved scans</h2>
              <p className="mt-1 text-sm text-[var(--text-muted)]">Delete all saved scans from this device.</p>
            </div>
            <GlassButton type="button" onClick={clear}><Trash2 size={14} /> Delete all scans</GlassButton>
          </div>
        </GlassCard>
      </div>
    </section>
  );
}
