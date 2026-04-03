import { prisma } from '../lib/prisma';
import { callAuditService } from './call-audit';
import { callSessionService } from './call-session-service';
import { logger } from '../utils/logger';

type MockScenario = 'answer' | 'no-answer' | 'voicemail' | 'transfer';

type ScheduleInput = {
    provider: string;
    providerCallId: string;
    callId?: string;
    fromNumber: string;
    toNumber: string;
    channel: 'human' | 'ai';
    scenario?: string;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const resolveScenario = (input: string | undefined, channel: 'human' | 'ai'): MockScenario => {
    if (input === 'no-answer' || input === 'voicemail' || input === 'transfer') return input;
    if (channel === 'ai' && input === 'answer') return 'transfer';
    return 'answer';
};

class MockCallLifecycleService {
    scheduleOutboundLifecycle(input: ScheduleInput) {
        const scenario = resolveScenario(input.scenario, input.channel);
        void this.runLifecycle({ ...input, scenario });
    }

    private async runLifecycle(input: ScheduleInput & { scenario: MockScenario }) {
        try {
            await sleep(1500);

            if (input.scenario === 'no-answer') {
                await this.transition(input, 'no-answer', 0);
                return;
            }

            await this.transition(input, 'in-progress', 0);
            await sleep(input.channel === 'ai' ? 2200 : 3500);

            if (input.scenario === 'voicemail') {
                await this.persistArtifacts(input, 38, 'Voicemail detected. Message left for callback.');
                await this.transition(input, 'voicemail', 38);
                return;
            }

            if (input.scenario === 'transfer') {
                await callAuditService.track({
                    type: 'ai.call.transfer',
                    callId: input.callId,
                    callSid: input.providerCallId,
                    details: {
                        provider: input.provider,
                        scenario: input.scenario,
                        transferTarget: 'mock-human-queue',
                    },
                    source: 'mock.lifecycle',
                    status: 'in-progress',
                });
            }

            const duration = input.channel === 'ai' ? 54 : 96;
            const transcript = input.channel === 'ai'
                ? 'Mock AI call completed. Customer engaged, verified account, and requested a live transfer.'
                : 'Mock human call completed. Agent verified the customer and completed a standard collection conversation.';

            await this.persistArtifacts(input, duration, transcript);
            await this.transition(input, 'completed', duration);
        } catch (error) {
            logger.error('Mock lifecycle failed', { error, providerCallId: input.providerCallId });
        }
    }

    private async transition(input: ScheduleInput & { scenario: MockScenario }, status: string, duration: number) {
        await callSessionService.updateProviderStatus({
            provider: input.provider,
            providerCallId: input.providerCallId,
            status,
            duration,
            providerMetadata: {
                mock: true,
                scenario: input.scenario,
                channel: input.channel,
            },
        });

        await callAuditService.track({
            type: 'call.status',
            callId: input.callId,
            callSid: input.providerCallId,
            details: {
                status,
                provider: input.provider,
                scenario: input.scenario,
            },
            source: 'mock.lifecycle',
            status,
        });
    }

    private async persistArtifacts(input: ScheduleInput & { scenario: MockScenario }, duration: number, transcript: string) {
        const recordingUrl = `mock://recordings/${input.providerCallId}.wav`;
        await callSessionService.addRecording({
            provider: input.provider,
            providerCallId: input.providerCallId,
            callId: input.callId,
            providerRecordingId: `${input.providerCallId}-recording`,
            url: recordingUrl,
            status: 'available',
            duration,
            metadata: {
                mock: true,
                scenario: input.scenario,
            },
        });

        await callAuditService.track({
            type: 'call.recording.ready',
            callId: input.callId,
            callSid: input.providerCallId,
            details: {
                provider: input.provider,
                url: recordingUrl,
            },
            source: 'mock.lifecycle',
            status: 'available',
        });

        await callSessionService.addTranscript({
            provider: input.provider,
            providerCallId: input.providerCallId,
            callId: input.callId,
            providerTranscriptId: `${input.providerCallId}-transcript`,
            sourceType: input.channel === 'ai' ? 'provider' : 'recording',
            status: 'available',
            text: transcript,
            summary: input.channel === 'ai' ? 'Mock AI conversation completed.' : 'Mock agent conversation completed.',
            metadata: {
                mock: true,
                scenario: input.scenario,
            },
        });

        await callAuditService.track({
            type: 'call.transcript.ready',
            callId: input.callId,
            callSid: input.providerCallId,
            details: {
                provider: input.provider,
                sourceType: input.channel === 'ai' ? 'provider' : 'recording',
            },
            source: 'mock.lifecycle',
            status: 'available',
        });

        if (input.scenario === 'voicemail' && input.channel === 'human') {
            await prisma.voicemail.create({
                data: {
                    fromNumber: input.toNumber,
                    toNumber: input.fromNumber,
                    duration,
                    transcription: transcript,
                },
            });
        }
    }
}

export const mockCallLifecycleService = new MockCallLifecycleService();
