import 'dotenv/config';
import { supabaseAdmin } from '../src/lib/supabase-admin';

async function main() {
    const email = process.env.SEED_ADMIN_EMAIL;
    const password = process.env.SEED_ADMIN_PASSWORD;
    const firstName = process.env.SEED_ADMIN_FIRST_NAME || 'Admin';
    const lastName = process.env.SEED_ADMIN_LAST_NAME || 'User';
    if (!email || !password) {
        console.error('Set SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD env vars before running.');
        process.exit(1);
    }
    const { data, error } = await supabaseAdmin().auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: { firstName, lastName, role: 'admin' },
    });
    if (error || !data?.user) {
        console.error('Failed:', error?.message ?? 'unknown error');
        process.exit(1);
    }
    console.log(`Created admin user ${data.user.id} (${email}). Trigger created the matching Profile.`);
}

main().catch((err) => { console.error(err); process.exit(1); });
