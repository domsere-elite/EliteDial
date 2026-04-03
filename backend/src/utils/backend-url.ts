import { Request } from 'express';
import { config } from '../config';

const trimTrailingSlash = (value: string) => value.replace(/\/+$/, '');

export const getBackendBaseUrl = (req?: Pick<Request, 'protocol' | 'get'>): string => {
    if (config.publicUrls.backend) {
        return trimTrailingSlash(config.publicUrls.backend);
    }

    if (!req) {
        return `http://localhost:${config.port}`;
    }

    const host = req.get('host');
    if (!host) {
        return `http://localhost:${config.port}`;
    }

    return trimTrailingSlash(`${req.protocol}://${host}`);
};
