// Tests for the expanded /user routes after migration to Azure PostgreSQL.
// New endpoints added:
//   GET    /user/profile
//   PATCH  /user/profile/display-name
//   PATCH  /user/profile/organisation
//   PATCH  /user/profile/model
//   PATCH  /user/profile/api-key
//   PATCH  /user/profile/azure-endpoint
// Existing:
//   POST   /user/profile   (upsert on first login)
//   DELETE /user/account

import request from "supertest";
import express from "express";
import { TEST_USER_ID, TEST_USER_EMAIL, mockRow, mockEmpty } from "../helpers";

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockQuery = jest.fn();
jest.mock("../../lib/db", () => ({
    pool: { query: mockQuery },
}));

jest.mock("../../middleware/auth", () => ({
    requireAuth: (req: any, res: any, next: any) => {
        res.locals.userId = TEST_USER_ID;
        res.locals.userEmail = TEST_USER_EMAIL;
        next();
    },
}));

// ── App setup ─────────────────────────────────────────────────────────────────

let app: express.Express;

beforeAll(async () => {
    app = express();
    app.use(express.json());
    const { userRouter } = await import("../../routes/user");
    app.use("/user", userRouter);
});

beforeEach(() => {
    mockQuery.mockReset();
});

// ── POST /user/profile ────────────────────────────────────────────────────────

describe("POST /user/profile", () => {
    it("upserts into users table and user_profiles table and returns 200", async () => {
        mockQuery.mockResolvedValue(mockEmpty());
        const res = await request(app).post("/user/profile");
        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
        // Two upsert queries expected: one for users, one for user_profiles.
        expect(mockQuery).toHaveBeenCalledTimes(2);
    });

    it("passes userId and userEmail to the users upsert", async () => {
        mockQuery.mockResolvedValue(mockEmpty());
        await request(app).post("/user/profile");
        const firstCall = mockQuery.mock.calls[0];
        expect(firstCall[1]).toContain(TEST_USER_ID);
        expect(firstCall[1]).toContain(TEST_USER_EMAIL);
    });

    it("returns 500 when the DB query fails", async () => {
        mockQuery.mockRejectedValue(new Error("DB error"));
        const res = await request(app).post("/user/profile");
        expect(res.status).toBe(500);
    });
});

// ── GET /user/profile ─────────────────────────────────────────────────────────

describe("GET /user/profile", () => {
    const profileRow = {
        display_name: "Alice",
        organisation: "Acme",
        tier: "Free",
        message_credits_used: 5,
        credits_reset_date: new Date().toISOString(),
        tabular_model: "gemini-3-flash-preview",
        claude_api_key: null,
        gemini_api_key: null,
        azure_api_key: null,
        azure_endpoint: null,
    };

    it("returns the user profile with status 200", async () => {
        mockQuery.mockResolvedValue(mockRow(profileRow));
        const res = await request(app).get("/user/profile");
        expect(res.status).toBe(200);
        expect(res.body.displayName).toBe("Alice");
        expect(res.body.organisation).toBe("Acme");
        expect(res.body.tier).toBe("Free");
    });

    it("returns default profile when no row exists", async () => {
        mockQuery.mockResolvedValue(mockEmpty());
        const res = await request(app).get("/user/profile");
        expect(res.status).toBe(200);
        expect(res.body.tier).toBe("Free");
    });

    it("queries using the authenticated userId", async () => {
        mockQuery.mockResolvedValue(mockRow(profileRow));
        await request(app).get("/user/profile");
        const queryArgs = mockQuery.mock.calls[0][1];
        expect(queryArgs).toContain(TEST_USER_ID);
    });

    it("returns 500 when the DB query fails", async () => {
        mockQuery.mockRejectedValue(new Error("DB error"));
        const res = await request(app).get("/user/profile");
        expect(res.status).toBe(500);
    });
});

// ── PATCH /user/profile/display-name ─────────────────────────────────────────

describe("PATCH /user/profile/display-name", () => {
    it("updates display_name and returns 200", async () => {
        mockQuery.mockResolvedValue(mockEmpty());
        const res = await request(app)
            .patch("/user/profile/display-name")
            .send({ displayName: "Bob" });
        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
    });

    it("passes the new name to the DB query", async () => {
        mockQuery.mockResolvedValue(mockEmpty());
        await request(app)
            .patch("/user/profile/display-name")
            .send({ displayName: "Bob" });
        expect(mockQuery.mock.calls[0][1]).toContain("Bob");
    });

    it("returns 400 when displayName is missing", async () => {
        const res = await request(app)
            .patch("/user/profile/display-name")
            .send({});
        expect(res.status).toBe(400);
    });

    it("returns 400 when displayName is an empty string", async () => {
        const res = await request(app)
            .patch("/user/profile/display-name")
            .send({ displayName: "" });
        expect(res.status).toBe(400);
    });
});

// ── PATCH /user/profile/organisation ─────────────────────────────────────────

describe("PATCH /user/profile/organisation", () => {
    it("updates organisation and returns 200", async () => {
        mockQuery.mockResolvedValue(mockEmpty());
        const res = await request(app)
            .patch("/user/profile/organisation")
            .send({ organisation: "Acme Corp" });
        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
    });

    it("allows clearing the organisation with null", async () => {
        mockQuery.mockResolvedValue(mockEmpty());
        const res = await request(app)
            .patch("/user/profile/organisation")
            .send({ organisation: null });
        expect(res.status).toBe(200);
    });

    it("returns 400 when organisation field is absent entirely", async () => {
        const res = await request(app)
            .patch("/user/profile/organisation")
            .send({});
        expect(res.status).toBe(400);
    });
});

