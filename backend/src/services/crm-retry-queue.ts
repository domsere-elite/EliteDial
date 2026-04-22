import axios from 'axios';
import { config } from '../config';
import { logger } from '../utils/logger';

interface RetryItem {
    id: string;
    endpoint: string;
    payload: Record<string, unknown>;
    attempt: number;
    maxAttempts: number;
    nextRetryAt: Date;
    createdAt: Date;
}

class CRMRetryQueue {
    private queue: RetryItem[] = [];
    private interval: NodeJS.Timeout | null = null;
    private totalRetried = 0;
    private totalFailed = 0;

    start() {
        if (this.interval) return;
        this.interval = setInterval(() => void this.processQueue(), 10_000);
        logger.info('CRM retry queue started');
    }

    stop() {
        if (this.interval) {
            clearInterval(this.interval);
            this.interval = null;
        }
    }

    enqueue(endpoint: string, payload: Record<string, unknown>, maxAttempts = 3) {
        const id = `crm-retry-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        this.queue.push({
            id,
            endpoint,
            payload,
            attempt: 0,
            maxAttempts,
            nextRetryAt: new Date(Date.now() + 1000),
            createdAt: new Date(),
        });
        logger.info('CRM webhook queued for retry', { id, endpoint });
    }

    getStatus() {
        return {
            pending: this.queue.length,
            totalRetried: this.totalRetried,
            totalFailed: this.totalFailed,
        };
    }

    private async processQueue() {
        const now = new Date();
        const ready = this.queue.filter(item => item.nextRetryAt <= now);

        for (const item of ready) {
            item.attempt += 1;
            try {
                await axios.post(`${config.crm.baseUrl}${item.endpoint}`, item.payload, {
                    timeout: 10_000,
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${config.crm.apiKey}`,
                    },
                });
                // Success — remove from queue
                this.queue = this.queue.filter(q => q.id !== item.id);
                this.totalRetried += 1;
                logger.info('CRM webhook retry succeeded', { id: item.id, endpoint: item.endpoint, attempt: item.attempt });
            } catch (err) {
                if (item.attempt >= item.maxAttempts) {
                    this.queue = this.queue.filter(q => q.id !== item.id);
                    this.totalFailed += 1;
                    logger.error('CRM webhook retry exhausted', { id: item.id, endpoint: item.endpoint, attempts: item.attempt });
                } else {
                    // Exponential backoff: 1s, 4s, 16s
                    const delay = Math.pow(4, item.attempt) * 1000;
                    item.nextRetryAt = new Date(Date.now() + delay);
                    logger.warn('CRM webhook retry failed, scheduling next', { id: item.id, attempt: item.attempt, nextDelayMs: delay });
                }
            }
        }
    }
}

export const crmRetryQueue = new CRMRetryQueue();
