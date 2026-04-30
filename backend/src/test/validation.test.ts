import test from 'node:test';
import assert from 'node:assert/strict';

import {
    registerSchema,
    initiateCallSchema,
    createCampaignSchema,
    updateCampaignSchema,
    dispositionSchema,
    addDncSchema,
    bulkDncImportSchema,
    transferSchema,
    resetPasswordSchema,
    updateAgentStatusSchema,
} from '../lib/validation';

// ─── registerSchema ─────────────────────────────

test('registerSchema: valid input passes', () => {
    const result = registerSchema.safeParse({
        email: 'user@example.com',
        password: 'password123',
        firstName: 'Jane',
        lastName: 'Doe',
    });
    assert.ok(result.success);
    assert.equal(result.data!.role, 'agent'); // default
});

test('registerSchema: invalid email fails', () => {
    const result = registerSchema.safeParse({
        email: 'not-an-email',
        password: 'password123',
        firstName: 'Jane',
        lastName: 'Doe',
    });
    assert.equal(result.success, false);
});

test('registerSchema: short password fails', () => {
    const result = registerSchema.safeParse({
        email: 'user@example.com',
        password: 'short',
        firstName: 'Jane',
        lastName: 'Doe',
    });
    assert.equal(result.success, false);
});

test('registerSchema: valid role enum passes', () => {
    const result = registerSchema.safeParse({
        email: 'user@example.com',
        password: 'password123',
        firstName: 'Jane',
        lastName: 'Doe',
        role: 'supervisor',
    });
    assert.ok(result.success);
    assert.equal(result.data!.role, 'supervisor');
});

test('registerSchema: invalid role fails', () => {
    const result = registerSchema.safeParse({
        email: 'user@example.com',
        password: 'password123',
        firstName: 'Jane',
        lastName: 'Doe',
        role: 'superadmin',
    });
    assert.equal(result.success, false);
});

test('registerSchema: missing email fails', () => {
    const result = registerSchema.safeParse({
        password: 'password123',
        firstName: 'Jane',
        lastName: 'Doe',
    });
    assert.equal(result.success, false);
});

// ─── initiateCallSchema ─────────────────────────

test('initiateCallSchema: valid passes', () => {
    const result = initiateCallSchema.safeParse({
        toNumber: '+12145550100',
    });
    assert.ok(result.success);
    assert.equal(result.data!.mode, 'agent'); // default
});

test('initiateCallSchema: missing toNumber fails', () => {
    const result = initiateCallSchema.safeParse({});
    assert.equal(result.success, false);
});

test('initiateCallSchema: invalid mode fails', () => {
    const result = initiateCallSchema.safeParse({
        toNumber: '+12145550100',
        mode: 'robot',
    });
    assert.equal(result.success, false);
});

// ─── createCampaignSchema ───────────────────────

test('createCampaignSchema: valid with defaults', () => {
    const result = createCampaignSchema.safeParse({ name: 'Test Campaign' });
    assert.ok(result.success);
    assert.equal(result.data!.dialMode, 'manual');
    assert.equal(result.data!.timezone, 'America/Chicago');
    assert.equal(result.data!.maxAttemptsPerLead, 6);
});

test('createCampaignSchema: name required', () => {
    const result = createCampaignSchema.safeParse({});
    assert.equal(result.success, false);
});

// ─── dispositionSchema ──────────────────────────

test('dispositionSchema: valid passes', () => {
    const result = dispositionSchema.safeParse({ dispositionId: 'dispo_123' });
    assert.ok(result.success);
});

test('dispositionSchema: missing dispositionId fails', () => {
    const result = dispositionSchema.safeParse({});
    assert.equal(result.success, false);
});

// ─── addDncSchema ───────────────────────────────

test('addDncSchema: valid passes', () => {
    const result = addDncSchema.safeParse({ phoneNumber: '2145550100' });
    assert.ok(result.success);
});

test('addDncSchema: empty phoneNumber fails', () => {
    const result = addDncSchema.safeParse({ phoneNumber: '' });
    assert.equal(result.success, false);
});

// ─── bulkDncImportSchema ────────────────────────

test('bulkDncImportSchema: valid passes', () => {
    const result = bulkDncImportSchema.safeParse({
        numbers: ['2145550100', '2145550101'],
    });
    assert.ok(result.success);
});

test('bulkDncImportSchema: empty array fails (min 1)', () => {
    const result = bulkDncImportSchema.safeParse({ numbers: [] });
    assert.equal(result.success, false);
});

// ─── transferSchema ─────────────────────────────

test('transferSchema: valid passes', () => {
    const result = transferSchema.safeParse({ targetNumber: '+12145550100' });
    assert.ok(result.success);
    assert.equal(result.data!.type, 'cold'); // default
});

test('transferSchema: invalid type fails', () => {
    const result = transferSchema.safeParse({
        targetNumber: '+12145550100',
        type: 'blind',
    });
    assert.equal(result.success, false);
});

// ─── resetPasswordSchema ────────────────────────

