import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { Home } from '../pages/Home/Home';
import { History } from '../pages/History/History';
import { Scanner } from '../pages/Scanner/Scanner';
import { Settings } from '../pages/Settings/Settings';
import { Generator } from '../pages/Generator/Generator';
import { Statistics } from '../pages/Statistics/Statistics';
import { Tools } from '../pages/Tools/Tools';
import { Transfer } from '../pages/Transfer/Transfer';
import { OptiFrameLab } from '../pages/OptiFrameLab/OptiFrameLab';
import { Diagnostics } from '../pages/Diagnostics/Diagnostics';

type OptiFrameBoundaryState = { hasError: boolean };

class OptiFrameBoundary extends Component<{ children: ReactNode }, OptiFrameBoundaryState> {
  state: OptiFrameBoundaryState = { hasError: false };

  static getDerivedStateFromError(): OptiFrameBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Preserve diagnostics for browser developer tools while keeping a usable
    // transfer screen visible to mobile users.
    console.error('OptiFrame failed to render; showing compatibility transfer.', error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="mx-auto max-w-7xl py-5">
          <div role="alert" className="mb-4 rounded-2xl border border-amber-300/30 bg-amber-300/10 p-4 text-sm leading-6 text-[var(--text)]">
            Advanced OptiFrame could not open on this device. You can still use the compatibility Send Files screen below.
          </div>
          <Transfer />
        </div>
      );
    }

    return this.props.children;
  }
}

export function AppRouter() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/generator" element={<Generator />} />
      <Route path="/scanner" element={<Scanner />} />
      <Route path="/history" element={<History />} />
      <Route path="/statistics" element={<Statistics />} />
      <Route path="/tools" element={<Tools />} />
      <Route path="/transfer" element={<Transfer />} />
      <Route path="/optiframe" element={<OptiFrameBoundary><OptiFrameLab /></OptiFrameBoundary>} />
      <Route path="/diagnostics" element={<Diagnostics />} />
      <Route path="/settings" element={<Settings />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
