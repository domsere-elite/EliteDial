import axios from 'axios';
import crypto from 'crypto';
import { PrismaClient } from '@prisma/client';
import { logger } from '../utils/logger';

const prisma = new PrismaClient();

export type WebhookEvent =
    | 'call.answered'
    | 'call.completed'
    | 'disposition.submitted'
    | 'voicemail.received';

interface WebhookPayload {
    event: WebhookEvent;
    timestamp: string;
    data: Record<string, any>;
}

class WebhookEngine {
    // Dispatch an event to all configured webhook endpoints
    async dispatch(event: WebhookEvent, data: Record<string, any>): Promise<void> {
        const configs = await prisma.webhookConfig.findMany({
            where: { isActive: true },
        });

        const payload: WebhookPayload = {
            event,
            timestamp: new Date().toISOString(),
            data,
        };

        for (const wh of configs) {
            const subscribedEvents = wh.events.split(',').map(e => e.trim());
            if (!subscribedEvents.includes(event)) continue;

            this.sendWithRetry(wh.url, wh.secret, payload).catch(err => {
                logger.error('Webhook dispatch failed permanently', { url: wh.url, event, error: err });
            });
        }
    }

    private async sendWithRetry(url: string, secret: string, payload: WebhookPayload, attempt = 1): Promise<void> {
        const maxRetries = 3;
        const body = JSON.stringify(payload);
        const signature = crypto.createHmac('sha256', secret).update(body).digest('hex');

        try {
            await axios.post(url, payload, {
                headers: {
                    'Content-Type': 'application/json',
                    'X-EliteDial-Signature': signature,
                    'X-EliteDial-Event': payload.event,
                },
                timeout: 10000,
            });
            logger.info('Webhook sent successfully', { url, event: payload.event });
        } catch (err) {
            if (attempt < maxRetries) {
                const delay = Math.pow(2, attempt) * 1000; // exponential backoff
                logger.warn(`Webhook failed, retrying in ${delay}ms`, { url, attempt });
                await new Promise(resolve => setTimeout(resolve, delay));
                return this.sendWithRetry(url, secret, payload, attempt + 1);
            }
            throw err;
        }
    }
}

export const webhookEngine = new WebhookEngine();
