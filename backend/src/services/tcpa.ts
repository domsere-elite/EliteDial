/**
 * TCPA Calling-Window Enforcement
 *
 * Federal law (TCPA) prohibits calling consumers before 8 AM or after 9 PM
 * in the consumer's local time zone. This service provides utilities to
 * check calling windows and resolve contact timezones.
 */

const CALLING_WINDOW_START_HOUR = 8;  // 8 AM local
const CALLING_WINDOW_END_HOUR = 21;   // 9 PM local (21:00)
const DEFAULT_TIMEZONE = 'America/Chicago';

/**
 * Check if the current moment falls within the TCPA-compliant calling window
 * (8 AM – 9 PM) in the specified timezone.
 */
export const isWithinCallingWindow = (timezone?: string | null): boolean => {
    const tz = timezone || DEFAULT_TIMEZONE;

    try {
        const formatter = new Intl.DateTimeFormat('en-US', {
            timeZone: tz,
            hour: 'numeric',
            hour12: false,
        });

        const localHour = parseInt(formatter.format(new Date()), 10);
        return localHour >= CALLING_WINDOW_START_HOUR && localHour < CALLING_WINDOW_END_HOUR;
    } catch {
        // If timezone is invalid, default to Chicago
        const formatter = new Intl.DateTimeFormat('en-US', {
            timeZone: DEFAULT_TIMEZONE,
            hour: 'numeric',
            hour12: false,
        });

        const localHour = parseInt(formatter.format(new Date()), 10);
        return localHour >= CALLING_WINDOW_START_HOUR && localHour < CALLING_WINDOW_END_HOUR;
    }
};

/**
 * Resolve the effective timezone for a contact.
 * Priority: contact-level timezone → campaign-level timezone → default (America/Chicago)
 */
export const getContactTimezone = (
    contactTimezone?: string | null,
    campaignTimezone?: string | null,
): string => {
    return contactTimezone || campaignTimezone || DEFAULT_TIMEZONE;
};

/**
 * Compute the next 8 AM in the given timezone, relative to `now`.
 * If we are currently before 8 AM local, returns 8 AM today; otherwise 8 AM tomorrow.
 */
export const nextCallingWindowStart = (timezone?: string | null, now: Date = new Date()): Date => {
    const tz = timezone || DEFAULT_TIMEZONE;
    const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        hour: 'numeric',
        hour12: false,
    });
    let localHour: number;
    try {
        localHour = parseInt(formatter.format(now), 10);
    } catch {
        localHour = parseInt(
            new Intl.DateTimeFormat('en-US', { timeZone: DEFAULT_TIMEZONE, hour: 'numeric', hour12: false }).format(now),
            10,
        );
    }
    const dayOffset = localHour < CALLING_WINDOW_START_HOUR ? 0 : 1;
    const base = new Date(now.getTime() + dayOffset * 86_400_000);
    const dateParts = new Intl.DateTimeFormat('en-CA', {
        timeZone: tz,
        year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(base);
    const y = dateParts.find(p => p.type === 'year')!.value;
    const m = dateParts.find(p => p.type === 'month')!.value;
    const d = dateParts.find(p => p.type === 'day')!.value;
    const utcGuess = new Date(`${y}-${m}-${d}T${String(CALLING_WINDOW_START_HOUR).padStart(2, '0')}:00:00Z`);
    const tzGuessHour = parseInt(
        new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hour12: false }).format(utcGuess),
        10,
    );
    const offsetHours = CALLING_WINDOW_START_HOUR - tzGuessHour;
    return new Date(utcGuess.getTime() + offsetHours * 3_600_000);
};

/**
 * Get calling window status details for diagnostics/display.
 */
export const getCallingWindowStatus = (timezone?: string | null): {
    timezone: string;
    localHour: number;
    isOpen: boolean;
    windowStart: number;
    windowEnd: number;
    message: string;
} => {
    const tz = timezone || DEFAULT_TIMEZONE;
    let localHour: number;

    try {
        const formatter = new Intl.DateTimeFormat('en-US', {
            timeZone: tz,
            hour: 'numeric',
            hour12: false,
        });
        localHour = parseInt(formatter.format(new Date()), 10);
    } catch {
        localHour = parseInt(
            new Intl.DateTimeFormat('en-US', {
                timeZone: DEFAULT_TIMEZONE,
                hour: 'numeric',
                hour12: false,
            }).format(new Date()),
            10,
        );
    }

    const isOpen = localHour >= CALLING_WINDOW_START_HOUR && localHour < CALLING_WINDOW_END_HOUR;

    return {
        timezone: tz,
        localHour,
        isOpen,
        windowStart: CALLING_WINDOW_START_HOUR,
        windowEnd: CALLING_WINDOW_END_HOUR,
        message: isOpen
            ? `Calling window is OPEN (${localHour}:00 local in ${tz})`
            : `Calling window is CLOSED (${localHour}:00 local in ${tz}). Calls blocked until ${CALLING_WINDOW_START_HOUR}:00 AM.`,
    };
};
