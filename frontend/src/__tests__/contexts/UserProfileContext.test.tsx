// Tests for UserProfileContext after migration from direct Supabase DB calls
// to backend API calls. All supabase.from(...) calls are replaced with fetch().

import React from "react";
import { render, screen, waitFor, act } from "@testing-library/react";

// ── Auth mock — provides a signed-in user ─────────────────────────────────────

jest.mock("../../contexts/AuthContext", () => ({
    useAuth: () => ({
        user: { id: "oid-123", email: "user@example.com" },
        isAuthenticated: true,
        authLoading: false,
    }),
}));

// ── MSAL mock — provides an access token ─────────────────────────────────────

jest.mock("../../lib/msal", () => ({
    msalInstance: {
        acquireTokenSilent: jest.fn().mockResolvedValue({
            accessToken: "mock-token",
        }),
        getAllAccounts: jest.fn().mockReturnValue([{ localAccountId: "oid-123" }]),
    },
}));

// ── fetch mock ────────────────────────────────────────────────────────────────

const mockFetch = jest.fn();
global.fetch = mockFetch;

const defaultProfile = {
    displayName: "Alice",
    organisation: "Acme",
    messageCreditsUsed: 3,
    creditsResetDate: new Date(Date.now() + 86400000).toISOString(),
    creditsRemaining: 999996,
    tier: "Free",
    tabularModel: "gemini-3-flash-preview",
    claudeApiKey: null,
    geminiApiKey: "AI-key",
    azureApiKey: null,
    azureEndpoint: null,
};

function mockProfileFetch(data = defaultProfile) {
    mockFetch.mockResolvedValue({
        ok: true,
        json: async () => data,
    });
}

function mockPatchSuccess() {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
}

// ── Consumer component ────────────────────────────────────────────────────────

import {
    UserProfileProvider,
    useUserProfile,
} from "../../contexts/UserProfileContext";

function TestConsumer() {
    const {
        profile,
        loading,
        updateDisplayName,
        updateOrganisation,
        updateModelPreference,
        updateApiKey,
        updateAzureEndpoint,
    } = useUserProfile();

    return (
        <div>
            <span data-testid="loading">{String(loading)}</span>
            <span data-testid="displayName">{profile?.displayName ?? "none"}</span>
            <span data-testid="geminiKey">{profile?.geminiApiKey ?? "none"}</span>
            <span data-testid="azureKey">{profile?.azureApiKey ?? "none"}</span>
            <button onClick={() => updateDisplayName("Bob")}>Set name</button>
            <button onClick={() => updateOrganisation("NewCo")}>Set org</button>
            <button onClick={() => updateModelPreference("tabularModel", "claude-sonnet-4-6")}>
                Set model
            </button>
            <button onClick={() => updateApiKey("claude", "sk-new")}>Set claude key</button>
            <button onClick={() => updateApiKey("gemini", "AI-new")}>Set gemini key</button>
            <button onClick={() => updateApiKey("azure", "az-new")}>Set azure key</button>
            <button onClick={() => updateAzureEndpoint("https://res.azure.com/models")}>
                Set azure endpoint
            </button>
        </div>
    );
}

function renderWithProvider() {
    return render(
        <UserProfileProvider>
            <TestConsumer />
        </UserProfileProvider>,
    );
}

beforeEach(() => {
    jest.clearAllMocks();
    mockProfileFetch();
});

// ── Loading and initial fetch ─────────────────────────────────────────────────

describe("initial load", () => {
    it("fetches the profile from GET /user/profile on mount", async () => {
        renderWithProvider();
        await waitFor(() =>
            expect(mockFetch).toHaveBeenCalledWith(
                expect.stringContaining("/user/profile"),
                expect.objectContaining({ method: "GET" }),
            ),
        );
    });

    it("sets loading to false after profile is fetched", async () => {
        renderWithProvider();
        await waitFor(() =>
            expect(screen.getByTestId("loading").textContent).toBe("false"),
        );
    });

    it("populates the profile from the API response", async () => {
        renderWithProvider();
        await waitFor(() =>
            expect(screen.getByTestId("displayName").textContent).toBe("Alice"),
        );
    });

    it("includes the Bearer token in the fetch request", async () => {
        renderWithProvider();
        await waitFor(() =>
            expect(mockFetch).toHaveBeenCalledWith(
                expect.any(String),
                expect.objectContaining({
                    headers: expect.objectContaining({
                        Authorization: "Bearer mock-token",
                    }),
                }),
            ),
        );
    });
});

