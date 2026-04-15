import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildPredictiveAnswerHandler, PredictiveAnsweredContext } from '../services/predictive-answer-handler';

const makeDeps = (overrides: any = {}) => {
    const auditEvents: any[] = [];
    const createCallArgs: any[] = [];
    const hangupArgs: any[] = [];
    const attemptUpdates: any[] = [];
    const userUpdates: any[] = [];

    return {
        deps: {
            client: {
                createCall: async (args: any) => { createCallArgs.push(args); return { callControlId: 'agent-ccid-1' }; },
                hangup: async (args: any) => { hangupArgs.push(args); },
                bridge: async () => {},
            },
            prisma: {
                user: {
                    updateMany: async (args: any) => {
                        userUpdates.push(args);
                        return overrides.reservationResult ?? { count: 0 };
                    },
                    findFirst: async () => overrides.reservedUser ?? null,
                },
                campaign: {
                    findUnique: async () => overrides.campaign ?? { id: 'camp-1', aiOverflowNumber: null },
                },
                campaignAttempt: {
                    update: async (args: any) => { attemptUpdates.push(args); },
                },
            },
            systemSettings: {
                get: async () => overrides.globalOverflow ?? null,
            },
            callAudit: {
                track: async (e: any) => { auditEvents.push(e); },
            },
            config: {
                connectionId: 'conn-xyz',
                sipDomain: 'sip.telnyx.com',
                fromNumber: '+12818461926',
            },
        },
        auditEvents,
        createCallArgs,
        hangupArgs,
        attemptUpdates,
        userUpdates,
    };
};

const ctx = (over: Partial<PredictiveAnsweredContext> = {}): PredictiveAnsweredContext => ({
    callControlId: 'consumer-ccid-1',
    campaignId: 'camp-1',
    contactId: 'contact-1',
    attemptId: 'attempt-1',
    answeringMachineDetected: false,
    ...over,
});

describe('predictive-answer-handler', () => {
    it('bridges to agent when one is available', async () => {
        const t = makeDeps({
            reservationResult: { count: 1 },
            reservedUser: { id: 'user-1', telnyxSipUsername: 'ext100' },
        });
        const handler = buildPredictiveAnswerHandler(t.deps as any);
        await handler.onPredictiveAnswered(ctx());

        assert.equal(t.createCallArgs.length, 1);
        const call = t.createCallArgs[0];
        assert.equal(call.to, 'sip:ext100@sip.telnyx.com');
        assert.equal(call.connectionId, 'conn-xyz');
        assert.equal(call.clientState.stage, 'agent-bridge');
        assert.equal(call.clientState.bridgeWith, 'consumer-ccid-1');
        assert.ok(t.auditEvents.find((e) => e.type === 'dialer.predictive.bridged-agent'));
    });

    it('bridges to campaign aiOverflowNumber when no agent available', async () => {
        const t = makeDeps({
            reservationResult: { count: 0 },
            campaign: { id: 'camp-1', aiOverflowNumber: '+19998887777' },
        });
        const handler = buildPredictiveAnswerHandler(t.deps as any);
        await handler.onPredictiveAnswered(ctx());

        assert.equal(t.createCallArgs.length, 1);
        assert.equal(t.createCallArgs[0].to, '+19998887777');
        assert.equal(t.createCallArgs[0].clientState.stage, 'ai-overflow-bridge');
        assert.ok(t.auditEvents.find((e) => e.type === 'dialer.predictive.overflow-to-ai'));
    });

    it('bridges to global ai_overflow_number when no campaign override', async () => {
        const t = makeDeps({
            reservationResult: { count: 0 },
            campaign: { id: 'camp-1', aiOverflowNumber: null },
            globalOverflow: '+12762128412',
        });
        const handler = buildPredictiveAnswerHandler(t.deps as any);
        await handler.onPredictiveAnswered(ctx());

        assert.equal(t.createCallArgs[0].to, '+12762128412');
    });

    it('hangs up and logs bridge-failed when no overflow configured anywhere', async () => {
        const t = makeDeps({
            reservationResult: { count: 0 },
            campaign: { id: 'camp-1', aiOverflowNumber: null },
            globalOverflow: null,
        });
        const handler = buildPredictiveAnswerHandler(t.deps as any);
        await handler.onPredictiveAnswered(ctx());

        assert.equal(t.hangupArgs.length, 1);
        assert.equal(t.hangupArgs[0].callControlId, 'consumer-ccid-1');
        assert.ok(t.auditEvents.find((e) => e.type === 'dialer.predictive.bridge-failed'));
        assert.equal(t.attemptUpdates[0].data.outcome, 'bridge-failed');
    });

    it('marks voicemail when AMD detected machine', async () => {
        const t = makeDeps({ reservationResult: { count: 0 } });
        const handler = buildPredictiveAnswerHandler(t.deps as any);
        await handler.onPredictiveAnswered(ctx({ answeringMachineDetected: true }));

        assert.equal(t.hangupArgs.length, 1, 'should hang up');
        assert.equal(t.createCallArgs.length, 0, 'should not bridge');
        assert.equal(t.attemptUpdates[0].data.outcome, 'voicemail');
    });

    it('releases agent status if bridge createCall throws', async () => {
        const userUpdates: any[] = [];
        const auditEvents: any[] = [];
        const deps = {
            client: {
                createCall: async () => { throw new Error('boom'); },
                hangup: async () => {},
                bridge: async () => {},
            },
            prisma: {
                user: {
                    updateMany: async (args: any) => { userUpdates.push(args); return { count: 1 }; },
                    findFirst: async () => ({ id: 'user-1', telnyxSipUsername: 'ext100' }),
                },
                campaign: { findUnique: async () => ({ id: 'camp-1', aiOverflowNumber: null }) },
                campaignAttempt: { update: async () => {} },
            },
            systemSettings: { get: async () => null },
            callAudit: { track: async (e: any) => { auditEvents.push(e); } },
            config: { connectionId: 'c', sipDomain: 'sip.telnyx.com', fromNumber: '+1' },
        };
        const handler = buildPredictiveAnswerHandler(deps as any);
        await handler.onPredictiveAnswered(ctx());

        const releaseUpdate = userUpdates.find((u) => u.data?.status === 'available');
        assert.ok(releaseUpdate, 'should reset agent to available');
        assert.ok(auditEvents.find((e) => e.type === 'dialer.predictive.bridge-failed'));
    });

    it('records bridged-to-agent outcome', async () => {
        const t = makeDeps({
            reservationResult: { count: 1 },
            reservedUser: { id: 'user-1', telnyxSipUsername: 'ext100' },
        });
        const handler = buildPredictiveAnswerHandler(t.deps as any);
        await handler.onPredictiveAnswered(ctx());

        const update = t.attemptUpdates.find((u) => u.data?.outcome === 'bridged-to-agent');
        assert.ok(update, 'should record bridged-to-agent outcome');
    });

    it('records bridged-to-ai outcome on overflow', async () => {
        const t = makeDeps({
            reservationResult: { count: 0 },
            globalOverflow: '+12762128412',
        });
        const handler = buildPredictiveAnswerHandler(t.deps as any);
        await handler.onPredictiveAnswered(ctx());

        const update = t.attemptUpdates.find((u) => u.data?.outcome === 'bridged-to-ai');
        assert.ok(update, 'should record bridged-to-ai outcome');
    });
});
