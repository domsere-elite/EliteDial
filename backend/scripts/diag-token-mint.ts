import { signalwireService } from '../src/services/signalwire';

async function main() {
    const email = process.env.AGENT_EMAIL || 'dominic@exec-strategy.com';
    const userId = process.env.AGENT_ID || '692a690e-770d-43bb-a151-8ec163141281';
    console.log(`Minting token for ${email} / ${userId}...`);
    const r = await signalwireService.generateBrowserToken(userId, email, email, email);
    console.log('Result:', JSON.stringify({
        hasToken: !!r.token,
        error: r.error,
        metadata: r.metadata,
    }, null, 2));
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