// ── PATCH /user/profile/model ─────────────────────────────────────────────────

describe("PATCH /user/profile/model", () => {
    it("updates tabular_model and returns 200 for a valid model ID", async () => {
        mockQuery.mockResolvedValue(mockEmpty());
        const res = await request(app)
            .patch("/user/profile/model")
            .send({ model: "claude-sonnet-4-6" });
        expect(res.status).toBe(200);
    });

    it("accepts Azure model IDs", async () => {
        mockQuery.mockResolvedValue(mockEmpty());
        const res = await request(app)
            .patch("/user/profile/model")
            .send({ model: "azure/gpt-4o-mini" });
        expect(res.status).toBe(200);
    });

    it("returns 400 for an unrecognised model ID", async () => {
        const res = await request(app)
            .patch("/user/profile/model")
            .send({ model: "gpt-999-turbo" });
        expect(res.status).toBe(400);
    });

    it("returns 400 when model field is missing", async () => {
        const res = await request(app)
            .patch("/user/profile/model")
            .send({});
        expect(res.status).toBe(400);
    });
});

// ── PATCH /user/profile/api-key ───────────────────────────────────────────────

describe("PATCH /user/profile/api-key", () => {
    const providers = ["claude", "gemini", "azure"] as const;

    providers.forEach((provider) => {
        it(`updates ${provider} API key and returns 200`, async () => {
            mockQuery.mockResolvedValue(mockEmpty());
            const res = await request(app)
                .patch("/user/profile/api-key")
                .send({ provider, apiKey: "sk-test-key" });
            expect(res.status).toBe(200);
        });

        it(`stores trimmed key for provider ${provider}`, async () => {
            mockQuery.mockResolvedValue(mockEmpty());
            await request(app)
                .patch("/user/profile/api-key")
                .send({ provider, apiKey: "  sk-test-key  " });
            const queryArgs = mockQuery.mock.calls[0][1];
            expect(queryArgs).toContain("sk-test-key");
            expect(queryArgs).not.toContain("  sk-test-key  ");
        });

        it(`stores null when apiKey is empty string for ${provider}`, async () => {
            mockQuery.mockResolvedValue(mockEmpty());
            await request(app)
                .patch("/user/profile/api-key")
                .send({ provider, apiKey: "" });
            const queryArgs = mockQuery.mock.calls[0][1];
            expect(queryArgs).toContain(null);
        });
    });

    it("returns 400 for an unrecognised provider", async () => {
        const res = await request(app)
            .patch("/user/profile/api-key")
            .send({ provider: "openai", apiKey: "sk-xyz" });
        expect(res.status).toBe(400);
    });

    it("returns 400 when provider is missing", async () => {
        const res = await request(app)
            .patch("/user/profile/api-key")
            .send({ apiKey: "sk-xyz" });
        expect(res.status).toBe(400);
    });
});

// ── PATCH /user/profile/azure-endpoint ───────────────────────────────────────

describe("PATCH /user/profile/azure-endpoint", () => {
    it("updates azure_endpoint and returns 200", async () => {
        mockQuery.mockResolvedValue(mockEmpty());
        const res = await request(app)
            .patch("/user/profile/azure-endpoint")
            .send({ endpoint: "https://my-resource.services.ai.azure.com/models" });
        expect(res.status).toBe(200);
    });

    it("trims whitespace from the endpoint before storing", async () => {
        mockQuery.mockResolvedValue(mockEmpty());
        await request(app)
            .patch("/user/profile/azure-endpoint")
            .send({ endpoint: "  https://my-resource.services.ai.azure.com/models  " });
        const queryArgs = mockQuery.mock.calls[0][1];
        expect(queryArgs).toContain("https://my-resource.services.ai.azure.com/models");
    });

    it("stores null when endpoint is an empty string", async () => {
        mockQuery.mockResolvedValue(mockEmpty());
        await request(app)
            .patch("/user/profile/azure-endpoint")
            .send({ endpoint: "" });
        const queryArgs = mockQuery.mock.calls[0][1];
        expect(queryArgs).toContain(null);
    });

    it("returns 400 when endpoint field is absent", async () => {
        const res = await request(app)
            .patch("/user/profile/azure-endpoint")
            .send({});
        expect(res.status).toBe(400);
    });
});

// ── DELETE /user/account ──────────────────────────────────────────────────────

describe("DELETE /user/account", () => {
    it("deletes the user and returns 204", async () => {
        mockQuery.mockResolvedValue(mockEmpty());
        const res = await request(app).delete("/user/account");
        expect(res.status).toBe(204);
    });

    it("deletes using the authenticated userId", async () => {
        mockQuery.mockResolvedValue(mockEmpty());
        await request(app).delete("/user/account");
        const queryArgs = mockQuery.mock.calls[0][1];
        expect(queryArgs).toContain(TEST_USER_ID);
    });

    it("returns 500 when the DB query fails", async () => {
        mockQuery.mockRejectedValue(new Error("DB error"));
        const res = await request(app).delete("/user/account");
        expect(res.status).toBe(500);
    });
});
