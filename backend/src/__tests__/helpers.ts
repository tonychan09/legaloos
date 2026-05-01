// Shared test helpers.

// Default authenticated user injected by the mocked requireAuth middleware.
export const TEST_USER_ID = "test-user-oid-123";
export const TEST_USER_EMAIL = "test@example.com";

// Mock pool query helper — returns the rows array you pass in.
export function mockRows<T>(rows: T[]) {
    return { rows, rowCount: rows.length };
}

export function mockRow<T>(row: T) {
    return { rows: [row], rowCount: 1 };
}

export function mockEmpty() {
    return { rows: [], rowCount: 0 };
}
