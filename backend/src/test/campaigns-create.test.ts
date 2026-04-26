import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createCampaignSchema } from '../lib/validation';

test('createCampaignSchema accepts retellAgentId and retellSipAddress', () => {
    const parsed = createCampaignSchema.parse({
        name: 'Test',
        retellAgentId: 'agent_abc',
        retellSipAddress: 'sip:agent_abc@retell.example',
    });
    assert.equal(parsed.retellAgentId, 'agent_abc');
    assert.equal(parsed.retellSipAddress, 'sip:agent_abc@retell.example');
});

test('createCampaignSchema accepts null retell fields (manual mode)', () => {
    const parsed = createCampaignSchema.parse({
        name: 'Test',
        retellAgentId: null,
        retellSipAddress: null,
    });
    assert.equal(parsed.retellAgentId, null);
    assert.equal(parsed.retellSipAddress, null);
});

test('campaigns POST handler passes retell fields into prisma.campaign.create', () => {
    const src = fs.readFileSync(
        path.resolve(__dirname, '../routes/campaigns.ts'),
        'utf8',
    );
    const postBlock = src.match(/router\.post\('\/'[\s\S]*?res\.status\(201\)\.json\(campaign\)/);
    assert.ok(postBlock, 'POST / handler block found');
    assert.match(postBlock![0], /retellAgentId/);
    assert.match(postBlock![0], /retellSipAddress/);
    assert.match(postBlock![0], /retellAgentId:\s*retellAgentId\s*\?\?\s*null/);
    assert.match(postBlock![0], /retellSipAddress:\s*retellSipAddress\s*\?\?\s*null/);
});
