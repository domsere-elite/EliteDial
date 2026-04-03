import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function seed() {
    console.log('🌱 Seeding EliteDial database...');

    // ─── Users ──────────────────────────────────
    const adminPassword = await bcrypt.hash('admin123', 12);
    const agentPassword = await bcrypt.hash('agent123', 12);

    const admin = await prisma.user.upsert({
        where: { username: 'admin' },
        update: {},
        create: {
            username: 'admin',
            email: 'admin@elitedial.com',
            passwordHash: adminPassword,
            firstName: 'System',
            lastName: 'Admin',
            role: 'admin',
            status: 'offline',
        },
    });

    const supervisor = await prisma.user.upsert({
        where: { username: 'jthompson' },
        update: {},
        create: {
            username: 'jthompson',
            email: 'j.thompson@elitedial.com',
            passwordHash: agentPassword,
            firstName: 'James',
            lastName: 'Thompson',
            role: 'supervisor',
            status: 'offline',
        },
    });

    const agents = [];
    const agentData = [
        { username: 'mrodriguez', email: 'm.rodriguez@elitedial.com', firstName: 'Maria', lastName: 'Rodriguez' },
        { username: 'dpatel', email: 'd.patel@elitedial.com', firstName: 'David', lastName: 'Patel' },
        { username: 'swilson', email: 's.wilson@elitedial.com', firstName: 'Sarah', lastName: 'Wilson' },
        { username: 'jchen', email: 'j.chen@elitedial.com', firstName: 'Jason', lastName: 'Chen' },
    ];

    for (const a of agentData) {
        const agent = await prisma.user.upsert({
            where: { username: a.username },
            update: {},
            create: { ...a, passwordHash: agentPassword, role: 'agent', status: 'offline' },
        });
        agents.push(agent);
    }

    // ─── Disposition Codes ──────────────────────
    const dispositions = [
        { code: 'PIF', label: 'Paid in Full', category: 'payment' },
        { code: 'PP', label: 'Payment Plan Arranged', category: 'payment' },
        { code: 'PTP', label: 'Promise to Pay', category: 'promise' },
        { code: 'CB', label: 'Callback Requested', category: 'general' },
        { code: 'LM', label: 'Left Message', category: 'general' },
        { code: 'NA', label: 'No Answer', category: 'skip' },
        { code: 'WN', label: 'Wrong Number', category: 'skip' },
        { code: 'DISC', label: 'Disconnected', category: 'skip' },
        { code: 'DNC', label: 'Do Not Call Request', category: 'skip' },
        { code: 'DISP', label: 'Dispute Filed', category: 'general' },
        { code: 'REF', label: 'Refused to Pay', category: 'general' },
        { code: 'BK', label: 'Bankruptcy', category: 'skip' },
    ];

    for (const d of dispositions) {
        await prisma.dispositionCode.upsert({
            where: { code: d.code },
            update: {},
            create: d,
        });
    }

    // ─── Phone Numbers ──────────────────────────
    await prisma.phoneNumber.upsert({
        where: { number: '+15551000001' },
        update: {},
        create: { number: '+15551000001', label: 'Main Inbound', type: 'toll-free', assignedTo: 'agents' },
    });
    await prisma.phoneNumber.upsert({
        where: { number: '+15551000002' },
        update: {},
        create: { number: '+15551000002', label: 'Outbound 1', type: 'local', assignedTo: 'outbound' },
    });

    // ─── Queue Config ───────────────────────────
    await prisma.queueConfig.upsert({
        where: { name: 'agents' },
        update: {},
        create: { name: 'agents', holdTimeout: 60, overflowAction: 'voicemail', maxQueueSize: 15 },
    });
    await prisma.queueConfig.upsert({
        where: { name: 'payments' },
        update: {},
        create: { name: 'payments', holdTimeout: 90, overflowAction: 'voicemail', maxQueueSize: 10 },
    });

    // ─── Sample Calls ──────────────────────────
    const statuses = ['completed', 'completed', 'completed', 'no-answer', 'completed', 'voicemail'];
    const directions: Array<'inbound' | 'outbound'> = ['outbound', 'outbound', 'inbound', 'outbound', 'outbound', 'inbound'];
    const dCodes = ['PTP', 'LM', 'PP', null, 'CB', null];

    for (let i = 0; i < 30; i++) {
        const idx = i % statuses.length;
        const agentIdx = i % agents.length;
        const createdAt = new Date(Date.now() - Math.random() * 7 * 24 * 60 * 60 * 1000);
        const duration = statuses[idx] === 'completed' ? Math.floor(Math.random() * 600) + 30 : 0;

        await prisma.call.create({
            data: {
                direction: directions[idx],
                fromNumber: directions[idx] === 'outbound' ? '+15551000002' : `+1555${String(Math.floor(Math.random() * 9000000) + 1000000)}`,
                toNumber: directions[idx] === 'outbound' ? `+1555${String(Math.floor(Math.random() * 9000000) + 1000000)}` : '+15551000001',
                status: statuses[idx],
                duration,
                agentId: agents[agentIdx].id,
                accountId: `ACC-${String(Math.floor(Math.random() * 900) + 100).padStart(3, '0')}`,
                accountName: ['Johnson Account', 'Williams Account', 'Martinez Account', 'Brown Account', 'Davis Account'][i % 5],
                dncChecked: true,
                fdcpaNotice: true,
                dispositionId: dCodes[idx],
                createdAt,
                completedAt: statuses[idx] === 'completed' ? new Date(createdAt.getTime() + duration * 1000) : null,
            },
        });
    }

    // ─── Sample Voicemails ──────────────────────
    for (let i = 0; i < 5; i++) {
        await prisma.voicemail.create({
            data: {
                fromNumber: `+1555${String(Math.floor(Math.random() * 9000000) + 1000000)}`,
                toNumber: '+15551000001',
                audioUrl: `/api/voicemails/audio/sample-${i + 1}.wav`,
                transcription: [
                    'Hi, this is regarding my account. I would like to discuss a payment plan. Please call me back at your earliest convenience.',
                    'I received a letter about my account balance. I want to make a payment. My account number is 4521. Please return my call.',
                    'This is John Davis. I was told to call about an outstanding balance. I can be reached at this number until 5 PM.',
                    'I need to dispute the amount on my account. This debt was already settled. Please call me back immediately.',
                    'Hi, I would like to set up automatic payments. Please let me know what information you need from me.',
                ][i],
                duration: Math.floor(Math.random() * 90) + 15,
                isRead: i < 2,
                assignedToId: i < 3 ? agents[i % agents.length].id : null,
                createdAt: new Date(Date.now() - Math.random() * 3 * 24 * 60 * 60 * 1000),
            },
        });
    }

    // ─── DNC Entries ────────────────────────────
    const dncNumbers = ['+15555550001', '+15555550002', '+15555550003'];
    for (const num of dncNumbers) {
        await prisma.dNCEntry.upsert({
            where: { phoneNumber: num.replace(/\D/g, '').length === 10 ? '1' + num.replace(/\D/g, '') : num.replace(/\D/g, '') },
            update: {},
            create: { phoneNumber: num.replace(/\D/g, '').length === 10 ? '1' + num.replace(/\D/g, '') : num.replace(/\D/g, ''), reason: 'Customer request', addedBy: 'admin' },
        });
    }

    console.log('✅ Seed complete!');
    console.log(`   Admin: admin / admin123`);
    console.log(`   Supervisor: jthompson / agent123`);
    console.log(`   Agents: mrodriguez, dpatel, swilson, jchen / agent123`);
}

seed()
    .catch(console.error)
    .finally(() => prisma.$disconnect());