// ── updateDisplayName ─────────────────────────────────────────────────────────

describe("updateDisplayName", () => {
    it("calls PATCH /user/profile/display-name with the new name", async () => {
        renderWithProvider();
        await waitFor(() =>
            expect(screen.getByTestId("loading").textContent).toBe("false"),
        );
        mockPatchSuccess();
        await act(async () => {
            screen.getByText("Set name").click();
        });
        expect(mockFetch).toHaveBeenCalledWith(
            expect.stringContaining("/user/profile/display-name"),
            expect.objectContaining({
                method: "PATCH",
                body: JSON.stringify({ displayName: "Bob" }),
            }),
        );
    });

    it("updates the local profile state on success", async () => {
        renderWithProvider();
        await waitFor(() =>
            expect(screen.getByTestId("displayName").textContent).toBe("Alice"),
        );
        mockPatchSuccess();
        await act(async () => {
            screen.getByText("Set name").click();
        });
        await waitFor(() =>
            expect(screen.getByTestId("displayName").textContent).toBe("Bob"),
        );
    });

    it("returns false and leaves profile unchanged when the API fails", async () => {
        renderWithProvider();
        await waitFor(() =>
            expect(screen.getByTestId("loading").textContent).toBe("false"),
        );
        mockFetch.mockResolvedValue({ ok: false });
        await act(async () => {
            screen.getByText("Set name").click();
        });
        expect(screen.getByTestId("displayName").textContent).toBe("Alice");
    });
});

// ── updateOrganisation ────────────────────────────────────────────────────────

describe("updateOrganisation", () => {
    it("calls PATCH /user/profile/organisation", async () => {
        renderWithProvider();
        await waitFor(() =>
            expect(screen.getByTestId("loading").textContent).toBe("false"),
        );
        mockPatchSuccess();
        await act(async () => {
            screen.getByText("Set org").click();
        });
        expect(mockFetch).toHaveBeenCalledWith(
            expect.stringContaining("/user/profile/organisation"),
            expect.objectContaining({ method: "PATCH" }),
        );
    });
});

// ── updateModelPreference ─────────────────────────────────────────────────────

describe("updateModelPreference", () => {
    it("calls PATCH /user/profile/model with the model ID", async () => {
        renderWithProvider();
        await waitFor(() =>
            expect(screen.getByTestId("loading").textContent).toBe("false"),
        );
        mockPatchSuccess();
        await act(async () => {
            screen.getByText("Set model").click();
        });
        expect(mockFetch).toHaveBeenCalledWith(
            expect.stringContaining("/user/profile/model"),
            expect.objectContaining({
                method: "PATCH",
                body: JSON.stringify({ model: "claude-sonnet-4-6" }),
            }),
        );
    });
});

// ── updateApiKey ──────────────────────────────────────────────────────────────

describe("updateApiKey", () => {
    const cases = [
        { label: "Set claude key", provider: "claude", key: "sk-new", testId: "none" },
        { label: "Set gemini key", provider: "gemini", key: "AI-new", testId: "geminiKey" },
        { label: "Set azure key", provider: "azure", key: "az-new", testId: "azureKey" },
    ] as const;

    cases.forEach(({ label, provider, key }) => {
        it(`calls PATCH /user/profile/api-key for provider ${provider}`, async () => {
            renderWithProvider();
            await waitFor(() =>
                expect(screen.getByTestId("loading").textContent).toBe("false"),
            );
            mockPatchSuccess();
            await act(async () => {
                screen.getByText(label).click();
            });
            expect(mockFetch).toHaveBeenCalledWith(
                expect.stringContaining("/user/profile/api-key"),
                expect.objectContaining({
                    method: "PATCH",
                    body: JSON.stringify({ provider, apiKey: key }),
                }),
            );
        });
    });
});

// ── updateAzureEndpoint ───────────────────────────────────────────────────────

describe("updateAzureEndpoint", () => {
    it("calls PATCH /user/profile/azure-endpoint", async () => {
        renderWithProvider();
        await waitFor(() =>
            expect(screen.getByTestId("loading").textContent).toBe("false"),
        );
        mockPatchSuccess();
        await act(async () => {
            screen.getByText("Set azure endpoint").click();
        });
        expect(mockFetch).toHaveBeenCalledWith(
            expect.stringContaining("/user/profile/azure-endpoint"),
            expect.objectContaining({
                method: "PATCH",
                body: JSON.stringify({ endpoint: "https://res.azure.com/models" }),
            }),
        );
    });
});
