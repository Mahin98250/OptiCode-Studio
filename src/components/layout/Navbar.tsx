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
  { to: '/', label: 'Home', icon: Home, tone: 'nav-tone-cyan' },
  { to: '/generator', label: 'Create', icon: QrCode, tone: 'nav-tone-amber' },
  { to: '/scanner', label: 'Scan', icon: ScanLine, tone: 'nav-tone-violet' },
  { to: '/tools', label: 'More', icon: Wrench, tone: 'nav-tone-blue' },
  { to: '/transfer', label: 'Send', icon: Zap, tone: 'nav-tone-rose' },
];

const capsuleTransition = {
  type: 'tween' as const,
  duration: 0.48,
  ease: [0.22, 1, 0.36, 1] as const,
};

const iconSpring = {
  type: 'spring' as const,
  stiffness: 250,
  damping: 29,
  mass: 0.9,
};

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
                  <Link
                    key={to}
                    to={to}
                    aria-current={active ? 'page' : undefined}
                    className="relative shrink-0 rounded-full px-3 py-2 text-xs font-semibold lg:px-4 lg:text-sm"
                  >
                    {active && (
                      <motion.span
                        layoutId="desktop-nav-fluid-pill"
                        className="nav-fluid-pill absolute inset-0 rounded-full bg-[var(--nav-active)] ring-1 ring-[var(--nav-active-border)]"
                        transition={capsuleTransition}
                      >
                        <span className="nav-fluid-pill-glow" />
                        <span className="nav-fluid-pill-specular" />
                      </motion.span>
                    )}
                    <motion.span
                      className={`relative z-10 inline-flex items-center gap-1.5 ${active ? 'text-[var(--nav-active-text)]' : 'text-[var(--text-muted)] hover:text-[var(--text)]'}`}
                      animate={{
                        scale: active ? 1.015 : 1,
                        y: active ? -0.15 : 0,
                      }}
                      transition={iconSpring}
                    >
                      <Icon size={14} />
                      {label}
                    </motion.span>
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

      <nav className="mobile-bottom-nav fixed inset-x-2 bottom-2 z-[60]" aria-label="Primary">
        <svg className="nav-liquid-svg" aria-hidden="true" focusable="false">
          <defs>
            <filter id="nav-liquid-refraction" x="-20%" y="-30%" width="140%" height="160%">
              <feTurbulence type="fractalNoise" baseFrequency="0.012 0.028" numOctaves="1" seed="17" result="navNoise" />
              <feDisplacementMap in="SourceGraphic" in2="navNoise" scale="7" xChannelSelector="R" yChannelSelector="B" />
            </filter>
          </defs>
        </svg>
        <div className="glass-panel nav-fluid-dock relative mx-auto flex max-w-md items-center justify-between rounded-[27px] p-1.5 shadow-2xl">
          {mobileLinks.map(({ to, label, icon: Icon, tone }) => {
            const active = location.pathname === to;
            return (
              <Link
                key={to}
                to={to}
                aria-current={active ? 'page' : undefined}
                className={`nav-fluid-item relative flex h-12 min-w-0 items-center justify-center rounded-full px-2.5 text-[10px] font-bold ${active ? 'nav-fluid-item-active' : ''}`}
              >
                {active && (
                  <motion.span
                    layoutId="mobile-nav-liquid-capsule"
                    className={`nav-liquid-capsule absolute inset-y-0 left-0 right-0 rounded-full ${tone}`}
                    transition={capsuleTransition}
                  >
                    <span className="nav-liquid-aura" />
                    <span className="nav-liquid-surface" />
                    <span className="nav-liquid-specular" />
                    <span className="nav-liquid-edge" />
                  </motion.span>
                )}

                <motion.span
                  className={`relative z-10 flex items-center ${active ? 'gap-2' : ''}`}
                  animate={{
                    scale: active ? 1 : 0.96,
                  }}
                  transition={iconSpring}
                >
                  <motion.span
                    className={`nav-liquid-orb relative grid shrink-0 place-items-center rounded-full ${active ? 'nav-liquid-orb-active' : ''}`}
                    animate={{
                      width: active ? 44 : 34,
                      height: active ? 44 : 34,
                    }}
                    transition={iconSpring}
                  >
                    <span className={`nav-liquid-orb-ring absolute -inset-[3px] rounded-full ${active ? 'opacity-100' : 'opacity-0'}`} />
                    <span className="nav-liquid-orb-glint absolute inset-[5px] rounded-full" />
                    <Icon size={active ? 17 : 18} strokeWidth={active ? 2.5 : 2} />
                  </motion.span>

                  <motion.span
                    className={`nav-liquid-label overflow-hidden whitespace-nowrap ${active ? 'max-w-[72px]' : 'max-w-0'}`}
                    animate={{
                      opacity: active ? 1 : 0,
                      x: active ? 0 : -8,
                    }}
                    transition={{ ...iconSpring, delay: active ? 0.06 : 0 }}
                  >
                    {label}
                  </motion.span>
                </motion.span>

                {!active && (
                  <span className="nav-fluid-idle-label pointer-events-none absolute -bottom-0.5 left-1/2 -translate-x-1/2 whitespace-nowrap text-[8px]">
                    {label}
                  </span>
                )}
              </Link>
            );
          })}
        </div>
      </nav>    </>
  );
}
