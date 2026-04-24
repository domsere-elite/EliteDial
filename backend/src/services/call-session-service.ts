import { Call, Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { logger } from '../utils/logger';

const toJsonInput = (value: unknown): Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput | undefined => {
    if (value === undefined || value === null) return undefined;
    return value as Prisma.InputJsonValue;
};

type CreateUnifiedCallInput = {
    provider: string;
    channel: 'human' | 'ai';
    mode: 'manual' | 'progressive' | 'ai_outbound' | 'inbound';
    direction: 'inbound' | 'outbound';
    fromNumber: string;
    toNumber: string;
    status?: string;
    agentId?: string | null;
    accountId?: string | null;
    accountName?: string | null;
    campaignId?: string | null;
    contactId?: string | null;
    leadExternalId?: string | null;
    providerCallId?: string | null;
    providerMetadata?: unknown;
    crmContext?: unknown;
    duration?: number;
    completedAt?: Date | null;
    fdcpaNotice?: boolean;
    dncChecked?: boolean;
};

type UpdateProviderStatusInput = {
    provider: string;
    providerCallId: string;
    status: string;
    duration?: number;
    answeredAt?: Date | null;
    completedAt?: Date | null;
    providerMetadata?: unknown;
};

type RecordingInput = {
    provider: string;
    providerCallId?: string | null;
    callId?: string | null;
    providerRecordingId?: string | null;
    url: string;
    archiveUrl?: string | null;
    status?: string;
    duration?: number | null;
    metadata?: unknown;
};

type TranscriptInput = {
    provider: string;
    providerCallId?: string | null;
    callId?: string | null;
    providerTranscriptId?: string | null;
    sourceType?: string;
    status?: string;
    text: string;
    summary?: string | null;
    metadata?: unknown;
};

type CallEventInput = {
    sessionId?: string | null;
    callId?: string | null;
    provider?: string | null;
    providerCallId?: string | null;
    type: string;
    source: string;
    status?: string | null;
    idempotencyKey?: string | null;
    payload?: unknown;
};

export class CallSessionService {
    async createUnifiedCall(input: CreateUnifiedCallInput) {
        const status = input.status || 'initiated';

        return prisma.$transaction(async (tx) => {
            const call = await tx.call.create({
                data: {
                    provider: input.provider,
                    channel: input.channel,
                    mode: input.mode,
                    direction: input.direction,
                    fromNumber: input.fromNumber,
                    toNumber: input.toNumber,
                    status,
                    agentId: input.agentId,
                    accountId: input.accountId,
                    accountName: input.accountName,
                    providerCallId: input.providerCallId,
                    signalwireCallSid: input.provider === 'signalwire' ? (input.providerCallId || null) : null,
                    providerMetadata: toJsonInput(input.providerMetadata),
                    duration: input.duration || 0,
                    completedAt: input.completedAt || undefined,
                    fdcpaNotice: input.fdcpaNotice ?? false,
                    dncChecked: input.dncChecked ?? false,
                },
            });

            const session = await tx.callSession.create({
                data: {
                    callId: call.id,
                    provider: input.provider,
                    providerCallId: input.providerCallId,
                    channel: input.channel,
                    mode: input.mode,
                    direction: input.direction,
                    fromNumber: input.fromNumber,
                    toNumber: input.toNumber,
                    status,
                    agentId: input.agentId,
                    accountId: input.accountId,
                    accountName: input.accountName,
                    campaignId: input.campaignId,
                    contactId: input.contactId,
                    leadExternalId: input.leadExternalId,
                    providerMetadata: toJsonInput(input.providerMetadata),
                    crmContext: toJsonInput(input.crmContext),
                    lastEventAt: new Date(),
                    completedAt: input.completedAt || undefined,
                },
            });

            return { call, session };
        });
    }

    async syncCall(callId: string, overrides: Partial<CreateUnifiedCallInput> = {}) {
        const call = await prisma.call.findUnique({ where: { id: callId } });
        if (!call) return null;

        const session = await prisma.callSession.upsert({
            where: { callId },
            create: this.buildSessionCreate(call, overrides),
            update: this.buildSessionUpdate(call, overrides),
        });

        return { call, session };
    }

    async attachProviderIdentifiers(callId: string, params: {
        provider: string;
        providerCallId?: string | null;
        providerMetadata?: unknown;
    }) {
        const updatedCall = await prisma.call.update({
            where: { id: callId },
            data: {
                provider: params.provider,
                providerCallId: params.providerCallId,
                signalwireCallSid: params.provider === 'signalwire' ? (params.providerCallId || null) : undefined,
                providerMetadata: toJsonInput(params.providerMetadata),
            },
        });

        const session = await prisma.callSession.upsert({
            where: { callId },
            create: this.buildSessionCreate(updatedCall, {
                provider: params.provider,
                providerCallId: params.providerCallId,
                providerMetadata: params.providerMetadata,
            }),
            update: {
                provider: params.provider,
                providerCallId: params.providerCallId,
                providerMetadata: toJsonInput(params.providerMetadata),
                lastEventAt: new Date(),
            },
        });

        return { call: updatedCall, session };
    }

    async findSessionByProviderCall(provider: string, providerCallId: string) {
        return prisma.callSession.findUnique({
            where: { provider_providerCallId: { provider, providerCallId } },
            include: { call: true },
        });
    }

    async updateProviderStatus(input: UpdateProviderStatusInput) {
        const session = await this.findSessionByProviderCall(input.provider, input.providerCallId);
        if (!session) {
            logger.warn('Call session not found for provider update', input);
            return null;
        }

        const completedAt = input.completedAt || (['completed', 'failed', 'busy', 'no-answer', 'voicemail'].includes(input.status) ? new Date() : null);
        const answeredAt = input.answeredAt || (input.status === 'in-progress' ? new Date() : null);

        const [updatedSession, updatedCall] = await prisma.$transaction([
            prisma.callSession.update({
                where: { id: session.id },
                data: {
                    status: input.status,
                    answeredAt: answeredAt || undefined,
                    completedAt: completedAt || undefined,
                    lastEventAt: new Date(),
                    providerMetadata: toJsonInput(input.providerMetadata),
                },
            }),
            session.callId
                ? prisma.call.update({
                    where: { id: session.callId },
                    data: {
                        status: input.status,
                        duration: input.duration === undefined ? undefined : input.duration,
                        completedAt: completedAt || undefined,
                        providerMetadata: toJsonInput(input.providerMetadata),
                    },
                })
                : prisma.call.create({
                    data: {
                        provider: session.provider,
                        channel: session.channel,
                        mode: session.mode,
                        direction: session.direction,
                        fromNumber: session.fromNumber,
                        toNumber: session.toNumber,
                        status: input.status,
                        duration: input.duration || 0,
                        accountId: session.accountId,
                        accountName: session.accountName,
                        agentId: session.agentId,
                        providerCallId: session.providerCallId,
                        signalwireCallSid: session.provider === 'signalwire' ? session.providerCallId : null,
                        providerMetadata: toJsonInput(input.providerMetadata === undefined ? session.providerMetadata : input.providerMetadata),
                        completedAt: completedAt || undefined,
                    },
                }),
        ]);

        if (!session.callId) {
            await prisma.callSession.update({
                where: { id: session.id },
                data: { callId: updatedCall.id },
            });
        }

        return { session: updatedSession, call: updatedCall };
    }

    async upsertEvent(input: CallEventInput) {
        try {
            return await prisma.callEvent.create({
                data: {
                    sessionId: input.sessionId,
                    callId: input.callId,
                    provider: input.provider || undefined,
                    providerCallId: input.providerCallId || undefined,
                    type: input.type,
                    source: input.source,
                    status: input.status || undefined,
                    idempotencyKey: input.idempotencyKey || undefined,
                    payload: toJsonInput(input.payload),
                },
            });
        } catch (error) {
            if (
                input.idempotencyKey &&
                error instanceof Prisma.PrismaClientKnownRequestError &&
                error.code === 'P2002'
            ) {
                return prisma.callEvent.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
            }
            throw error;
        }
    }

    async addRecording(input: RecordingInput) {
        const sessionId = await this.resolveSessionId(input.provider, input.providerCallId, input.callId);
        const existing = input.providerRecordingId
            ? await prisma.callRecording.findFirst({
                where: {
                    provider: input.provider,
                    providerRecordingId: input.providerRecordingId,
                },
            })
            : null;

        const recording = existing
            ? await prisma.callRecording.update({
                where: { id: existing.id },
                data: {
                    sessionId,
                    callId: input.callId || existing.callId,
                    url: input.url,
                    archiveUrl: input.archiveUrl || undefined,
                    status: input.status || existing.status,
                    duration: input.duration === undefined ? existing.duration : input.duration,
                    metadata: toJsonInput(input.metadata === undefined ? existing.metadata : input.metadata),
                },
            })
            : await prisma.callRecording.create({
                data: {
                    sessionId,
                    callId: input.callId || undefined,
                    provider: input.provider,
                    providerRecordingId: input.providerRecordingId || undefined,
                    url: input.url,
                    archiveUrl: input.archiveUrl || undefined,
                    status: input.status || 'available',
                    duration: input.duration === undefined ? undefined : input.duration,
                    metadata: toJsonInput(input.metadata),
                },
            });

        if (input.callId) {
            await prisma.call.update({
                where: { id: input.callId },
                data: { recordingUrl: input.url },
            });
        }

        return recording;
    }

    async addTranscript(input: TranscriptInput) {
        const sessionId = await this.resolveSessionId(input.provider, input.providerCallId, input.callId);
        const existing = input.providerTranscriptId
            ? await prisma.callTranscript.findFirst({
                where: {
                    provider: input.provider,
                    providerTranscriptId: input.providerTranscriptId,
                },
            })
            : null;

        return existing
            ? prisma.callTranscript.update({
                where: { id: existing.id },
                data: {
                    sessionId,
                    callId: input.callId || existing.callId,
                    text: input.text,
                    summary: input.summary || undefined,
                    sourceType: input.sourceType || existing.sourceType,
                    status: input.status || existing.status,
                    metadata: toJsonInput(input.metadata === undefined ? existing.metadata : input.metadata),
                },
            })
            : prisma.callTranscript.create({
                data: {
                    sessionId,
                    callId: input.callId || undefined,
                    provider: input.provider,
                    providerTranscriptId: input.providerTranscriptId || undefined,
                    sourceType: input.sourceType || 'recording',
                    status: input.status || 'available',
                    text: input.text,
                    summary: input.summary || undefined,
                    metadata: toJsonInput(input.metadata),
                },
            });
    }

    async resolveSessionId(provider: string, providerCallId?: string | null, callId?: string | null) {
        if (callId) {
            const byCall = await prisma.callSession.findUnique({ where: { callId }, select: { id: true } });
            if (byCall?.id) return byCall.id;
        }

        if (providerCallId) {
            const byProvider = await prisma.callSession.findUnique({
                where: { provider_providerCallId: { provider, providerCallId } },
                select: { id: true },
            });
            if (byProvider?.id) return byProvider.id;
        }

        return null;
    }

    private buildSessionCreate(call: Call, overrides: Partial<CreateUnifiedCallInput>): Prisma.CallSessionCreateInput {
        return {
            call: { connect: { id: call.id } },
            provider: overrides.provider || call.provider,
            providerCallId: overrides.providerCallId ?? call.providerCallId ?? call.signalwireCallSid ?? undefined,
            channel: overrides.channel || (call.channel as 'human' | 'ai'),
            mode: overrides.mode || (call.mode as CreateUnifiedCallInput['mode']),
            direction: call.direction,
            fromNumber: call.fromNumber,
            toNumber: call.toNumber,
            status: overrides.status || call.status,
            accountId: overrides.accountId ?? call.accountId ?? undefined,
            accountName: overrides.accountName ?? call.accountName ?? undefined,
            agent: call.agentId ? { connect: { id: call.agentId } } : undefined,
            campaign: overrides.campaignId ? { connect: { id: overrides.campaignId } } : undefined,
            contact: overrides.contactId ? { connect: { id: overrides.contactId } } : undefined,
            leadExternalId: overrides.leadExternalId ?? undefined,
            providerMetadata: toJsonInput(overrides.providerMetadata === undefined ? (call.providerMetadata || undefined) : overrides.providerMetadata),
            crmContext: toJsonInput(overrides.crmContext),
            startedAt: call.createdAt,
            completedAt: call.completedAt ?? undefined,
            lastEventAt: call.completedAt || call.createdAt,
        };
    }

    private buildSessionUpdate(call: Call, overrides: Partial<CreateUnifiedCallInput>): Prisma.CallSessionUpdateInput {
        return {
            provider: overrides.provider || call.provider,
            providerCallId: overrides.providerCallId ?? call.providerCallId ?? call.signalwireCallSid ?? undefined,
            channel: overrides.channel || (call.channel as 'human' | 'ai'),
            mode: overrides.mode || (call.mode as CreateUnifiedCallInput['mode']),
            direction: call.direction,
            fromNumber: call.fromNumber,
            toNumber: call.toNumber,
            status: overrides.status || call.status,
            accountId: overrides.accountId ?? call.accountId ?? undefined,
            accountName: overrides.accountName ?? call.accountName ?? undefined,
            agent: call.agentId ? { connect: { id: call.agentId } } : { disconnect: true },
            campaign: overrides.campaignId ? { connect: { id: overrides.campaignId } } : undefined,
            contact: overrides.contactId ? { connect: { id: overrides.contactId } } : undefined,
            leadExternalId: overrides.leadExternalId ?? undefined,
            providerMetadata: toJsonInput(overrides.providerMetadata === undefined ? (call.providerMetadata || undefined) : overrides.providerMetadata),
            crmContext: toJsonInput(overrides.crmContext),
            completedAt: call.completedAt ?? undefined,
            lastEventAt: new Date(),
        };
    }
}

export const callSessionService = new CallSessionService();
