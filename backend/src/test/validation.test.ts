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
