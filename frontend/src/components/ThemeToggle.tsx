'use client';

import { useEffect, useState } from 'react';

const STORAGE_KEY = 'elitedial_theme';

export default function ThemeToggle() {
  const [dark, setDark] = useState(false);

  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'dark') {
      document.documentElement.setAttribute('data-theme', 'dark');
      setDark(true);
    }
  }, []);

  const toggle = () => {
    const next = !dark;
    setDark(next);
    if (next) {
      document.documentElement.setAttribute('data-theme', 'dark');
      localStorage.setItem(STORAGE_KEY, 'dark');
    } else {
      document.documentElement.removeAttribute('data-theme');
      localStorage.setItem(STORAGE_KEY, 'light');
    }
  };

  return (
    <button
      onClick={toggle}
      aria-label="Toggle theme"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '6px',
        padding: '6px 14px',
        fontSize: '0.8rem',
        fontWeight: 600,
        fontFamily: 'var(--font-body)',
        letterSpacing: '-0.01em',
        borderRadius: '999px',
        border: '1px solid var(--border-primary)',
        background: 'var(--bg-elevated)',
        color: 'var(--text-secondary)',
        cursor: 'pointer',
        transition: 'background 0.2s, border-color 0.2s, color 0.2s',
      }}
    >
      {dark ? '☀️ Light' : '🌙 Dark'}
    </button>
  );
}
