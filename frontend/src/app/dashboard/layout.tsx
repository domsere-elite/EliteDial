'use client';
import { useEffect, useState } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { useAuth } from '@/hooks/useAuth';
import Link from 'next/link';
import ThemeToggle from '@/components/ThemeToggle';
import SessionTimeoutWarning from '@/components/SessionTimeoutWarning';
import { getTokenExpiry } from '@/lib/jwt';
import api from '@/lib/api';

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
    const { user, token, loading, logout, updateStatus, hasRole } = useAuth();
    const router = useRouter();
    const pathname = usePathname();
    const [tokenExpiry, setTokenExpiry] = useState<number | undefined>();
    const [vmUnread, setVmUnread] = useState(0);

    useEffect(() => {
        const saved = localStorage.getItem('elitedial_token');
        if (saved) {
            const exp = getTokenExpiry(saved);
            if (exp) setTokenExpiry(exp);
        }
    }, [token]);

    useEffect(() => {
        api.get('/voicemails?unreadOnly=true&limit=1').then(res => {
            setVmUnread(res.data.unreadCount || 0);
        }).catch(() => {});
    }, []);

    const handleExtendSession = async () => {
        try {
            const refreshToken = localStorage.getItem('elitedial_refresh_token');
            if (refreshToken) {
                const res = await api.post('/auth/refresh', { refreshToken });
                localStorage.setItem('elitedial_token', res.data.token);
                if (res.data.refreshToken) localStorage.setItem('elitedial_refresh_token', res.data.refreshToken);
                const exp = getTokenExpiry(res.data.token);
                if (exp) setTokenExpiry(exp);
            }
        } catch {
            logout();
        }
    };

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
        { href: '/dashboard', label: 'Inbound Hub', icon: 'IH', roles: ['agent', 'supervisor', 'admin'] },
        { href: '/dashboard/ai-agents', label: 'AI Agents', icon: 'AI', roles: ['supervisor', 'admin'] },
        { href: '/dashboard/reports', label: 'Reports', icon: 'RP', roles: ['supervisor', 'admin'] },
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

    const agentLabel = user.role.charAt(0).toUpperCase() + user.role.slice(1);
    const displayName = `${user.firstName} ${user.lastName}`;

    return (
        <div className="app-shell">
            <SessionTimeoutWarning
                tokenExpiresAt={tokenExpiry}
                onExtend={handleExtendSession}
                onLogout={() => { logout(); router.push('/'); }}
            />
            <aside className="sidebar">
                <div className="sidebar-brand">
                    <div className="brand-mark">ED</div>
                    <div>
                        <h1>EliteDial</h1>
                        <span>Inbound Operations</span>
                    </div>
                </div>

                <nav className="sidebar-nav">
                    {renderNavGroup(primaryNav)}
                </nav>

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

                    <Link href="/dashboard/voicemail" className="btn btn-secondary" style={{ width: '100%', fontSize: '0.78rem', marginBottom: 8, justifyContent: 'space-between' }}>
                        <span>Voicemail</span>
                        {vmUnread > 0 && <span className="badge badge-blue" style={{ marginLeft: 8 }}>{vmUnread}</span>}
                    </Link>

                    <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                        <button
                            onClick={() => { logout(); router.push('/'); }}
                            className="btn btn-secondary"
                            style={{ flex: 1, fontSize: '0.78rem' }}
                        >
                            Sign Out
                        </button>
                        <ThemeToggle />
                    </div>
                </div>
            </aside>

            <main className="main-content">
                <header className="topbar">
                    <div className="topbar-brand">
                        <div>
                            <div className="topline">EliteDial</div>
                            <div className="topbar-title">Inbound Hub</div>
                        </div>
                    </div>
                    <div className="topbar-actions">
                        <div className="topbar-presence">
                            <span className={`status-orb ${user.status === 'available' ? 'ready' : user.status === 'on-call' ? 'live' : 'idle'}`} />
                            <div>
                                <div className="topline">{user.status === 'on-call' ? 'On Call' : user.status}</div>
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
