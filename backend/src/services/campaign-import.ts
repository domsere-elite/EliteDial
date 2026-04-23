export interface CandidateRow {
    normalizedPhone: string;
    [key: string]: unknown;
}

export interface ClassifyFilters {
    existingPhones: Set<string>;
    dncPhones: Set<string>;
    regFBlockedPhones: Set<string>;
}

export interface ClassifyResult<T extends CandidateRow> {
    toCreate: T[];
    duplicateSuppressed: number;
    dncSuppressed: number;
    regFSuppressed: number;
}

export function classifyImportCandidates<T extends CandidateRow>(
    rows: T[],
    filters: ClassifyFilters,
): ClassifyResult<T> {
    const toCreate: T[] = [];
    let duplicateSuppressed = 0;
    let dncSuppressed = 0;
    let regFSuppressed = 0;

    for (const row of rows) {
        if (filters.existingPhones.has(row.normalizedPhone)) {
            duplicateSuppressed += 1;
            continue;
        }
        if (filters.dncPhones.has(row.normalizedPhone)) {
            dncSuppressed += 1;
            continue;
        }
        if (filters.regFBlockedPhones.has(row.normalizedPhone)) {
            regFSuppressed += 1;
            continue;
        }
        toCreate.push(row);
    }

    return { toCreate, duplicateSuppressed, dncSuppressed, regFSuppressed };
}
