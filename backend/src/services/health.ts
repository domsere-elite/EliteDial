export interface HealthDeps {
    checkDb: () => Promise<boolean>;
    providers: { signalwire: boolean; retell: boolean; crm: boolean };
}

export interface HealthResult {
    statusCode: 200 | 503;
    body: {
        status: 'ok' | 'degraded';
        timestamp: string;
        db: 'connected' | 'error';
        signalwire: boolean;
        retell: boolean;
        crm: boolean;
    };
}

export async function computeHealth(deps: HealthDeps): Promise<HealthResult> {
    let dbOk = false;
    try {
        dbOk = await deps.checkDb();
    } catch {
        dbOk = false;
    }

    return {
        statusCode: dbOk ? 200 : 503,
        body: {
            status: dbOk ? 'ok' : 'degraded',
            timestamp: new Date().toISOString(),
            db: dbOk ? 'connected' : 'error',
            signalwire: deps.providers.signalwire,
            retell: deps.providers.retell,
            crm: deps.providers.crm,
        },
    };
}
