import { BarChart3, Home, MoonStar, QrCode, ScanLine, Settings2, SunMedium, Wrench, Zap } from 'lucide-react';
import { Link, useLocation } from 'react-router-dom';
import { motion } from 'framer-motion';
import { GlassButton } from '../ui/GlassButton';
import { InstallPWAButton } from '../ui/InstallPWAButton';
import { useTheme } from '../providers/ThemeProvider';

const links = [
  { to: '/', label: 'Home', icon: Home },
  { to: '/generator', label: 'Create', icon: QrCode },
  { to: '/scanner', label: 'Scan', icon: ScanLine },
  { to: '/tools', label: 'More', icon: Wrench },
  { to: '/transfer', label: 'Send files', icon: Zap },
  { to: '/history', label: 'Saved', icon: BarChart3 },
  { to: '/statistics', label: 'Activity', icon: BarChart3 },
  { to: '/settings', label: 'Settings', icon: Settings2 },
];

const mobileLinks = [
  { to: '/', label: 'Home', icon: Home },
  { to: '/generator', label: 'Create', icon: QrCode },
  { to: '/scanner', label: 'Scan', icon: ScanLine },
  { to: '/tools', label: 'More', icon: Wrench },
  { to: '/transfer', label: 'Send files', icon: Zap },
];

export function Navbar() {
  const location = useLocation();
  const { theme, setTheme } = useTheme();

  return (
    <>
      <header className="sticky top-2 z-50 mx-auto hidden w-[calc(100%-1.5rem)] max-w-7xl md:block">
        <nav className="glass-panel rounded-[26px] p-2">
          <div className="flex items-center gap-2">
            <Link to="/" className="group flex shrink-0 items-center gap-2.5 rounded-full px-2 py-1.5">
              <span className="relative grid h-10 w-10 place-items-center overflow-hidden rounded-[15px] bg-gradient-to-br from-cyan-300 via-indigo-500 to-violet-600 text-white shadow-lg shadow-indigo-500/25">
                <span className="absolute inset-0 bg-white/15" />
                <QrCode size={19} className="relative" />
              </span>
              <span>
                <span className="block text-sm font-bold tracking-tight text-[var(--text)]">OptiCode Studio</span>
                <span className="block text-[10px] font-medium uppercase tracking-[.2em] text-[var(--text-muted)]">QR · Barcode · File sharing</span>
              </span>
            </Link>

            <div className="mx-auto flex min-w-0 flex-1 items-center justify-center gap-1 overflow-x-auto px-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              {links.map(({ to, label, icon: Icon }) => {
                const active = location.pathname === to;
                return (
                  <Link key={to} to={to}
                    className="relative shrink-0 rounded-full px-3 py-2 text-xs font-semibold lg:px-4 lg:text-sm">
                    {active && <motion.span layoutId="desktop-nav-active" className="absolute inset-0 rounded-full bg-[var(--nav-active)] shadow-md shadow-black/10 ring-1 ring-[var(--nav-active-border)]" transition={{ type: 'tween', duration: 0.36, ease: [0.22, 1, 0.36, 1] }} />}
                    <span className={`relative z-10 inline-flex items-center gap-1.5 ${active ? 'text-[var(--nav-active-text)]' : 'text-[var(--text-muted)] hover:text-[var(--text)]'}`}><Icon size={14} />{label}</span>
                  </Link>
                );
              })}
            </div>

            <InstallPWAButton />
            <GlassButton aria-label="Toggle theme" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} className="h-10 w-10 shrink-0 p-0">
              {theme === 'dark' ? <SunMedium size={16} /> : <MoonStar size={16} />}
            </GlassButton>
          </div>
        </nav>
      </header>

      <header className="safe-top sticky top-0 z-50 px-3 pt-2 md:hidden">
        <div className="glass-panel flex h-14 items-center justify-between rounded-[20px] px-2.5">
          <Link to="/" className="flex min-w-0 items-center gap-2">
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-[13px] bg-gradient-to-br from-cyan-300 via-indigo-500 to-violet-600 text-white shadow-lg shadow-indigo-500/20">
              <QrCode size={17} />
            </span>
            <span className="min-w-0">
              <span className="block truncate text-sm font-black tracking-tight text-[var(--text)]">OptiCode</span>
              <span className="block truncate text-[9px] font-semibold uppercase tracking-[.14em] text-[var(--text-muted)]">Studio</span>
            </span>
          </Link>
          <div className="flex items-center gap-1">
            <InstallPWAButton />
            <GlassButton aria-label="Toggle theme" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} className="h-9 w-9 shrink-0 p-0">
              {theme === 'dark' ? <SunMedium size={15} /> : <MoonStar size={15} />}
            </GlassButton>
          </div>
        </div>
      </header>

      <nav className="mobile-bottom-nav fixed inset-x-2 bottom-2 z-[60] md:hidden" aria-label="Primary">
        <div className="glass-panel relative mx-auto grid max-w-md grid-cols-5 rounded-[24px] p-1.5 shadow-2xl">
          {mobileLinks.map(({ to, label, icon: Icon }) => {
            const active = location.pathname === to;
            return (
              <Link
                key={to}
                to={to}
                aria-current={active ? 'page' : undefined}
                className="relative z-10 flex min-w-0 flex-col items-center justify-center gap-1 rounded-[18px] px-1 py-2 text-[9px] font-bold"
              >
                {active && (
                  <motion.span
                    layoutId="mobile-nav-glass-pill"
                    className="absolute inset-0 rounded-[18px] bg-white shadow-[0_8px_24px_rgba(0,0,0,.18)]"
                    transition={{
                      type: 'tween',
                      duration: 0.42,
                      ease: [0.22, 1, 0.36, 1],
                    }}
                  />
                )}
                <motion.span
                  className={`relative z-10 ${active ? 'text-[var(--nav-active-text)]' : 'text-[var(--text-muted)]'}`}
                  animate={{ scale: active ? 1.08 : 1, y: active ? -1 : 0 }}
                  transition={{ type: 'tween', duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
                >
                  <Icon size={18} strokeWidth={active ? 2.7 : 2} />
                </motion.span>
                <span className={`relative z-10 max-w-full truncate ${active ? 'text-slate-950' : 'text-[var(--text-muted)]'}`}>
                  {label}
                </span>
              </Link>
            );
          })}
        </div>
      </nav>    </>
  );
}
