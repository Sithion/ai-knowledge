import { useState, useEffect } from 'react';
import { BrowserRouter, Routes, Route, useNavigate } from 'react-router-dom';

declare const __APP_VERSION__: string;
import { Layout } from './components/Layout.js';
import { HomePage } from './pages/HomePage.js';
import { StatsPage, PlanStatsPage } from './pages/StatsPage.js';
import { SettingsPage } from './pages/SettingsPage.js';
import { WidgetsPage } from './pages/WidgetsPage.js';
import { PlansPage } from './pages/PlansPage.js';
import { TokenConsumptionPage } from './pages/TokenConsumptionPage.js';
import { ProvidersPage } from './pages/ProvidersPage.js';
import { SetupPage } from './pages/SetupPage.js';
import { UpgradePage } from './pages/UpgradePage.js';
import { api } from './api/client.js';
import { UpdateChecker } from './components/UpdateChecker.js';

const isTauri = !!(window as any).__TAURI_INTERNALS__ || !!(window as any).__TAURI__;

function WidgetEventListener() {
  const navigate = useNavigate();

  useEffect(() => {
    if (!isTauri) return;
    const unlisteners: (() => void)[] = [];
    import('@tauri-apps/api/event').then(({ listen }) => {
      const showMainWindow = () => {
        import('@tauri-apps/api/window').then(({ getCurrentWindow }) => {
          const win = getCurrentWindow();
          win.show();
          win.setFocus();
        }).catch(() => {});
      };

      listen<string>('open-plan', (event) => {
        navigate('/plans', { state: { focusPlan: event.payload } });
        showMainWindow();
      }).then((fn) => unlisteners.push(fn));

      listen<string>('navigate', (event) => {
        navigate(event.payload);
        showMainWindow();
      }).then((fn) => unlisteners.push(fn));
    });
    return () => { unlisteners.forEach(fn => fn()); };
  }, [navigate]);

  return null;
}

type AppState = 'loading' | 'setup' | 'upgrade' | 'ready';

export function App() {
  const [state, setState] = useState<AppState>('loading');
  const [upgradeFrom, setUpgradeFrom] = useState<string>('');

  useEffect(() => {
    (async () => {
      try {
        // 1. Check if setup is needed
        const status = await api.getSetupStatus();
        if (!status.allReady) {
          setState('setup');
          return;
        }

        // 2. Check if upgrade is needed
        const upgrade = await api.checkUpgrade();
        if (upgrade.needsUpgrade) {
          setUpgradeFrom(upgrade.fromVersion || '?');
          // Silent upgrade — covers Tauri auto-update case
          try {
            const result = await api.runUpgrade();
            if (result.success) {
              setState('ready');
              return;
            }
          } catch {
            // fall through to visible upgrade screen
          }
          setState('upgrade');
          return;
        }

        // 3. First install — save version (no upgrade screen needed)
        if (upgrade.isFirstInstall) {
          // Version will be saved by setup/complete hook
        }

        setState('ready');
      } catch {
        setState('setup');
      }
    })();
  }, []);

  // Loading
  if (state === 'loading') {
    return (
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        height: '100vh', background: 'var(--bg-main)', color: 'var(--text-secondary)',
        flexDirection: 'column', gap: 8,
      }}>
        <div style={{ fontSize: 36 }}>🧠</div>
        <span>Loading...</span>
        <span style={{ fontSize: 10, opacity: 0.5 }}>v{__APP_VERSION__}</span>
      </div>
    );
  }

  // Setup wizard (first install)
  if (state === 'setup') {
    return <SetupPage onComplete={() => setState('ready')} />;
  }

  // Upgrade screen (version changed)
  if (state === 'upgrade') {
    return <UpgradePage fromVersion={upgradeFrom} onComplete={() => setState('ready')} />;
  }

  // Normal dashboard
  return (
    <BrowserRouter>
      <UpdateChecker />
      <WidgetEventListener />
      <Layout>
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/plans" element={<PlansPage />} />
          <Route path="/tokens" element={<TokenConsumptionPage />} />
          <Route path="/providers" element={<ProvidersPage />} />
          <Route path="/stats" element={<StatsPage />} />
          <Route path="/stats/plans" element={<PlanStatsPage />} />
          <Route path="/widgets" element={<WidgetsPage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Routes>
      </Layout>
    </BrowserRouter>
  );
}
