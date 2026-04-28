import { z } from 'zod';
import { Request, Response, NextFunction } from 'express';

// ─── Validation Middleware ───────────────────────
export function validate<T extends z.ZodType>(schema: T) {
    return (req: Request, res: Response, next: NextFunction): void => {
        const result = schema.safeParse(req.body);
        if (!result.success) {
            const errors = result.error.issues.map((i) => ({
                path: i.path.join('.'),
                message: i.message,
            }));
            res.status(400).json({ error: 'Validation failed', details: errors });
            return;
        }
        req.body = result.data;
        next();
    };
}

// ─── Shared primitives ──────────────────────────
const phoneNumber = z.string().min(1).max(30);
const optionalString = z.string().optional();

// ─── Auth Schemas ────────────────────────────────
// Login is handled directly by Supabase (supabase.auth.signInWithPassword) on
// the frontend; refresh/logout/change-password are also frontend-only via
// supabase-js. The only auth schema we still validate at the API edge is
// /register, which an admin uses to provision a new user.
export const registerSchema = z.object({
    email: z.string().email('Valid email is required'),
    password: z.string().min(8, 'Password must be at least 8 characters'),
    firstName: z.string().min(1, 'First name is required').max(100),
    lastName: z.string().min(1, 'Last name is required').max(100),
    role: z.enum(['agent', 'supervisor', 'admin']).optional().default('agent'),
    extension: optionalString,
});

// ─── Agent Schemas ───────────────────────────────
export const updateAgentStatusSchema = z.object({
    status: z.enum(['available', 'break', 'offline', 'on-call']),
});

// ─── Call Schemas ────────────────────────────────
export const initiateCallSchema = z.object({
    toNumber: phoneNumber,
    fromNumber: optionalString,
    accountId: optionalString,
    accountName: optionalString,
    mode: z.enum(['agent', 'ai']).optional().default('agent'),
    aiTarget: optionalString,
    amdEnabled: z.boolean().optional(),
    aiAgentId: optionalString,
    dynamicVariables: z.record(z.string(), z.unknown()).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    mockScenario: optionalString,
    reservationToken: optionalString,
    campaignContactId: optionalString,
});

export const browserSessionSchema = z.object({
    toNumber: phoneNumber,
    fromNumber: optionalString,
    accountId: optionalString,
    accountName: optionalString,
    reservationToken: optionalString,
    campaignContactId: optionalString,
});

export const browserStatusSchema = z.object({
    providerCallId: optionalString,
    relayState: optionalString,
    previousRelayState: optionalString,
    duration: z.number().optional(),
    details: z.record(z.string(), z.unknown()).optional(),
});

export const dispositionSchema = z.object({
    dispositionId: z.string().min(1, 'dispositionId is required'),
    note: optionalString,
    callbackAt: z.string().datetime().optional().or(z.string().optional()),
});

export const transferSchema = z.object({
    targetNumber: phoneNumber,
    type: z.enum(['cold', 'warm']).optional().default('cold'),
});

export const simulateInboundSchema = z.object({
    scenario: z.enum(['answer', 'no-answer', 'voicemail']).optional().default('answer'),
    fromNumber: optionalString,
    toNumber: optionalString,
});

export const inboundAttachSchema = z.object({
    callSid: z.string().min(1, 'callSid is required'),
    fromNumber: optionalString,
    toNumber: optionalString,
});

// ─── Campaign Schemas ────────────────────────────
// Bounded between 1.0 (strict 1:1) and 5.0 — guards against runaway power-dial
// configurations. Float allows 1.5/2.5 for shops that want gradual ratios.
const dialRatioField = z.number().min(1.0).max(5.0);
const voicemailBehaviorField = z.enum(['hangup', 'leave_message']);