test('resetPasswordSchema: valid passes', () => {
    const result = resetPasswordSchema.safeParse({ newPassword: 'longenough1' });
    assert.ok(result.success);
});

test('resetPasswordSchema: short password fails (min 8)', () => {
    const result = resetPasswordSchema.safeParse({ newPassword: 'short' });
    assert.equal(result.success, false);
});

// ─── Phase 0: new dialMode enum ───

test('createCampaignSchema: default dialMode is manual', () => {
    const result = createCampaignSchema.safeParse({ name: 'Default Mode Campaign' });
    assert.ok(result.success);
    assert.equal(result.data!.dialMode, 'manual');
});

test('createCampaignSchema: ai_autonomous is accepted', () => {
    const result = createCampaignSchema.safeParse({ name: 'AI Campaign', dialMode: 'ai_autonomous' });
    assert.ok(result.success);
    assert.equal(result.data!.dialMode, 'ai_autonomous');
});

test('createCampaignSchema: predictive is rejected', () => {
    const result = createCampaignSchema.safeParse({ name: 'Old Campaign', dialMode: 'predictive' });
    assert.equal(result.success, false);
});

test('createCampaignSchema: preview is rejected', () => {
    const result = createCampaignSchema.safeParse({ name: 'Old Campaign', dialMode: 'preview' });
    assert.equal(result.success, false);
});

test('updateCampaignSchema: predictive is rejected', () => {
    const result = updateCampaignSchema.safeParse({ dialMode: 'predictive' });
    assert.equal(result.success, false);
});

// ─── Phase 1: power-dial config ───

test('createCampaignSchema: dialRatio defaults to 1.0', () => {
    const result = createCampaignSchema.safeParse({ name: 'Default Ratio' });
    assert.ok(result.success);
    assert.equal(result.data!.dialRatio, 1.0);
    assert.equal(result.data!.voicemailBehavior, 'hangup');
});

test('createCampaignSchema: dialRatio=3 accepted', () => {
    const result = createCampaignSchema.safeParse({ name: 'Power Dial', dialRatio: 3 });
    assert.ok(result.success);
    assert.equal(result.data!.dialRatio, 3);
});

test('createCampaignSchema: dialRatio below 1.0 rejected', () => {
    const result = createCampaignSchema.safeParse({ name: 'Bad Ratio', dialRatio: 0.5 });
    assert.equal(result.success, false);
});

test('createCampaignSchema: dialRatio above 5.0 rejected', () => {
    const result = createCampaignSchema.safeParse({ name: 'Bad Ratio', dialRatio: 6 });
    assert.equal(result.success, false);
});

test('createCampaignSchema: leave_message without voicemailMessage rejected', () => {
    const result = createCampaignSchema.safeParse({
        name: 'VM Campaign',
        voicemailBehavior: 'leave_message',
    });
    assert.equal(result.success, false);
});

test('createCampaignSchema: leave_message with voicemailMessage accepted', () => {
    const result = createCampaignSchema.safeParse({
        name: 'VM Campaign',
        voicemailBehavior: 'leave_message',
        voicemailMessage: 'Please call us back at 555-1234.',
    });
    assert.ok(result.success);
    assert.equal(result.data!.voicemailBehavior, 'leave_message');
});

test('updateCampaignSchema: dialRatio editable mid-campaign', () => {
    const result = updateCampaignSchema.safeParse({ dialRatio: 2.5 });
    assert.ok(result.success);
    assert.equal(result.data!.dialRatio, 2.5);
});

test('updateCampaignSchema: dialRatio bounds enforced', () => {
    assert.equal(updateCampaignSchema.safeParse({ dialRatio: 0 }).success, false);
    assert.equal(updateCampaignSchema.safeParse({ dialRatio: 10 }).success, false);
});

// ─── Phase 3b: wrap-up status and wrapUpSeconds ───

test('updateAgentStatusSchema: wrap-up is accepted', () => {
    const result = updateAgentStatusSchema.safeParse({ status: 'wrap-up' });
    assert.equal(result.success, true);
});

test('updateAgentStatusSchema: invalid status rejected', () => {
    const result = updateAgentStatusSchema.safeParse({ status: 'foobar' });
    assert.equal(result.success, false);
});

test('updateCampaignSchema: wrapUpSeconds defaults to 30', () => {
    const parsed = updateCampaignSchema.parse({ name: 'test' });
    assert.equal(parsed.wrapUpSeconds, 30);
});

test('updateCampaignSchema: wrapUpSeconds bounds enforced (0-300)', () => {
    assert.equal(updateCampaignSchema.safeParse({ name: 'x', wrapUpSeconds: -1 }).success, false);
    assert.equal(updateCampaignSchema.safeParse({ name: 'x', wrapUpSeconds: 301 }).success, false);
    assert.equal(updateCampaignSchema.safeParse({ name: 'x', wrapUpSeconds: 0 }).success, true);
    assert.equal(updateCampaignSchema.safeParse({ name: 'x', wrapUpSeconds: 300 }).success, true);
});
