// Tests for AuthContext after migration from Supabase Auth to MSAL.
// The public interface (useAuth hook) stays identical:
//   { user, isAuthenticated, authLoading, signOut }
// The implementation switches to @azure/msal-browser.

import React from "react";
import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// ── MSAL mock ─────────────────────────────────────────────────────────────────

const mockAcquireTokenSilent = jest.fn();
const mockLogoutRedirect = jest.fn();
const mockLoginRedirect = jest.fn();
const mockAddEventCallback = jest.fn();
const mockRemoveEventCallback = jest.fn();
const mockGetAllAccounts = jest.fn();

jest.mock("@azure/msal-browser", () => ({
    PublicClientApplication: jest.fn().mockImplementation(() => ({
        acquireTokenSilent: mockAcquireTokenSilent,
        logoutRedirect: mockLogoutRedirect,
        loginRedirect: mockLoginRedirect,
        addEventCallback: mockAddEventCallback,
        removeEventCallback: mockRemoveEventCallback,
        getAllAccounts: mockGetAllAccounts,
    })),
    EventType: {
        LOGIN_SUCCESS: "msal:loginSuccess",
        LOGOUT_SUCCESS: "msal:logoutSuccess",
        ACQUIRE_TOKEN_SUCCESS: "msal:acquireTokenSuccess",
    },
    InteractionRequiredAuthError: class extends Error {},
}));

// ── fetch mock (ensureProfile call) ───────────────────────────────────────────

global.fetch = jest.fn().mockResolvedValue({ ok: true });

// ── helpers ───────────────────────────────────────────────────────────────────

import { AuthProvider, useAuth } from "../../contexts/AuthContext";

function TestConsumer() {
    const { user, isAuthenticated, authLoading, signOut } = useAuth();
    return (
        <div>
            <span data-testid="loading">{String(authLoading)}</span>
            <span data-testid="authenticated">{String(isAuthenticated)}</span>
            <span data-testid="userId">{user?.id ?? "none"}</span>
            <span data-testid="email">{user?.email ?? "none"}</span>
            <button onClick={signOut}>Sign out</button>
        </div>
    );
}

function renderWithAuth() {
    return render(
        <AuthProvider>
            <TestConsumer />
        </AuthProvider>,
    );
}

beforeEach(() => {
    jest.clearAllMocks();
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true });
});

// ── Initial loading state ─────────────────────────────────────────────────────

describe("initial state", () => {
    it("starts with authLoading true", () => {
        mockGetAllAccounts.mockReturnValue([]);
        mockAcquireTokenSilent.mockResolvedValue(null);
        renderWithAuth();
        expect(screen.getByTestId("loading").textContent).toBe("true");
    });
});

// ── No active account ─────────────────────────────────────────────────────────

describe("when no account is signed in", () => {
    beforeEach(() => {
        mockGetAllAccounts.mockReturnValue([]);
        mockAcquireTokenSilent.mockRejectedValue(new Error("no account"));
    });

    it("sets isAuthenticated to false", async () => {
        renderWithAuth();
        await waitFor(() =>
            expect(screen.getByTestId("authenticated").textContent).toBe("false"),
        );
    });

    it("sets authLoading to false after check completes", async () => {
        renderWithAuth();
        await waitFor(() =>
            expect(screen.getByTestId("loading").textContent).toBe("false"),
        );
    });

    it("sets user to null", async () => {
        renderWithAuth();
        await waitFor(() =>
            expect(screen.getByTestId("userId").textContent).toBe("none"),
        );
    });
});

// ── Active account found ──────────────────────────────────────────────────────

describe("when an account is already signed in", () => {
    const account = {
        homeAccountId: "oid-123.tenant-id",
        localAccountId: "oid-123",
        username: "user@example.com",
        name: "Test User",
    };

    beforeEach(() => {
        mockGetAllAccounts.mockReturnValue([account]);
        mockAcquireTokenSilent.mockResolvedValue({
            accessToken: "mock-access-token",
            idTokenClaims: {
                oid: "oid-123",
                email: "user@example.com",
            },
            account,
        });
    });

    it("sets isAuthenticated to true", async () => {
        renderWithAuth();
        await waitFor(() =>
            expect(screen.getByTestId("authenticated").textContent).toBe("true"),
        );
    });

    it("sets user.id from the oid claim", async () => {
        renderWithAuth();
        await waitFor(() =>
            expect(screen.getByTestId("userId").textContent).toBe("oid-123"),
        );
    });

    it("sets user.email from the token", async () => {
        renderWithAuth();
        await waitFor(() =>
            expect(screen.getByTestId("email").textContent).toBe("user@example.com"),
        );
    });

    it("calls ensureProfile with the access token", async () => {
        renderWithAuth();
        await waitFor(() =>
            expect(global.fetch).toHaveBeenCalledWith(
                expect.stringContaining("/user/profile"),
                expect.objectContaining({
                    method: "POST",
                    headers: expect.objectContaining({
                        Authorization: "Bearer mock-access-token",
                    }),
                }),
            ),
        );
    });

    it("sets authLoading to false", async () => {
        renderWithAuth();
        await waitFor(() =>
            expect(screen.getByTestId("loading").textContent).toBe("false"),
        );
    });
});

// ── signOut ───────────────────────────────────────────────────────────────────

describe("signOut", () => {
    beforeEach(() => {
        mockGetAllAccounts.mockReturnValue([]);
        mockAcquireTokenSilent.mockRejectedValue(new Error("no account"));
        mockLogoutRedirect.mockResolvedValue(undefined);
    });

    it("calls msalInstance.logoutRedirect()", async () => {
        renderWithAuth();
        await waitFor(() =>
            expect(screen.getByTestId("loading").textContent).toBe("false"),
        );
        await act(async () => {
            userEvent.click(screen.getByText("Sign out"));
        });
        expect(mockLogoutRedirect).toHaveBeenCalledTimes(1);
    });

    it("clears the user after sign out", async () => {
        renderWithAuth();
        await waitFor(() =>
            expect(screen.getByTestId("loading").textContent).toBe("false"),
        );
        await act(async () => {
            userEvent.click(screen.getByText("Sign out"));
        });
        await waitFor(() =>
            expect(screen.getByTestId("authenticated").textContent).toBe("false"),
        );
    });
});

// ── MSAL event callback for login ─────────────────────────────────────────────

describe("MSAL LOGIN_SUCCESS event", () => {
    it("updates user when a LOGIN_SUCCESS event fires", async () => {
        mockGetAllAccounts.mockReturnValue([]);
        mockAcquireTokenSilent.mockRejectedValue(new Error("no account"));

        let capturedCallback: ((event: any) => void) | null = null;
        mockAddEventCallback.mockImplementation((cb: any) => {
            capturedCallback = cb;
            return "callback-id";
        });

        renderWithAuth();
        await waitFor(() =>
            expect(screen.getByTestId("loading").textContent).toBe("false"),
        );

        // Simulate the LOGIN_SUCCESS event firing.
        mockAcquireTokenSilent.mockResolvedValue({
            accessToken: "new-token",
            idTokenClaims: { oid: "new-oid", email: "new@example.com" },
            account: { localAccountId: "new-oid", username: "new@example.com" },
        });

        await act(async () => {
            capturedCallback?.({
                eventType: "msal:loginSuccess",
                payload: { account: { localAccountId: "new-oid" } },
            });
        });

        await waitFor(() =>
            expect(screen.getByTestId("authenticated").textContent).toBe("true"),
        );
    });
});
