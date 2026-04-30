export interface SchedulerDeps {
    exitWrapUp: (agentId: string) => Promise<{ transitioned: boolean }>;
}

export interface WrapUpScheduler {
    schedule(agentId: string, seconds: number): void;
    cancel(agentId: string): void;
    cancelAll(): void;
}

export function buildWrapUpScheduler(deps: SchedulerDeps): WrapUpScheduler {
    const timers = new Map<string, NodeJS.Timeout>();
    return {
        schedule(agentId, seconds) {
            const existing = timers.get(agentId);
            if (existing) clearTimeout(existing);
            const t = setTimeout(() => {
                timers.delete(agentId);
                deps.exitWrapUp(agentId).catch(() => { /* swept by tick fallback */ });
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
        cancelAll() {
            for (const t of timers.values()) clearTimeout(t);
            timers.clear();
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
