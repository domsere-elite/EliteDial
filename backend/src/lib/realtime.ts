import { getIO, emitToRole, emitToUser } from './socket';

// ─── Realtime broadcast helpers ─────────────────
// These functions wrap Socket.IO emitters for key domain events.
// Wire them into routes / services when ready — no existing files are modified.

export interface CallStatusPayload {
    callId: string;
    status: string;
    agentId?: string;
    campaignId?: string;
    [key: string]: unknown;
}

export interface AgentStatusPayload {
    agentId: string;
    userId: string;
    status: string;
    [key: string]: unknown;
}

export interface DialerStatsPayload {
    campaignId?: string;
    activeCalls: number;
    availableAgents: number;
    callsToday: number;
    [key: string]: unknown;
}

/**
 * Broadcast a call status change to the assigned agent and all supervisors/admins.
 */
export function broadcastCallStatus(call: CallStatusPayload): void {
    // Notify the agent who owns the call
    if (call.agentId) {
        emitToUser(call.agentId, 'call:status', call);
    }

    // Supervisors and admins always see call updates
    emitToRole('supervisor', 'call:status', call);
    emitToRole('admin', 'call:status', call);
}

/**
 * Broadcast an agent status change to supervisors and admins.
 */
export function broadcastAgentStatus(agent: AgentStatusPayload): void {
    // Let the agent themselves know
    emitToUser(agent.userId, 'agent:status', agent);

    // Supervisors and admins see agent status
    emitToRole('supervisor', 'agent:status', agent);
    emitToRole('admin', 'agent:status', agent);
}

/**
 * Broadcast dialer / campaign statistics to supervisors and admins.
 */
export function broadcastDialerStats(stats: DialerStatsPayload): void {
    emitToRole('supervisor', 'dialer:stats', stats);
    emitToRole('admin', 'dialer:stats', stats);
}

/**
 * Broadcast a campaign update to all roles (agents may need to see assignment changes).
 */
export function broadcastCampaignUpdate(data: Record<string, unknown>): void {
    const io = getIO();
    io.emit('campaign:update', data);
}
