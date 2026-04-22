'use client';

interface CallControlsProps {
  muted: boolean;
  held: boolean;
  onToggleMute: () => void;
  onToggleHold: () => void;
  onTransfer: () => void;
  onEndCall: () => void;
}

export function CallControls({ muted, held, onToggleMute, onToggleHold, onTransfer, onEndCall }: CallControlsProps) {
  return (
    <div style={{ display: 'flex', gap: 6 }}>
      <button className={`call-control-btn ${muted ? 'active' : ''}`} onClick={onToggleMute}>
        {muted ? 'Unmute' : 'Mute'}
      </button>
      <button className={`call-control-btn ${held ? 'active' : ''}`} onClick={onToggleHold}>
        {held ? 'Resume' : 'Hold'}
      </button>
      <button className="call-control-btn" onClick={onTransfer}>Transfer</button>
      <button className="btn btn-danger" onClick={onEndCall}>End Call</button>
    </div>
  );
}
