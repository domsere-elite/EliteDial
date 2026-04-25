import { EventEmitter } from 'node:events';

export type EventMap = {
    'call.terminal':       { callId: string; signalwireCallId: string; campaignId: string | null; status: string };
    'campaign.activated':  { campaignId: string };
    'campaign.paused':     { campaignId: string };
};

type EventName = keyof EventMap;

export interface EventBus {
    on<E extends EventName>(event: E, listener: (payload: EventMap[E]) => void): void;
    off<E extends EventName>(event: E, listener: (payload: EventMap[E]) => void): void;
    emit<E extends EventName>(event: E, payload: EventMap[E]): void;
}

export function buildEventBus(): EventBus {
    const emitter = new EventEmitter();
    emitter.setMaxListeners(50);
    return {
        on: (event, listener) => { emitter.on(event, listener as (...args: any[]) => void); },
        off: (event, listener) => { emitter.off(event, listener as (...args: any[]) => void); },
        emit: (event, payload) => { emitter.emit(event, payload); },
    };
}

export const eventBus: EventBus = buildEventBus();
