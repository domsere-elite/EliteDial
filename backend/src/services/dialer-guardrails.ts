type GuardrailInputs = {
    dialMode: string;
    dialRatio: number;
    maxConcurrentCalls: number;
    availableAgents: number;
    activeCalls: number;
    abandonRateLimit: number;
    recentCompletedAttempts: number;
    recentAbandonedAttempts: number;
    predictiveOverdialEnabled: boolean;
};

export type DialerGuardrailSummary = {
    baseConcurrentLimit: number;
    effectiveConcurrentLimit: number;
    dispatchCapacity: number;
    queuePressure: number;
    recentAbandonRate: number;
    recentCompletedAttempts: number;
    recentAbandonedAttempts: number;
    blockedReasons: string[];
    warnings: string[];
};

export const DIALER_STATS_WINDOW_MINUTES = 15;

export const computeDialerGuardrails = (input: GuardrailInputs): DialerGuardrailSummary => {
    const ratio = Math.max(0.5, input.dialRatio || 1);
    const isPredictive = input.dialMode === 'predictive';

    let baseConcurrentLimit = input.availableAgents * (isPredictive ? ratio : 1);
    if (input.maxConcurrentCalls > 0) {
        baseConcurrentLimit = Math.min(baseConcurrentLimit, input.maxConcurrentCalls);
    }
    baseConcurrentLimit = Math.floor(baseConcurrentLimit);

    const warnings: string[] = [];
    const blockedReasons: string[] = [];

    let effectiveConcurrentLimit = baseConcurrentLimit;
    if (isPredictive && !input.predictiveOverdialEnabled) {
        effectiveConcurrentLimit = Math.min(effectiveConcurrentLimit, input.availableAgents);
        if (effectiveConcurrentLimit < baseConcurrentLimit) {
            warnings.push('safe_predictive_cap');
        }
    }

    if (input.availableAgents <= 0) {
        blockedReasons.push('no_available_agents');
    }

    const recentAbandonRate = input.recentCompletedAttempts > 0
        ? input.recentAbandonedAttempts / input.recentCompletedAttempts
        : 0;

    if (input.recentCompletedAttempts >= 5 && recentAbandonRate >= input.abandonRateLimit) {
        blockedReasons.push('abandon_rate_limit');
    }

    if (effectiveConcurrentLimit > 0 && input.activeCalls >= effectiveConcurrentLimit) {
        blockedReasons.push('queue_backpressure');
    }

    const dispatchCapacity = blockedReasons.length > 0
        ? 0
        : Math.max(0, effectiveConcurrentLimit - input.activeCalls);

    const queuePressure = input.availableAgents > 0
        ? input.activeCalls / input.availableAgents
        : (input.activeCalls > 0 ? 1 : 0);

    return {
        baseConcurrentLimit,
        effectiveConcurrentLimit,
        dispatchCapacity,
        queuePressure,
        recentAbandonRate,
        recentCompletedAttempts: input.recentCompletedAttempts,
        recentAbandonedAttempts: input.recentAbandonedAttempts,
        blockedReasons,
        warnings,
    };
};
