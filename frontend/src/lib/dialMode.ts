export type DialMode = 'manual' | 'progressive' | 'ai_autonomous';

export const DIAL_MODE_OPTIONS: Array<{ value: DialMode; label: string }> = [
    { value: 'manual', label: 'Manual' },
    { value: 'progressive', label: 'Progressive (1 per available agent)' },
    { value: 'ai_autonomous', label: 'AI Autonomous (no agents, auto-bridge to AI)' },
];

export function formatDialMode(mode: string): string {
    switch (mode) {
        case 'manual': return 'Manual';
        case 'progressive': return 'Progressive';
        case 'ai_autonomous': return 'AI Autonomous';
        default: return mode;
    }
}
