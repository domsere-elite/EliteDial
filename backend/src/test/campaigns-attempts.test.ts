import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';

// We test the projection shape via a small Express harness that mounts a minimal version of
// the route logic. Rather than mounting the real router (which pulls auth + the real prisma),
// this test asserts the contract by verifying the campaigns.ts source includes recordingUrl
// in the attempts call select.
import * as fs from 'node:fs';
import * as path from 'node:path';

test('campaigns /:id/attempts projection includes call.recordingUrl', () => {
    const src = fs.readFileSync(
        path.resolve(__dirname, '../routes/campaigns.ts'),
        'utf8',
    );
    // Locate the attempts route's call select.
    const attemptsBlock = src.match(/router\.get\('\/:id\/attempts'[\s\S]*?res\.json\(\{ attempts/);
    assert.ok(attemptsBlock, 'attempts route block found');
    const callSelectMatch = attemptsBlock![0].match(/call:\s*\{\s*select:\s*\{([^}]+)\}/);
    assert.ok(callSelectMatch, 'call select object found');
    const fields = callSelectMatch![1];
    assert.match(fields, /\bid:\s*true\b/);
    assert.match(fields, /\bduration:\s*true\b/);
    assert.match(fields, /\bstatus:\s*true\b/);
    assert.match(fields, /\brecordingUrl:\s*true\b/);
});
