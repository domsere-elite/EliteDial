import type { Campaign, CampaignContact } from '@prisma/client';
import { dncService } from './dnc';
import { complianceFrequency, RegFCheckResult } from './compliance-frequency';
import { isWithinCallingWindow, nextCallingWindowStart } from './tcpa';
import { logger } from '../utils/logger';

export interface DialPrecheckResult {
    allowed: boolean;
    blockedReasons: string[];
    deferUntil?: Date;
}

export interface DialPrecheckDeps {
    tcpa: {
        isWithinCallingWindow(tz: string | null): boolean;
        nextCallingWindowStart(tz: string | null, now?: Date): Date;
    };
    dnc: { isOnDNC(phone: string): Promise<boolean> };
    regF: { checkRegF(phone: string): Promise<RegFCheckResult> };
    clock?: () => Date;
}

export interface DialPrecheck {
    precheck(
        campaign: Pick<Campaign, 'timezone'>,
        contact: Pick<CampaignContact, 'primaryPhone' | 'timezone'>,
    ): Promise<DialPrecheckResult>;
}

export function buildDialPrecheck(deps: DialPrecheckDeps): DialPrecheck {
    return {
        async precheck(campaign, contact): Promise<DialPrecheckResult> {
            const blockedReasons: string[] = [];
            let deferUntil: Date | undefined;

            // Resolve effective timezone: contact overrides campaign
            const tz: string | null = contact.timezone || campaign.timezone || null;

            // 1. TCPA calling window check (synchronous)
            const inWindow = deps.tcpa.isWithinCallingWindow(tz);
            if (!inWindow) {
                blockedReasons.push('tcpa_quiet_hours');
                deferUntil = deps.tcpa.nextCallingWindowStart(tz);
            }

            // 2. DNC check (async, fail-safe block on error)
            try {
                const onDNC = await deps.dnc.isOnDNC(contact.primaryPhone);
                if (onDNC) {
                    blockedReasons.push('dnc_listed');
                }
            } catch (err) {
                logger.error('DNC check threw in dial-precheck — fail-safe block', { phone: contact.primaryPhone, error: err });
                blockedReasons.push('dnc_check_failed');
            }

            // 3. Reg F frequency cap check (async)
            const regFResult = await deps.regF.checkRegF(contact.primaryPhone);
            if (regFResult.blocked) {
                blockedReasons.push('reg_f_cap');
            }

            const allowed = blockedReasons.length === 0;
            return { allowed, blockedReasons, deferUntil };
        },
    };
}

export const dialPrecheck: DialPrecheck = buildDialPrecheck({
    tcpa: { isWithinCallingWindow, nextCallingWindowStart },
    dnc: { isOnDNC: (p) => dncService.isOnDNC(p) },
    regF: { checkRegF: (p) => complianceFrequency.checkRegF(p) },
});
