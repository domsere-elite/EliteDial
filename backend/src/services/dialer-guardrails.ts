export type DialMode = 'manual' | 'progressive' | 'ai_autonomous';

type GuardrailInputs = {
    dialMode: DialMode | string;
    maxConcurrentCalls: number;
    availableAgents: number;
    activeCalls: number;
    // Progressive power-dial multiplier; defaults to 1.0 (strict 1:1) when omitted.
    // Values >1 raise baseConcurrentLimit to floor(availableAgents * dialRatio).
    dialRatio?: number;
};

export type DialerGuardrailSummary = {
    baseConcurrentLimit: number;
    effectiveConcurrentLimit: number;
    dispatchCapacity: number;
    queuePressure: number;
    blockedReasons: string[];
    warnings: string[];
};

export const DIALER_STATS_WINDOW_MINUTES = 15;

export const computeDialerGuardrails = (input: GuardrailInputs): DialerGuardrailSummary => {
    const blockedReasons: string[] = [];
    const warnings: string[] = [];

    // Manual mode: no worker dispatch — agent initiates each call explicitly.
    if (input.dialMode === 'manual') {
        return {
            baseConcurrentLimit: 0,
            effectiveConcurrentLimit: 0,
            dispatchCapacity: 0,
            queuePressure: 0,
            blockedReasons: ['manual_mode'],
            warnings: [],
        };
    }

    let baseConcurrentLimit: number;

    if (input.dialMode === 'ai_autonomous') {
        // AI Autonomous: cap is the campaign's maxConcurrentCalls. No agents needed.
        if (input.maxConcurrentCalls <= 0) {
            blockedReasons.push('no_concurrency_configured');
        }
        baseConcurrentLimit = Math.max(0, input.maxConcurrentCalls);
    } else {
        // Progressive: dialRatio calls per available agent, capped by maxConcurrentCalls if set.
        // Sanitize ratio: clamp to [1.0, 5.0] to mirror the validation contract.
        const rawRatio = typeof input.dialRatio === 'number' && Number.isFinite(input.dialRatio)
            ? input.dialRatio
            : 1.0;
        const ratio = Math.max(1.0, Math.min(5.0, rawRatio));
        if (input.availableAgents <= 0) {
            blockedReasons.push('no_available_agents');
        }
        baseConcurrentLimit = Math.floor(input.availableAgents * ratio);
        if (input.maxConcurrentCalls > 0) {
            baseConcurrentLimit = Math.min(baseConcurrentLimit, input.maxConcurrentCalls);
        }
    }

    const effectiveConcurrentLimit = baseConcurrentLimit;

    if (effectiveConcurrentLimit > 0 && input.activeCalls >= effectiveConcurrentLimit) {
        blockedReasons.push('queue_backpressure');
    }

    const dispatchCapacity = blockedReasons.length > 0
        ? 0
        : Math.max(0, effectiveConcurrentLimit - input.activeCalls);

    const denominator = input.dialMode === 'ai_autonomous'
        ? input.maxConcurrentCalls
        : effectiveConcurrentLimit;

    const queuePressure = denominator > 0
        ? input.activeCalls / denominator
        : (input.activeCalls > 0 ? 1 : 0);

    return {
        baseConcurrentLimit,
        effectiveConcurrentLimit,
        dispatchCapacity,
        queuePressure,
        blockedReasons,
        warnings,
    };
};
