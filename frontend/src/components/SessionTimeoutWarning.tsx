'use client';

import React, { useState, useEffect, useCallback } from 'react';

interface SessionTimeoutWarningProps {
  tokenExpiresAt?: number;
  onExtend: () => void;
  onLogout: () => void;
}

function formatCountdown(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

export default function SessionTimeoutWarning({
  tokenExpiresAt,
  onExtend,
  onLogout,
}: SessionTimeoutWarningProps) {
  const [secondsRemaining, setSecondsRemaining] = useState<number | null>(null);

  const computeRemaining = useCallback(() => {
    if (tokenExpiresAt === undefined) return null;
    return Math.max(0, tokenExpiresAt - Math.floor(Date.now() / 1000));
  }, [tokenExpiresAt]);

  useEffect(() => {
    setSecondsRemaining(computeRemaining());

    const interval = setInterval(() => {
      const remaining = computeRemaining();
      setSecondsRemaining(remaining);
      if (remaining !== null && remaining <= 0) {
        clearInterval(interval);
        onLogout();
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [computeRemaining, onLogout]);

  if (secondsRemaining === null || secondsRemaining > 300) {
    return null;
  }

  const buttonBase: React.CSSProperties = {
    padding: '6px 16px',
    fontSize: 13,
    fontWeight: 600,
    borderRadius: 'var(--radius-md)',
    border: 'none',
    cursor: 'pointer',
    transition: 'opacity 0.15s',
  };

  return (
    <div
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        width: '100%',
        zIndex: 1000,
        background: 'linear-gradient(135deg, #f59e0b, #d97706)',
        color: '#fff',
        padding: '10px 24px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 20,
        fontFamily: 'var(--font-mono)',
        fontSize: 14,
        boxShadow: '0 2px 12px rgba(0,0,0,0.15)',
      }}
    >
      <span style={{ fontWeight: 600 }}>
        Session expires in {formatCountdown(secondsRemaining)}
      </span>

      <button
        onClick={onExtend}
        style={{
          ...buttonBase,
          background: '#fff',
          color: '#d97706',
        }}
      >
        Extend Session
      </button>

      <button
        onClick={onLogout}
        style={{
          ...buttonBase,
          background: 'rgba(0,0,0,0.2)',
          color: '#fff',
        }}
      >
        Sign Out
      </button>
    </div>
  );
}
