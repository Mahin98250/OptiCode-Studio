import { useState } from 'react';
import { CheckCircle2, CircleAlert, FlaskConical, Play, RotateCcw } from 'lucide-react';
import { Link } from 'react-router-dom';
import { GlassButton } from '../../components/ui/GlassButton';
import { GlassCard } from '../../components/ui/GlassCard';
import {
  runProtocolDiagnostics,
  type ProtocolDiagnosticProgress,
  type ProtocolDiagnosticResult,
} from '../../lib/protocolSelfTest';

export function Diagnostics() {
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<ProtocolDiagnosticResult[]>([]);
  const [progress, setProgress] = useState<ProtocolDiagnosticProgress | null>(null);

  async function run() {
    setRunning(true);
    setResults([]);
    setProgress(null);

    try {
      const finalResults = await runProtocolDiagnostics((update) => {
        setProgress(update);

        if (update.result) {
          setResults((current) => [...current, update.result!]);
        }
      });

      setResults(finalResults);
    } finally {
      setRunning(false);
    }
  }

  const passed = results.filter((result) => result.passed).length;
  const failed = results.length - passed;
  const total = progress?.total ?? 20;
  const completed = progress?.completed ?? results.length;
  const percent = total > 0 ? Math.round((completed / total) * 100) : 0;

  return (
    <section className="diagnostics-page mx-auto max-w-5xl py-8 sm:py-12">
      <Link to="/" className="text-xs font-semibold text-[var(--text-muted)]">Back home</Link>

      <div className="mt-5 rounded-[32px] border border-cyan-300/15 bg-[var(--bg-elevated)] p-6 shadow-glass backdrop-blur-2xl sm:p-9">
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-2 rounded-full border border-cyan-300/15 bg-cyan-300/10 px-3 py-1.5 text-xs font-bold uppercase tracking-[.16em] text-cyan-600 dark:text-cyan-200">
            <FlaskConical size={14} /> System check
          </span>

          {results.length > 0 && (
            <span
              className={
                failed === 0
                  ? 'rounded-full bg-emerald-400/10 px-3 py-1.5 text-xs font-bold text-emerald-600 dark:text-emerald-300'
                  : 'rounded-full bg-rose-400/10 px-3 py-1.5 text-xs font-bold text-rose-600 dark:text-rose-300'
              }
            >
              {passed}/{results.length} passed
            </span>
          )}
        </div>

        <h1 className="mt-5 text-4xl font-black tracking-[-.045em] sm:text-6xl">Check that file sharing is working.</h1>
        <p className="mt-4 max-w-3xl text-sm leading-7 text-[var(--text-muted)] sm:text-base">
          This checks the app's file-sharing features on this device. It does not upload your files.
        </p>

        {running && progress && (
          <div className="mt-6 rounded-[22px] border border-[var(--border)] bg-[var(--bg-elevated)] p-4" aria-live="polite">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-[10px] font-bold uppercase tracking-[.14em] text-[var(--text-muted)]">
                  Checking
                </p>
                <p className="mt-1 truncate text-sm font-bold text-[var(--text)]">{progress.current}</p>
              </div>
              <span className="shrink-0 text-sm font-black text-[var(--text)]">
                {completed}/{total}
              </span>
            </div>
            <div className="mt-3 h-2 overflow-hidden rounded-full bg-[var(--border)]">
              <div
                className="h-full rounded-full bg-gradient-to-r from-cyan-400 via-indigo-500 to-violet-500 transition-[width] duration-300 ease-out"
                style={{ width: percent + '%' }}
              />
            </div>
          </div>
        )}

        {!running && progress && completed > 0 && (
          <div className="mt-6 rounded-[22px] border border-emerald-400/15 bg-emerald-400/5 p-4">
            <div className="flex items-center gap-3">
              <CheckCircle2 size={19} className="shrink-0 text-emerald-600 dark:text-emerald-300" />
              <div>
                <p className="text-sm font-black text-[var(--text)]">Check complete</p>
                <p className="mt-0.5 text-xs text-[var(--text-muted)]">
                  {passed}/{total} passed · {failed} failed
                </p>
              </div>
            </div>
          </div>
        )}

        <div className="mt-6 flex flex-wrap gap-3">
          <GlassButton onClick={() => void run()} disabled={running}>
            {running ? <RotateCcw size={15} className="animate-spin" /> : <Play size={15} />}
            {running ? 'Checking…' : 'Run full check'}
          </GlassButton>

          <Link
            to="/transfer"
            className="inline-flex min-h-10 items-center rounded-full border border-[var(--border)] px-4 py-2 text-sm font-bold text-[var(--text)]"
          >
            Open file sharing
          </Link>
        </div>
      </div>

      <div className="mt-5 grid gap-3 sm:grid-cols-3">
        <div className="glass-soft rounded-[24px] p-4">
          <p className="text-[10px] font-bold uppercase tracking-[.14em] text-[var(--text-muted)]">Checks</p>
          <p className="mt-1 text-2xl font-black text-[var(--text)]">{results.length}</p>
        </div>
        <div className="glass-soft rounded-[24px] p-4">
          <p className="text-[10px] font-bold uppercase tracking-[.14em] text-[var(--text-muted)]">Passed</p>
          <p className="mt-1 text-2xl font-black text-emerald-600 dark:text-emerald-300">{passed}</p>
        </div>
        <div className="glass-soft rounded-[24px] p-4">
          <p className="text-[10px] font-bold uppercase tracking-[.14em] text-[var(--text-muted)]">Failed</p>
          <p className="mt-1 text-2xl font-black text-rose-600 dark:text-rose-300">{failed}</p>
        </div>
      </div>

      <div className="mt-5 space-y-3">
        {results.map((result) => (
          <GlassCard key={result.name}>
            <div className="flex items-start gap-3">
              {result.passed ? (
                <CheckCircle2 size={20} className="mt-0.5 shrink-0 text-emerald-600 dark:text-emerald-300" />
              ) : (
                <CircleAlert size={20} className="mt-0.5 shrink-0 text-rose-600 dark:text-rose-300" />
              )}

              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-bold text-[var(--text)]">{result.name}</p>
                  <span className="text-[10px] font-semibold text-[var(--text-muted)]">{result.durationMs} ms</span>
                </div>
                <p className="mt-1 text-xs leading-6 text-[var(--text-muted)]">{result.detail}</p>
              </div>
            </div>
          </GlassCard>
        ))}

        {results.length === 0 && !running && (
          <GlassCard>
            <div className="py-10 text-center">
              <FlaskConical size={28} className="mx-auto text-cyan-600 dark:text-cyan-300" />
              <p className="mt-3 text-sm font-bold text-[var(--text)]">No run yet</p>
              <p className="mt-1 text-xs text-[var(--text-muted)]">
                Run the check above to test the file-sharing system.
              </p>
            </div>
          </GlassCard>
        )}
      </div>
    </section>
  );
}
