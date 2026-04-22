import winston from 'winston';

const isProduction = process.env.NODE_ENV === 'production';

// Human-readable format for development
const devFormat = winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }),
    winston.format.printf(({ timestamp, level, message, ...meta }) => {
        const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
        return `${timestamp} [${level.toUpperCase().padEnd(5)}] ${message}${metaStr}`;
    })
);

// JSON format for production (structured, machine-parseable)
const prodFormat = winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
);

export const logger = winston.createLogger({
    level: isProduction ? 'info' : 'debug',
    format: isProduction ? prodFormat : devFormat,
    defaultMeta: { service: 'elitedial-api' },
    transports: [
        new winston.transports.Console(),
    ],
});
