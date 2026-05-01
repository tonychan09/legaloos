// Tests for src/lib/userSettings.ts after migration to Azure PostgreSQL.
// Verifies that model resolution and API key retrieval work correctly
// with the new pg-based DB client.

import { mockRow, mockEmpty, TEST_USER_ID } from "../helpers";

const mockQuery = jest.fn();
jest.mock("../../lib/db", () => ({ pool: { query: mockQuery } }));

import { getUserModelSettings, getUserApiKeys } from "../../lib/userSettings";

beforeEach(() => mockQuery.mockReset());

// ── getUserApiKeys ─────────────────────────────────────────────────────────────

describe("getUserApiKeys", () => {
    it("returns all four API key fields from the DB", async () => {
        mockQuery.mockResolvedValue(
            mockRow({
                claude_api_key: "sk-ant-abc",
                gemini_api_key: "AI-xyz",
                azure_api_key: "azure-key-123",
                azure_endpoint: "https://my.services.ai.azure.com/models",
            }),
        );
        const keys = await getUserApiKeys(TEST_USER_ID);
        expect(keys.claude).toBe("sk-ant-abc");
        expect(keys.gemini).toBe("AI-xyz");
        expect(keys.azure).toBe("azure-key-123");
        expect(keys.azureEndpoint).toBe("https://my.services.ai.azure.com/models");
    });

    it("returns nulls when the user has set no keys", async () => {
        mockQuery.mockResolvedValue(
            mockRow({
                claude_api_key: null,
                gemini_api_key: null,
                azure_api_key: null,
                azure_endpoint: null,
            }),
        );
        const keys = await getUserApiKeys(TEST_USER_ID);
        expect(keys.claude).toBeNull();
        expect(keys.gemini).toBeNull();
        expect(keys.azure).toBeNull();
        expect(keys.azureEndpoint).toBeNull();
    });

    it("returns nulls when no user_profiles row exists", async () => {
        mockQuery.mockResolvedValue(mockEmpty());
        const keys = await getUserApiKeys(TEST_USER_ID);
        expect(keys.claude).toBeNull();
        expect(keys.gemini).toBeNull();
        expect(keys.azure).toBeNull();
        expect(keys.azureEndpoint).toBeNull();
    });

    it("queries using the provided userId", async () => {
        mockQuery.mockResolvedValue(mockEmpty());
        await getUserApiKeys(TEST_USER_ID);
        expect(mockQuery.mock.calls[0][1]).toContain(TEST_USER_ID);
    });
});

// ── getUserModelSettings ───────────────────────────────────────────────────────

describe("getUserModelSettings", () => {
    it("returns the tabular_model from DB when it is a valid model ID", async () => {
        mockQuery.mockResolvedValue(
            mockRow({
                tabular_model: "claude-sonnet-4-6",
                claude_api_key: "sk-ant-abc",
                gemini_api_key: null,
                azure_api_key: null,
                azure_endpoint: null,
            }),
        );
        const settings = await getUserModelSettings(TEST_USER_ID);
        expect(settings.tabular_model).toBe("claude-sonnet-4-6");
    });

    it("falls back to the default tabular model when DB value is invalid", async () => {
        mockQuery.mockResolvedValue(
            mockRow({
                tabular_model: "nonexistent-model",
                claude_api_key: null,
                gemini_api_key: null,
                azure_api_key: null,
                azure_endpoint: null,
            }),
        );
        const settings = await getUserModelSettings(TEST_USER_ID);
        expect(settings.tabular_model).toBe("gemini-3-flash-preview");
    });

    it("falls back to default tabular model when no row exists", async () => {
        mockQuery.mockResolvedValue(mockEmpty());
        const settings = await getUserModelSettings(TEST_USER_ID);
        expect(settings.tabular_model).toBe("gemini-3-flash-preview");
    });

    describe("title_model resolution", () => {
        it("uses Gemini Flash Lite when a Gemini key is set", async () => {
            mockQuery.mockResolvedValue(
                mockRow({
                    tabular_model: null,
                    claude_api_key: null,
                    gemini_api_key: "AI-key",
                    azure_api_key: null,
                    azure_endpoint: null,
                }),
            );
            const settings = await getUserModelSettings(TEST_USER_ID);
            expect(settings.title_model).toBe("gemini-3.1-flash-lite-preview");
        });

        it("uses Claude Haiku when only a Claude key is set", async () => {
            mockQuery.mockResolvedValue(
                mockRow({
                    tabular_model: null,
                    claude_api_key: "sk-ant-key",
                    gemini_api_key: null,
                    azure_api_key: null,
                    azure_endpoint: null,
                }),
            );
            const settings = await getUserModelSettings(TEST_USER_ID);
            expect(settings.title_model).toBe("claude-haiku-4-5");
        });

        it("uses Azure GPT-4o Mini when only an Azure key is set", async () => {
            mockQuery.mockResolvedValue(
                mockRow({
                    tabular_model: null,
                    claude_api_key: null,
                    gemini_api_key: null,
                    azure_api_key: "az-key",
                    azure_endpoint: "https://res.services.ai.azure.com/models",
                }),
            );
            const settings = await getUserModelSettings(TEST_USER_ID);
            expect(settings.title_model).toBe("azure/gpt-4o-mini");
        });

        it("prefers Gemini over Claude and Azure when multiple keys are set", async () => {
            mockQuery.mockResolvedValue(
                mockRow({
                    tabular_model: null,
                    claude_api_key: "sk-ant-key",
                    gemini_api_key: "AI-key",
                    azure_api_key: "az-key",
                    azure_endpoint: "https://res.services.ai.azure.com/models",
                }),
            );
            const settings = await getUserModelSettings(TEST_USER_ID);
            expect(settings.title_model).toBe("gemini-3.1-flash-lite-preview");
        });

        it("defaults to Gemini when no keys are set", async () => {
            mockQuery.mockResolvedValue(
                mockRow({
                    tabular_model: null,
                    claude_api_key: null,
                    gemini_api_key: null,
                    azure_api_key: null,
                    azure_endpoint: null,
                }),
            );
            const settings = await getUserModelSettings(TEST_USER_ID);
            expect(settings.title_model).toBe("gemini-3.1-flash-lite-preview");
        });
    });
});
