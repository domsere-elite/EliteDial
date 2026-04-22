import test from 'node:test';
import assert from 'node:assert/strict';

import {
    getContactTimezone,
    getCallingWindowStatus,
    isWithinCallingWindow,
} from '../services/tcpa';

// ─── getContactTimezone ─────────────────────────

test('getContactTimezone: returns contact timezone when provided', () => {
    const tz = getContactTimezone('America/New_York', 'America/Denver');
    assert.equal(tz, 'America/New_York');
});

test('getContactTimezone: falls back to campaign timezone', () => {
    const tz = getContactTimezone(null, 'America/Denver');
    assert.equal(tz, 'America/Denver');
});

test('getContactTimezone: falls back to default America/Chicago', () => {
    const tz = getContactTimezone(null, null);
    assert.equal(tz, 'America/Chicago');
});

test('getContactTimezone: falls back when contact tz is undefined', () => {
    const tz = getContactTimezone(undefined, undefined);
    assert.equal(tz, 'America/Chicago');
});

// ─── getCallingWindowStatus ─────────────────────

test('getCallingWindowStatus: returns correct structure', () => {
    const status = getCallingWindowStatus('America/New_York');
    assert.equal(status.timezone, 'America/New_York');
    assert.equal(typeof status.localHour, 'number');
    assert.equal(typeof status.isOpen, 'boolean');
    assert.equal(status.windowStart, 8);
    assert.equal(status.windowEnd, 21);
    assert.equal(typeof status.message, 'string');
});

test('getCallingWindowStatus: uses default timezone when none provided', () => {
    const status = getCallingWindowStatus(null);
    assert.equal(status.timezone, 'America/Chicago');
});

test('getCallingWindowStatus: isOpen matches window boundaries', () => {
    const status = getCallingWindowStatus('America/Chicago');
    const expected = status.localHour >= 8 && status.localHour < 21;
    assert.equal(status.isOpen, expected);
});

test('getCallingWindowStatus: message contains timezone name', () => {
    const status = getCallingWindowStatus('America/Los_Angeles');
    assert.ok(status.message.includes('America/Los_Angeles'));
});

// ─── isWithinCallingWindow ──────────────────────

test('isWithinCallingWindow: with invalid timezone falls back to default (does not throw)', () => {
    // Should not throw even with a completely invalid timezone
    assert.doesNotThrow(() => {
        const result = isWithinCallingWindow('Invalid/Timezone_Garbage');
        assert.equal(typeof result, 'boolean');
    });
});

test('isWithinCallingWindow: returns boolean for valid timezone', () => {
    const result = isWithinCallingWindow('America/New_York');
    assert.equal(typeof result, 'boolean');
});

test('isWithinCallingWindow: returns boolean with null input', () => {
    const result = isWithinCallingWindow(null);
    assert.equal(typeof result, 'boolean');
});

test('isWithinCallingWindow: result matches getCallingWindowStatus isOpen', () => {
    const tz = 'America/Chicago';
    const windowResult = isWithinCallingWindow(tz);
    const statusResult = getCallingWindowStatus(tz);
    assert.equal(windowResult, statusResult.isOpen);
});
