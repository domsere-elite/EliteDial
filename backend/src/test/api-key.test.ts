import test from 'node:test';
import assert from 'node:assert/strict';
import { generateApiKey } from '../utils/api-key';

test('generateApiKey starts with eld_ and has length 44', () => {
    const apiKey = generateApiKey();
    assert.ok(apiKey.startsWith('eld_'));
    assert.equal(apiKey.length, 44);
});

test('generateApiKey returns unique values', () => {
    const key1 = generateApiKey();
    const key2 = generateApiKey();
    assert.notEqual(key1, key2);
});
