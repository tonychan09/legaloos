// Tests for src/app/lib/mikeApi.ts after migration from Supabase Auth
// to MSAL for token acquisition.
// The key behaviour: every request must include "Authorization: Bearer <token>"
// obtained from msalInstance.acquireTokenSilent().

const mockAcquireTokenSilent = jest.fn();
const mockGetAllAccounts = jest.fn();

jest.mock("../../lib/msal", () => ({
    msalInstance: {
        acquireTokenSilent: mockAcquireTokenSilent,
        getAllAccounts: mockGetAllAccounts,
    },
}));

const mockFetch = jest.fn();
global.fetch = mockFetch;

import { getAuthHeader, apiFetch } from "../../app/lib/mikeApi";

beforeEach(() => {
    jest.clearAllMocks();
    mockGetAllAccounts.mockReturnValue([{ localAccountId: "oid-123" }]);
});

// ── getAuthHeader ─────────────────────────────────────────────────────────────

describe("getAuthHeader", () => {
    it("returns a Bearer token from msalInstance.acquireTokenSilent()", async () => {
        mockAcquireTokenSilent.mockResolvedValue({ accessToken: "my-token" });
        const header = await getAuthHeader();
        expect(header).toBe("Bearer my-token");
    });

    it("calls acquireTokenSilent with the active account", async () => {
        mockAcquireTokenSilent.mockResolvedValue({ accessToken: "my-token" });
        await getAuthHeader();
        expect(mockAcquireTokenSilent).toHaveBeenCalledWith(
            expect.objectContaining({ account: expect.objectContaining({ localAccountId: "oid-123" }) }),
        );
    });

    it("returns null when no account is signed in", async () => {
        mockGetAllAccounts.mockReturnValue([]);
        const header = await getAuthHeader();
        expect(header).toBeNull();
    });

    it("returns null when token acquisition throws InteractionRequiredAuthError", async () => {
        const { InteractionRequiredAuthError } = await import("@azure/msal-browser");
        mockAcquireTokenSilent.mockRejectedValue(
            new InteractionRequiredAuthError("interaction_required"),
        );
        const header = await getAuthHeader();
        expect(header).toBeNull();
    });

    it("re-throws unexpected errors from acquireTokenSilent", async () => {
        mockAcquireTokenSilent.mockRejectedValue(new Error("network failure"));
        await expect(getAuthHeader()).rejects.toThrow("network failure");
    });
});

// ── apiFetch ──────────────────────────────────────────────────────────────────

describe("apiFetch", () => {
    beforeEach(() => {
        mockAcquireTokenSilent.mockResolvedValue({ accessToken: "my-token" });
        mockFetch.mockResolvedValue({
            ok: true,
            json: async () => ({ data: "ok" }),
        });
    });

    it("includes the Authorization header on every request", async () => {
        await apiFetch("/chat");
        expect(mockFetch).toHaveBeenCalledWith(
            expect.any(String),
            expect.objectContaining({
                headers: expect.objectContaining({
                    Authorization: "Bearer my-token",
                }),
            }),
        );
    });

    it("prepends the API base URL to the path", async () => {
        process.env.NEXT_PUBLIC_API_BASE_URL = "http://localhost:3001";
        await apiFetch("/chat");
        expect(mockFetch).toHaveBeenCalledWith(
            "http://localhost:3001/chat",
            expect.any(Object),
        );
    });

    it("passes through method, body and extra headers", async () => {
        await apiFetch("/chat", {
            method: "POST",
            body: JSON.stringify({ message: "hi" }),
            headers: { "Content-Type": "application/json" },
        });
        expect(mockFetch).toHaveBeenCalledWith(
            expect.any(String),
            expect.objectContaining({
                method: "POST",
                body: JSON.stringify({ message: "hi" }),
                headers: expect.objectContaining({
                    "Content-Type": "application/json",
                    Authorization: "Bearer my-token",
                }),
            }),
        );
    });

    it("returns the fetch Response object", async () => {
        const result = await apiFetch("/chat");
        expect(result.ok).toBe(true);
    });

    it("throws when the user is not authenticated", async () => {
        mockGetAllAccounts.mockReturnValue([]);
        await expect(apiFetch("/chat")).rejects.toThrow();
    });
});
