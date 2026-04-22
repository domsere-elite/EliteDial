'use client';

import React from 'react';

interface CallRecordingPlayerProps {
  recordingUrl?: string | null;
  duration?: number;
}

function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

export default function CallRecordingPlayer({
  recordingUrl,
  duration,
}: CallRecordingPlayerProps) {
  if (!recordingUrl) {
    return (
      <div
        style={{
          padding: '16px 20px',
          color: 'var(--text-secondary)',
          fontSize: 14,
          fontFamily: 'var(--font-mono)',
          background: 'rgba(255,255,255,0.92)',
          border: '1px solid var(--border-primary)',
          borderRadius: 16,
        }}
      >
        No recording available
      </div>
    );
  }

  return (
    <div
      style={{
        background: 'rgba(255,255,255,0.92)',
        border: '1px solid var(--border-primary)',
        borderRadius: 16,
        padding: '16px 20px',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <span
          style={{
            fontSize: 13,
            fontWeight: 600,
            color: 'var(--text-secondary)',
            textTransform: 'uppercase' as const,
            letterSpacing: '0.04em',
          }}
        >
          Call Recording
        </span>
        {duration !== undefined && (
          <span
            style={{
              fontSize: 13,
              fontFamily: 'var(--font-mono)',
              color: 'var(--text-secondary)',
              background: 'var(--bg-elevated)',
              padding: '2px 8px',
              borderRadius: 'var(--radius-md)',
            }}
          >
            {formatDuration(duration)}
          </span>
        )}
      </div>
      <audio
        controls
        src={recordingUrl}
        style={{
          width: '100%',
          height: 36,
          borderRadius: 'var(--radius-md)',
        }}
      />
    </div>
  );
}
