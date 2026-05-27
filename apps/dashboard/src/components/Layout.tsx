import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

declare const __APP_VERSION__: string;

const isTauri = !!(window as any).__TAURI_INTERNALS__ || !!(window as any).__TAURI__;

interface NavItem {
  key: string;
  path: string;
  icon: string;
  children?: { key: string; path: string }[];
}

const navItems: NavItem[] = [
  { key: 'home', path: '/', icon: '🔍' },
  { key: 'plans', path: '/plans', icon: '📋' },
  { key: 'tokenConsumption', path: '/tokens', icon: '🔋' },
  { key: 'providers', path: '/providers', icon: '🔌' },
  {
    key: 'stats', path: '/stats', icon: '📊',
    children: [
      { key: 'statsKnowledge', path: '/stats' },
      { key: 'statsPlans', path: '/stats/plans' },
    ],
  },
  ...(isTauri ? [{ key: 'widgets', path: '/widgets', icon: '🧩' }] : []),
  { key: 'settings', path: '/settings', icon: '⚙' },
];

export function Layout({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div style={{ display: 'flex', height: '100vh', overflow: 'hidden' }}>
      {/* Sidebar */}
      <aside
        style={{
          width: collapsed ? 60 : 220,
          backgroundColor: 'var(--bg-sidebar)',
          borderRight: '1px solid var(--border)',
          padding: collapsed ? '16px 8px' : '16px',
          display: 'flex',
          flexDirection: 'column',
          transition: 'width 0.2s ease',
          flexShrink: 0,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
          {!collapsed && (
            <span style={{ fontSize: 16, fontWeight: 700, color: 'var(--accent)' }}>
              🧠 {t('app.title')}
            </span>
          )}
          <button
            onClick={() => setCollapsed(!collapsed)}
            style={{
              background: 'none', border: 'none', color: 'var(--text-secondary)',
              cursor: 'pointer', fontSize: 18, padding: 4,
            }}
          >
            {collapsed ? '→' : '←'}
          </button>
        </div>

        <nav style={{ flex: 1 }}>
          {navItems.map((item) => {
            const isParentActive = item.children
              ? item.children.some(c => location.pathname === c.path)
              : location.pathname === item.path;
            const active = location.pathname === item.path;

            return (
              <div key={item.key}>
                <Link
                  to={item.children ? item.children[0].path : item.path}
                  onClick={(e) => {
                    const targetActive = item.children ? isParentActive && location.pathname === (item.children[0].path) : active;
                    if (targetActive) {
                      e.preventDefault();
                      navigate(item.children ? item.children[0].path : item.path, { replace: true, state: { reset: Date.now() } });
                    }
                  }}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 10,
                    padding: '10px 12px', marginBottom: item.children && isParentActive && !collapsed ? 0 : 4, borderRadius: 8,
                    textDecoration: 'none',
                    backgroundColor: isParentActive ? 'var(--accent)' : 'transparent',
                    color: isParentActive ? '#fff' : 'var(--text-secondary)',
                    fontSize: 14, transition: 'all 0.15s ease',
                    borderBottomLeftRadius: item.children && isParentActive && !collapsed ? 0 : 8,
                    borderBottomRightRadius: item.children && isParentActive && !collapsed ? 0 : 8,
                  }}
                >
                  <span>{item.icon}</span>
                  {!collapsed && <span>{t(`nav.${item.key}`)}</span>}
                </Link>
                {/* Sub-items */}
                {item.children && isParentActive && (
                  <div style={{
                    backgroundColor: 'rgba(99,102,241,0.15)',
                    borderBottomLeftRadius: 8, borderBottomRightRadius: 8,
                    marginBottom: 4, paddingBottom: collapsed ? 2 : 4,
                    paddingTop: collapsed ? 2 : 0,
                  }}>
                    {item.children.map((child) => {
                      const childActive = location.pathname === child.path;
                      return (
                        <Link
                          key={child.key}
                          to={child.path}
                          onClick={(e) => {
                            if (childActive) {
                              e.preventDefault();
                              navigate(child.path, { replace: true, state: { reset: Date.now() } });
                            }
                          }}
                          title={collapsed ? t(`nav.${child.key}`) : undefined}
                          style={{
                            display: 'block',
                            padding: collapsed ? '5px 0' : '6px 12px 6px 36px',
                            textDecoration: 'none',
                            fontSize: collapsed ? 11 : 12,
                            textAlign: collapsed ? 'center' : 'left',
                            color: childActive ? '#fff' : 'rgba(255,255,255,0.7)',
                            fontWeight: childActive ? 600 : 400,
                            transition: 'all 0.15s ease',
                          }}
                        >
                          {collapsed ? t(`nav.${child.key}`).charAt(0).toUpperCase() : t(`nav.${child.key}`)}
                        </Link>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </nav>

        {/* Version Display */}
        {!collapsed && (
          <div style={{ textAlign: 'center', paddingTop: 8, fontSize: 10, color: 'var(--text-secondary)', opacity: 0.6 }}>
            v{__APP_VERSION__}
          </div>
        )}
      </aside>

      {/* Main Content */}
      <main style={{ flex: 1, overflow: 'auto', padding: 24, backgroundColor: 'var(--bg-main)' }}>
        {children}
      </main>
    </div>
  );
}
