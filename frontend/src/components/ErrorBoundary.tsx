'use client';

import React, { Component, ErrorInfo, ReactNode } from 'react';

interface Props {
    children: ReactNode;
    fallback?: ReactNode;
}

interface State {
    hasError: boolean;
    error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
    constructor(props: Props) {
        super(props);
        this.state = { hasError: false, error: null };
    }

    static getDerivedStateFromError(error: Error): State {
        return { hasError: true, error };
    }

    componentDidCatch(error: Error, errorInfo: ErrorInfo) {
        console.error('ErrorBoundary caught:', error, errorInfo);
    }

    render() {
        if (this.state.hasError) {
            if (this.props.fallback) {
                return this.props.fallback;
            }

            return (
                <div style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    minHeight: '100vh',
                    padding: '2rem',
                    fontFamily: 'system-ui, -apple-system, sans-serif',
                    background: '#0a0a0f',
                    color: '#e5e5e5',
                }}>
                    <div style={{
                        maxWidth: '480px',
                        textAlign: 'center',
                        padding: '2.5rem',
                        borderRadius: '12px',
                        background: 'rgba(255,255,255,0.04)',
                        border: '1px solid rgba(255,255,255,0.08)',
                    }}>
                        <h1 style={{ fontSize: '1.5rem', marginBottom: '0.75rem', color: '#f87171' }}>
                            Something went wrong
                        </h1>
                        <p style={{ color: '#a1a1aa', marginBottom: '1.5rem', lineHeight: 1.6 }}>
                            An unexpected error occurred. Please try refreshing the page.
                        </p>
                        {this.state.error && (
                            <pre style={{
                                textAlign: 'left',
                                padding: '1rem',
                                borderRadius: '8px',
                                background: 'rgba(0,0,0,0.3)',
                                fontSize: '0.8rem',
                                color: '#f87171',
                                overflow: 'auto',
                                maxHeight: '120px',
                                marginBottom: '1.5rem',
                            }}>
                                {this.state.error.message}
                            </pre>
                        )}
                        <button
                            onClick={() => window.location.reload()}
                            style={{
                                padding: '0.6rem 1.5rem',
                                borderRadius: '8px',
                                border: 'none',
                                background: '#e11d48',
                                color: '#fff',
                                fontSize: '0.9rem',
                                fontWeight: 600,
                                cursor: 'pointer',
                            }}
                        >
                            Reload Page
                        </button>
                    </div>
                </div>
            );
        }

        return this.props.children;
    }
}
