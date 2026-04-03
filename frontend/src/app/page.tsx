'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/hooks/useAuth';

export default function LoginPage() {
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(false);
    const { login, user, loading: authLoading } = useAuth();
    const router = useRouter();

    useEffect(() => {
        if (!authLoading && user) {
            router.replace('/dashboard');
        }
    }, [authLoading, user, router]);

    if (authLoading) {
        return (
            <div className="login-container">
                <section className="login-showcase">
                    <div className="login-kicker">EliteDial</div>
                    <h1 className="login-headline">Collections operations, routed like a real floor.</h1>
                    <p className="login-copy">Secure dialer controls, agent presence, campaign pacing, live call diagnostics, and CRM context in one operator console.</p>
                </section>
                <div className="login-card" style={{ textAlign: 'center' }}>
                    <h1>EliteDial</h1>
                    <p>Loading secure workspace...</p>
                </div>
            </div>
        );
    }

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setError('');
        setLoading(true);

        try {
            await login(username, password);
            router.push('/dashboard');
        } catch (err: any) {
            setError(err.response?.data?.error || 'Login failed');
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="login-container">
            <section className="login-showcase">
                <div className="login-kicker">Collections Intelligence Platform</div>
                <h1 className="login-headline">Build the floor your agency actually needs.</h1>
                <p className="login-copy">
                    Manual dial, campaign execution, inbound routing, diagnostics, and AI expansion paths,
                    shaped for an internal collections operation instead of a generic contact-center template.
                </p>
                <div className="login-metrics">
                    <div className="login-metric">
                        <strong>Live</strong>
                        <span>SignalWire Voice</span>
                    </div>
                    <div className="login-metric">
                        <strong>Unified</strong>
                        <span>Call Event Ledger</span>
                    </div>
                    <div className="login-metric">
                        <strong>Ready</strong>
                        <span>Campaign Control Layer</span>
                    </div>
                </div>
            </section>
            <div className="login-card">
                <h1>EliteDial</h1>
                <p>Sign in to the operator workspace.</p>

                <form onSubmit={handleSubmit}>
                    <div>
                        <label>Username</label>
                        <input
                            type="text"
                            className="input"
                            value={username}
                            onChange={(e) => setUsername(e.target.value)}
                            placeholder="Enter username"
                            autoFocus
                            required
                        />
                    </div>

                    <div>
                        <label>Password</label>
                        <input
                            type="password"
                            className="input"
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            placeholder="Enter password"
                            required
                        />
                    </div>

                    {error && (
                        <div style={{
                            padding: '10px 14px',
                            background: 'rgba(239, 68, 68, 0.1)',
                            border: '1px solid rgba(239, 68, 68, 0.3)',
                            borderRadius: 'var(--radius-sm)',
                            color: 'var(--accent-rose)',
                            fontSize: '0.82rem',
                            marginBottom: '16px',
                        }}>
                            {error}
                        </div>
                    )}

                    <button
                        type="submit"
                        className="btn btn-primary btn-lg"
                        style={{ width: '100%' }}
                        disabled={loading}
                    >
                        {loading ? 'Authenticating...' : 'Sign In'}
                    </button>
                </form>

                {process.env.NEXT_PUBLIC_DEMO_MODE === 'true' && (
                    <div className="login-demo">
                        <div className="topline">Demo Access</div>
                        <div className="mono" style={{ marginTop: 6, fontWeight: 700 }}>
                            admin / admin123
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