export const createCampaignSchema = z.object({
    name: z.string().min(1, 'Name is required').max(200),
    description: optionalString,
    dialMode: z.enum(['manual', 'progressive', 'ai_autonomous']).optional().default('manual'),
    timezone: z.string().optional().default('America/Chicago'),
    maxAttemptsPerLead: z.number().int().min(1).max(50).optional().default(6),
    retryDelaySeconds: z.number().int().min(30).optional().default(600),
    maxConcurrentCalls: z.number().int().min(0).optional().default(0),
    dialRatio: dialRatioField.optional().default(1.0),
    voicemailBehavior: voicemailBehaviorField.optional().default('hangup'),
    voicemailMessage: optionalString,
    retellAgentId: z.string().nullable().optional(),
    retellSipAddress: z.string().nullable().optional(),
}).refine(
    (data) => data.voicemailBehavior !== 'leave_message' || (data.voicemailMessage && data.voicemailMessage.trim().length > 0),
    { message: 'voicemailMessage is required when voicemailBehavior is leave_message', path: ['voicemailMessage'] },
);

export const updateCampaignSchema = z.object({
    name: optionalString,
    description: optionalString,
    dialMode: z.enum(['manual', 'progressive', 'ai_autonomous']).optional(),
    timezone: z.string().optional(),
    maxAttemptsPerLead: z.number().int().min(1).max(50).optional(),
    retryDelaySeconds: z.number().int().min(30).optional(),
    maxConcurrentCalls: z.number().int().min(0).optional(),
    dialRatio: dialRatioField.optional(),
    voicemailBehavior: voicemailBehaviorField.optional(),
    voicemailMessage: z.string().nullable().optional(),
    retellAgentId: z.string().nullable().optional(),
    retellSipAddress: z.string().nullable().optional(),
});

export const createCampaignListSchema = z.object({
    name: z.string().min(1, 'Name is required'),
    sourceType: z.string().optional().default('upload'),
});

export const importContactsSchema = z.object({
    rows: z.array(z.object({
        firstName: optionalString,
        lastName: optionalString,
        phone: optionalString,
        email: optionalString,
        accountId: optionalString,
        externalId: optionalString,
        timezone: optionalString,
        priority: z.number().optional(),
    })).optional(),
    csv: z.string().optional(),
    listName: optionalString,
});

// ─── Admin Schemas ───────────────────────────────
export const updateAgentSchema = z.object({
    firstName: z.string().min(1).max(100).optional(),
    lastName: z.string().min(1).max(100).optional(),
    email: z.string().email().optional(),
    role: z.enum(['agent', 'supervisor', 'admin']).optional(),
    extension: optionalString,
});

export const resetPasswordSchema = z.object({
    newPassword: z.string().min(8, 'Password must be at least 8 characters'),
});

export const createPhoneSchema = z.object({
    number: z.string().min(1, 'Number is required'),
    label: optionalString,
    type: z.string().optional(),
    assignedTo: optionalString,
});

export const addDncSchema = z.object({
    phoneNumber: phoneNumber,
    reason: optionalString,
});

export const bulkDncImportSchema = z.object({
    numbers: z.array(z.string()).min(1, 'numbers must be a non-empty array'),
    reason: optionalString,
});

export const updateQueueSchema = z.object({
    holdTimeout: z.number().int().optional(),
    overflowAction: z.string().optional(),
    holdMusicUrl: z.string().url().optional().or(z.literal('')).optional(),
    maxQueueSize: z.number().int().min(0).optional(),
    isActive: z.boolean().optional(),
});

export const createDispositionSchema = z.object({
    code: z.string().min(1, 'Code is required'),
    label: z.string().min(1, 'Label is required'),
    category: z.string().optional(),
});

export const createApiKeySchema = z.object({
    label: z.string().optional(),
});

export const createWebhookSchema = z.object({
    url: z.string().url('Valid URL is required'),
    secret: optionalString,
    events: z.array(z.string()).optional(),
});

// ─── Voicemail Schemas ───────────────────────────
export const assignVoicemailSchema = z.object({
    agentId: z.string().min(1, 'agentId is required'),
});

