import { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';

const CORRELATION_HEADER = 'x-correlation-id';

/**
 * Assigns a unique correlation ID to each request.
 * If the client provides one via the X-Correlation-ID header, it is reused.
 * The ID is attached to req, set on the response header, and available for logging.
 */
export function correlationId(req: Request, res: Response, next: NextFunction): void {
    const id = (req.headers[CORRELATION_HEADER] as string) || randomUUID();
    (req as any).correlationId = id;
    res.setHeader(CORRELATION_HEADER, id);
    next();
}
