import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { classifyImportCandidates } from '../services/campaign-import';

type Candidate = { normalizedPhone: string; priority?: number };

describe('classifyImportCandidates', () => {
    it('returns empty result when no candidates', () => {
        const result = classifyImportCandidates([], {
            existingPhones: new Set(),
            dncPhones: new Set(),
            regFBlockedPhones: new Set(),
        });
        assert.deepEqual(result, {
            toCreate: [],
            duplicateSuppressed: 0,
            dncSuppressed: 0,
            regFSuppressed: 0,
        });
    });

    it('keeps rows that pass all filters', () => {
        const rows: Candidate[] = [
            { normalizedPhone: '+14085551234' },
            { normalizedPhone: '+14085559999' },
        ];
        const result = classifyImportCandidates(rows, {
            existingPhones: new Set(),
            dncPhones: new Set(),
            regFBlockedPhones: new Set(),
        });
        assert.equal(result.toCreate.length, 2);
        assert.equal(result.duplicateSuppressed, 0);
        assert.equal(result.dncSuppressed, 0);
        assert.equal(result.regFSuppressed, 0);
    });

    it('suppresses duplicates (already in campaign)', () => {
        const rows: Candidate[] = [{ normalizedPhone: '+14085551234' }];
        const result = classifyImportCandidates(rows, {
            existingPhones: new Set(['+14085551234']),
            dncPhones: new Set(),
            regFBlockedPhones: new Set(),
        });
        assert.equal(result.toCreate.length, 0);
        assert.equal(result.duplicateSuppressed, 1);
    });

    it('suppresses DNC-listed phones', () => {
        const rows: Candidate[] = [{ normalizedPhone: '+14085551234' }];
        const result = classifyImportCandidates(rows, {
            existingPhones: new Set(),
            dncPhones: new Set(['+14085551234']),
            regFBlockedPhones: new Set(),
        });
        assert.equal(result.toCreate.length, 0);
        assert.equal(result.dncSuppressed, 1);
    });

    it('suppresses Reg F blocked phones', () => {
        const rows: Candidate[] = [{ normalizedPhone: '+14085551234' }];
        const result = classifyImportCandidates(rows, {
            existingPhones: new Set(),
            dncPhones: new Set(),
            regFBlockedPhones: new Set(['+14085551234']),
        });
        assert.equal(result.toCreate.length, 0);
        assert.equal(result.regFSuppressed, 1);
    });

    it('counts duplicate before DNC before Reg F (first-match-wins)', () => {
        // If a phone is in all three sets, it should count once, as duplicate (first check wins)
        const rows: Candidate[] = [{ normalizedPhone: '+14085551234' }];
        const result = classifyImportCandidates(rows, {
            existingPhones: new Set(['+14085551234']),
            dncPhones: new Set(['+14085551234']),
            regFBlockedPhones: new Set(['+14085551234']),
        });
        assert.equal(result.toCreate.length, 0);
        assert.equal(result.duplicateSuppressed, 1);
        assert.equal(result.dncSuppressed, 0);
        assert.equal(result.regFSuppressed, 0);
    });

    it('mixed batch: counts each category correctly', () => {
        const rows: Candidate[] = [
            { normalizedPhone: '+14085550001' }, // OK
            { normalizedPhone: '+14085550002' }, // duplicate
            { normalizedPhone: '+14085550003' }, // DNC
            { normalizedPhone: '+14085550004' }, // Reg F
            { normalizedPhone: '+14085550005' }, // OK
        ];
        const result = classifyImportCandidates(rows, {
            existingPhones: new Set(['+14085550002']),
            dncPhones: new Set(['+14085550003']),
            regFBlockedPhones: new Set(['+14085550004']),
        });
        assert.equal(result.toCreate.length, 2);
        assert.equal(result.duplicateSuppressed, 1);
        assert.equal(result.dncSuppressed, 1);
        assert.equal(result.regFSuppressed, 1);
    });

    it('preserves row fields on toCreate entries', () => {
        const rows = [
            { normalizedPhone: '+14085550001', priority: 3, firstName: 'A' },
        ];
        const result = classifyImportCandidates(rows, {
            existingPhones: new Set(),
            dncPhones: new Set(),
            regFBlockedPhones: new Set(),
        });
        assert.equal(result.toCreate[0].normalizedPhone, '+14085550001');
        assert.equal((result.toCreate[0] as any).priority, 3);
        assert.equal((result.toCreate[0] as any).firstName, 'A');
    });
});
