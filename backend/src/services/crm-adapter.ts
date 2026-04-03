import axios, { AxiosInstance } from 'axios';
import { config } from '../config';
import { logger } from '../utils/logger';

export interface AccountInfo {
    accountId: string;
    accountName: string;
    debtorName: string;
    balance: number;
    status: string;
    phoneNumber?: string;
    metadata?: Record<string, unknown>;
}

export interface DialableLead {
    externalId: string;
    accountId: string;
    firstName?: string;
    lastName?: string;
    primaryPhone: string;
    email?: string;
    timezone?: string;
    priority?: number;
    metadata?: Record<string, unknown>;
}

export interface CRMConnector {
    readonly isConfigured: boolean;
    lookupByPhone(phoneNumber: string): Promise<AccountInfo | null>;
    getAccountDetails(accountId: string): Promise<AccountInfo | null>;
    fetchDialableWorklist(campaignId: string): Promise<DialableLead[]>;
    reserveLead(params: { campaignId: string; contactId: string; accountId?: string | null; externalId?: string | null; agentId?: string | null }): Promise<boolean>;
    postCallEvent(event: Record<string, unknown>): Promise<boolean>;
    postDisposition(event: Record<string, unknown>): Promise<boolean>;
    postRecordingTranscript(event: Record<string, unknown>): Promise<boolean>;
    postVoicemail(event: Record<string, unknown>): Promise<boolean>;
    postTransferOutcome(event: Record<string, unknown>): Promise<boolean>;
}

class HttpCRMConnector implements CRMConnector {
    readonly isConfigured = config.isCrmConfigured;
    private readonly client: AxiosInstance | null;

    constructor() {
        this.client = this.isConfigured
            ? axios.create({
                baseURL: config.crm.baseUrl,
                timeout: 10000,
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${config.crm.apiKey}`,
                },
            })
            : null;
    }

    private async get<T>(url: string, params?: Record<string, unknown>): Promise<T | null> {
        if (!this.client) return null;
        try {
            const response = await this.client.get<T>(url, { params });
            return response.data;
        } catch (error) {
            logger.warn('CRM GET failed', { url, error });
            return null;
        }
    }

    private async post(url: string, payload: Record<string, unknown>): Promise<boolean> {
        if (!this.client) return false;
        try {
            await this.client.post(url, payload);
            return true;
        } catch (error) {
            logger.warn('CRM POST failed', { url, error });
            return false;
        }
    }

    async lookupByPhone(phoneNumber: string): Promise<AccountInfo | null> {
        const result = await this.get<AccountInfo>('/accounts/lookup', { phone_number: phoneNumber });
        return result;
    }

    async getAccountDetails(accountId: string): Promise<AccountInfo | null> {
        const result = await this.get<AccountInfo>(`/accounts/${encodeURIComponent(accountId)}`);
        return result;
    }

    async fetchDialableWorklist(campaignId: string): Promise<DialableLead[]> {
        const result = await this.get<DialableLead[]>('/dialer/worklist', { campaign_id: campaignId });
        return result || [];
    }

    async reserveLead(params: { campaignId: string; contactId: string; accountId?: string | null; externalId?: string | null; agentId?: string | null }): Promise<boolean> {
        return this.post('/dialer/reservations', {
            campaign_id: params.campaignId,
            contact_id: params.contactId,
            account_id: params.accountId || undefined,
            external_id: params.externalId || undefined,
            agent_id: params.agentId || undefined,
        });
    }

    async postCallEvent(event: Record<string, unknown>): Promise<boolean> {
        return this.post('/call-events', event);
    }

    async postDisposition(event: Record<string, unknown>): Promise<boolean> {
        return this.post('/dispositions', event);
    }

    async postRecordingTranscript(event: Record<string, unknown>): Promise<boolean> {
        return this.post('/recordings', event);
    }

    async postVoicemail(event: Record<string, unknown>): Promise<boolean> {
        return this.post('/voicemails', event);
    }

    async postTransferOutcome(event: Record<string, unknown>): Promise<boolean> {
        return this.post('/transfers', event);
    }
}

class StubCRMConnector implements CRMConnector {
    readonly isConfigured = false;

    async lookupByPhone(phoneNumber: string): Promise<AccountInfo | null> {
        logger.debug('CRM lookup by phone (stub)', { phoneNumber });
        const mockAccounts: Record<string, AccountInfo> = {
            '15551234567': {
                accountId: 'ACC-001',
                accountName: 'Johnson Account',
                debtorName: 'Michael Johnson',
                balance: 2450,
                status: 'active',
                phoneNumber: '+15551234567',
            },
            '15559876543': {
                accountId: 'ACC-002',
                accountName: 'Williams Account',
                debtorName: 'Sarah Williams',
                balance: 890.5,
                status: 'active',
                phoneNumber: '+15559876543',
            },
        };
        return mockAccounts[phoneNumber.replace(/\D/g, '')] || null;
    }

    async getAccountDetails(accountId: string): Promise<AccountInfo | null> {
        logger.debug('CRM account details (stub)', { accountId });
        return null;
    }

    async fetchDialableWorklist(campaignId: string): Promise<DialableLead[]> {
        logger.debug('CRM worklist fetch (stub)', { campaignId });
        return [];
    }

    async reserveLead(params: { campaignId: string; contactId: string; accountId?: string | null; externalId?: string | null; agentId?: string | null }): Promise<boolean> {
        logger.debug('CRM reserve lead (stub)', params);
        return true;
    }

    async postCallEvent(event: Record<string, unknown>): Promise<boolean> {
        logger.debug('CRM post call event (stub)', event);
        return true;
    }

    async postDisposition(event: Record<string, unknown>): Promise<boolean> {
        logger.debug('CRM post disposition (stub)', event);
        return true;
    }

    async postRecordingTranscript(event: Record<string, unknown>): Promise<boolean> {
        logger.debug('CRM post recording/transcript (stub)', event);
        return true;
    }

    async postVoicemail(event: Record<string, unknown>): Promise<boolean> {
        logger.debug('CRM post voicemail (stub)', event);
        return true;
    }

    async postTransferOutcome(event: Record<string, unknown>): Promise<boolean> {
        logger.debug('CRM post transfer outcome (stub)', event);
        return true;
    }
}

export const crmAdapter: CRMConnector = config.isCrmConfigured
    ? new HttpCRMConnector()
    : new StubCRMConnector();
