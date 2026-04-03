'use client';
import { useEffect } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { useAuth } from '@/hooks/useAuth';
import Link from 'next/link';

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
    const { user, loading, logout, updateStatus, hasRole } = useAuth();
    const router = useRouter();
    const pathname = usePathname();

    useEffect(() => {
        if (!loading && !user) {
            router.push('/');
        }
    }, [user, loading, router]);

    if (loading || !user) {
        return (
            <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <div className="mono topline">{loading ? 'Loading workspace...' : 'Redirecting to sign in...'}</div>
            </div>
        );
    }

    const primaryNav = [
        { href: '/dashboard', label: 'Calls', icon: 'CA', roles: ['agent', 'supervisor', 'admin'] },
        { href: '/dashboard/accounts', label: 'Accounts', icon: 'AC', roles: ['agent', 'supervisor', 'admin'] },
        { href: '/dashboard/campaigns', label: 'Campaigns', icon: 'CP', roles: ['supervisor', 'admin'] },
        { href: '/dashboard/reports', label: 'History', icon: 'HI', roles: ['supervisor', 'admin'] },
    ];
    const secondaryNav = [
        { href: '/dashboard/voicemail', label: 'Voicemail', icon: 'VM', roles: ['agent', 'supervisor', 'admin'] },
        { href: '/dashboard/diagnostics', label: 'Diagnostics', icon: 'DG', roles: ['supervisor', 'admin'] },
        { href: '/dashboard/settings', label: 'Settings', icon: 'ST', roles: ['supervisor', 'admin'] },
        { href: '/dashboard/admin', label: 'Admin', icon: 'AD', roles: ['admin'] },
    ];

    const statusOptions = [
        { value: 'available', label: 'Avail' },
        { value: 'break', label: 'Break' },
        { value: 'offline', label: 'Offline' },
    ];

    const getStatusClass = (status: string) => {
        const map: Record<string, string> = {
            available: 'status-available',
            break: 'status-break',
            offline: 'status-offline',
            'on-call': 'status-on-call',
        };
        return map[status] || 'status-offline';
    };

    const isActiveRoute = (href: string) => {
        if (href === '/dashboard') {
            return pathname === '/dashboard';
        }

        return pathname === href || pathname.startsWith(`${href}/`);
    };

    const renderNavGroup = (items: typeof primaryNav) => items
        .filter((item) => item.roles.some((role) => hasRole(role)))
        .map((item) => (
            <Link
                key={item.href}
                href={item.href}
                className={`sidebar-link ${isActiveRoute(item.href) ? 'active' : ''}`}
            >
                <span className="nav-glyph">{item.icon}</span>
                <span>{item.label}</span>
            </Link>
        ));

    const topNav = [
        { href: '/dashboard/reports', label: 'Dashboard', roles: ['supervisor', 'admin'] },
        { href: '/dashboard', label: 'Dialer', roles: ['agent', 'supervisor', 'admin'] },
        { href: '/dashboard/accounts', label: 'Accounts', roles: ['agent', 'supervisor', 'admin'] },
        { href: '/dashboard/campaigns', label: 'Campaigns', roles: ['supervisor', 'admin'] },
    ].filter((item) => item.roles.some((role) => hasRole(role)));

    const agentLabel = `Agent #${String(user.id).slice(0, 4).toUpperCase()}`;
    const displayName = `${user.firstName} ${user.lastName}`;

    return (
        <div className="app-shell">
            <aside className="sidebar">
                <div className="sidebar-brand">
                    <div className="brand-mark">
                        {user.firstName[0]}
                        {user.lastName[0]}
                    </div>
                    <div>
                        <h1>Collector Portal</h1>
                        <span>{agentLabel}</span>
                    </div>
                </div>

                <nav className="sidebar-nav">
                    {renderNavGroup(primaryNav)}
                </nav>

                <button className="sidebar-cta" onClick={() => router.push('/dashboard/campaigns')}>
                    Start Auto-Dialer
                </button>

                <div className="sidebar-nav compact">
                    <div className="sidebar-section-label">Operations</div>
                    {renderNavGroup(secondaryNav)}
                </div>

                <div className="sidebar-footer">
                    <div className="presence-card">
                        <div className="presence-header">
                            <div>
                                <div className="topline">Live Dialing</div>
                                <div className="presence-name">{displayName}</div>
                            </div>
                            <span className={`status-badge ${getStatusClass(user.status)}`}>
                                {user.status === 'on-call' ? 'On Call' : user.status}
                            </span>
                        </div>
                        <div className="presence-actions">
                            {statusOptions.map((s) => (
                                <button
                                    key={s.value}
                                    onClick={() => updateStatus(s.value)}
                                    className={`presence-pill ${user.status === s.value ? 'active' : ''}`}
                                >
                                    {s.label}
                                </button>
                            ))}
                        </div>
                    </div>

                    <button
                        onClick={() => { logout(); router.push('/'); }}
                        className="btn btn-secondary"
                        style={{ width: '100%', fontSize: '0.78rem' }}
                    >
                        Sign Out
                    </button>
                </div>
            </aside>

            <main className="main-content">
                <header className="topbar">
                    <div className="topbar-brand">
                        <div>
                            <div className="topline">PrecisionDial</div>
                            <div className="topbar-title">Operator cockpit</div>
                        </div>
                        <div className="topbar-search">
                            <input className="input" placeholder="Search accounts, debtors..." type="text" />
                        </div>
                    </div>

                    <div className="topbar-actions">
                        <nav className="topbar-nav">
                            {topNav.map((item) => (
                                <Link
                                    key={item.href}
                                    href={item.href}
                                    className={`topbar-link ${isActiveRoute(item.href) ? 'active' : ''}`}
                                >
                                    {item.label}
                                </Link>
                            ))}
                        </nav>

                        <div className="topbar-presence">
                            <span className={`status-orb ${user.status === 'available' ? 'ready' : user.status === 'on-call' ? 'live' : 'idle'}`} />
                            <div>
                                <div className="topline">{user.status === 'on-call' ? 'Live Dialing' : 'Agent Presence'}</div>
                                <div className="topbar-user">{displayName}</div>
                            </div>
                        </div>
                    </div>
                </header>

                {children}
            </main>
        </div>
    );
}
