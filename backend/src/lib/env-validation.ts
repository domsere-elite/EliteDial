import { config } from '../config';
import { prisma } from './prisma';
import { logger } from '../utils/logger';

export interface BootEnvSnapshot {
    signalwire: { projectId: string; apiToken: string; spaceUrl: string };
    retell: { apiKey: string };
}

export interface BootEnvCheck {
    ok: boolean;
    errors: string[];
    warnings: string[];
}

export function checkBootEnv(snap: BootEnvSnapshot): BootEnvCheck {
    const errors: string[] = [];
    const warnings: string[] = [];

    const swSet = [snap.signalwire.projectId, snap.signalwire.apiToken, snap.signalwire.spaceUrl]
        .filter(v => v && v.length > 0).length;
    if (swSet > 0 && swSet < 3) {
        errors.push(
            'SIGNALWIRE_PROJECT_ID, SIGNALWIRE_API_TOKEN, and SIGNALWIRE_SPACE_URL must all be set together (live mode) or all be empty (mock mode). Partial config is rejected.',
        );
    }

    if (swSet === 3 && !snap.retell.apiKey) {
        warnings.push(
            'SignalWire is configured but RETELL_API_KEY is not. ai_autonomous campaigns will be skipped by the worker until Retell is configured.',
        );
    }

    return { ok: errors.length === 0, errors, warnings };
}

export function validateEnvOrExit(): void {
    const result = checkBootEnv({
        signalwire: {
            projectId: config.signalwire.projectId,
            apiToken: config.signalwire.apiToken,
            spaceUrl: config.signalwire.spaceUrl,
        },
        retell: { apiKey: config.retell.apiKey },
    });
    for (const w of result.warnings) logger.warn(w);
    if (!result.ok) {
        for (const e of result.errors) logger.error(e);
        process.exit(1);
    }
}

export async function validateActivationsOrWarn(): Promise<void> {
    const broken = await prisma.campaign.findMany({
        where: {
            status: 'active',
            dialMode: 'ai_autonomous',
            OR: [
                { retellAgentId: null },
                { retellSipAddress: null },
            ],
        },
        select: { id: true, name: true },
    });
    for (const c of broken) {
        logger.error('Active ai_autonomous campaign missing required Retell config — worker will skip it', {
            campaignId: c.id,
            name: c.name,
        });
    }
}
