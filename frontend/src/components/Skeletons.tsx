'use client';

import React from 'react';

/* ---------------------------------------------------------------------------
 * Shimmer keyframe animation injected once via <style> tag
 * ---------------------------------------------------------------------------*/
const SHIMMER_KEYFRAMES = `
@keyframes shimmer {
  0% { background-position: -400px 0; }
  100% { background-position: 400px 0; }
}
@keyframes pulse-fade {
  0%, 100% { opacity: 0.5; }
  50% { opacity: 1; }
}
`;

let injected = false;
function useInjectStyles() {
  React.useEffect(() => {
    if (injected) return;
    injected = true;
    const style = document.createElement('style');
    style.textContent = SHIMMER_KEYFRAMES;
    document.head.appendChild(style);
    return () => {
      // keep the styles around — lightweight and shared
    };
  }, []);
}

/* ---------------------------------------------------------------------------
 * Shared shimmer background style
 * ---------------------------------------------------------------------------*/
const shimmerBg: React.CSSProperties = {
  background:
    'linear-gradient(90deg, var(--bg-secondary, rgba(224,227,229,0.5)) 25%, rgba(255,255,255,0.6) 50%, var(--bg-secondary, rgba(224,227,229,0.5)) 75%)',
  backgroundSize: '800px 100%',
  animation: 'shimmer 1.6s ease-in-out infinite',
};

/* ===========================================================================
 * 1. SkeletonLine — a single line placeholder
 * ===========================================================================*/
interface SkeletonLineProps {
  width?: string;
  height?: string;
}

export function SkeletonLine({ width = '100%', height = '14px' }: SkeletonLineProps) {
  useInjectStyles();
  return (
    <div
      aria-hidden="true"
      style={{
        width,
        height,
        borderRadius: 'var(--radius-sm, 12px)',
        ...shimmerBg,
      }}
    />
  );
}

/* ===========================================================================
 * 2. SkeletonCard — mimics a stat-card
 * ===========================================================================*/
export function SkeletonCard() {
  useInjectStyles();
  return (
    <div
      aria-hidden="true"
      style={{
        padding: '18px',
        border: '1px solid var(--border-primary, rgba(68,71,77,0.12))',
        borderRadius: 'var(--radius-md, 18px)',
        background: 'rgba(255,255,255,0.78)',
        boxShadow: 'var(--shadow-xs, 0 1px 2px rgba(0,0,0,0.04))',
      }}
    >
      {/* Large number placeholder */}
      <div
        style={{
          width: '120px',
          height: '28px',
          borderRadius: 'var(--radius-sm, 12px)',
          marginBottom: '10px',
          ...shimmerBg,
        }}
      />
      {/* Label placeholder */}
      <div
        style={{
          width: '80px',
          height: '12px',
          borderRadius: 'var(--radius-sm, 12px)',
          ...shimmerBg,
        }}
      />
    </div>
  );
}

/* ===========================================================================
 * 3. SkeletonTable — mimics a data-table
 * ===========================================================================*/
interface SkeletonTableProps {
  rows?: number;
  columns?: number;
}

export function SkeletonTable({ rows = 5, columns = 5 }: SkeletonTableProps) {
  useInjectStyles();

  const cellStyle: React.CSSProperties = {
    padding: '11px 12px',
    borderBottom: '1px solid rgba(24,36,58,0.08)',
  };

  const headerCellStyle: React.CSSProperties = {
    padding: '11px 12px',
    borderBottom: '1px solid var(--border-primary, rgba(68,71,77,0.12))',
  };

  return (
    <table
      aria-hidden="true"
      style={{
        width: '100%',
        borderCollapse: 'collapse',
        fontSize: '0.82rem',
      }}
    >
      <thead>
        <tr>
          {Array.from({ length: columns }).map((_, ci) => (
            <th key={ci} style={headerCellStyle}>
              <div
                style={{
                  width: `${60 + ((ci * 17) % 40)}px`,
                  height: '10px',
                  borderRadius: 'var(--radius-sm, 12px)',
                  ...shimmerBg,
                }}
              />
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {Array.from({ length: rows }).map((_, ri) => (
          <tr key={ri}>
            {Array.from({ length: columns }).map((_, ci) => (
              <td key={ci} style={cellStyle}>
                <div
                  style={{
                    width: `${50 + (((ri + ci) * 23) % 60)}%`,
                    height: '14px',
                    borderRadius: 'var(--radius-sm, 12px)',
                    ...shimmerBg,
                  }}
                />
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/* ===========================================================================
 * 4. SkeletonPanel — a glass-panel sized placeholder
 * ===========================================================================*/
interface SkeletonPanelProps {
  height?: string;
}

export function SkeletonPanel({ height = '200px' }: SkeletonPanelProps) {
  useInjectStyles();
  return (
    <div
      aria-hidden="true"
      style={{
        position: 'relative',
        overflow: 'hidden',
        height,
        border: '1px solid var(--border-primary, rgba(68,71,77,0.12))',
        borderRadius: 'var(--radius-md, 18px)',
        ...shimmerBg,
      }}
    />
  );
}

/* ===========================================================================
 * 5. PageLoader — full page centered spinner with pulse animation
 * ===========================================================================*/
export function PageLoader() {
  useInjectStyles();
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: '100%',
        minHeight: '60vh',
      }}
    >
      <span
        style={{
          fontSize: '0.95rem',
          fontWeight: 500,
          color: 'var(--text-muted, #8b929b)',
          letterSpacing: '0.04em',
          animation: 'pulse-fade 1.8s ease-in-out infinite',
        }}
      >
        Loading&hellip;
      </span>
    </div>
  );
}
