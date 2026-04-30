import { logger } from '../utils/logger';

export interface SchedulerDeps {
    exitWrapUp: (agentId: string) => Promise<{ transitioned: boolean }>;
}

export interface WrapUpScheduler {
    schedule(agentId: string, seconds: number): void;
    cancel(agentId: string): void;
}

export function buildWrapUpScheduler(deps: SchedulerDeps): WrapUpScheduler {
    const timers = new Map<string, NodeJS.Timeout>();
    return {
        schedule(agentId, seconds) {
            const existing = timers.get(agentId);
            if (existing) clearTimeout(existing);
            const t = setTimeout(() => {
                timers.delete(agentId);
                deps.exitWrapUp(agentId).catch((err) => {
                    // Worker tick + boot sweep is the recovery path; log for
                    // observability so transient failures aren't fully silent.
                    logger.debug('timer-based exitWrapUp failed, will be swept', { agentId, err });
                });
            }, seconds * 1000);
            timers.set(agentId, t);
        },
        cancel(agentId) {
            const t = timers.get(agentId);
            if (t) {
                clearTimeout(t);
                timers.delete(agentId);
            }
        },
    };
}

import { wrapUpService } from './wrap-up-service';

const productionScheduler = buildWrapUpScheduler({
    exitWrapUp: (agentId) => wrapUpService.exitWrapUp(agentId),
});

export function scheduleAutoResume(agentId: string, seconds: number): void {
    productionScheduler.schedule(agentId, seconds);
}

export function cancelAutoResume(agentId: string): void {
    productionScheduler.cancel(agentId);
}
