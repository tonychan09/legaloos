// Tests for /chat routes after migration to Azure PostgreSQL.
// Covers: listing chats, creating chats, fetching messages, deleting chats.

import request from "supertest";
import express from "express";
import { TEST_USER_ID, mockRow, mockRows, mockEmpty } from "../helpers";

const mockQuery = jest.fn();
jest.mock("../../lib/db", () => ({ pool: { query: mockQuery } }));
jest.mock("../../middleware/auth", () => ({
    requireAuth: (_req: any, res: any, next: any) => {
        res.locals.userId = TEST_USER_ID;
        res.locals.userEmail = "test@example.com";
        next();
    },
}));

let app: express.Express;

beforeAll(async () => {
    app = express();
    app.use(express.json());
    const { chatRouter } = await import("../../routes/chat");
    app.use("/chat", chatRouter);
});

beforeEach(() => mockQuery.mockReset());

// ── GET /chat ─────────────────────────────────────────────────────────────────

describe("GET /chat", () => {
    it("returns an array of chats for the authenticated user", async () => {
        mockQuery.mockResolvedValue(
            mockRows([
                { id: "chat-1", title: "First chat", created_at: new Date().toISOString() },
                { id: "chat-2", title: "Second chat", created_at: new Date().toISOString() },
            ]),
        );
        const res = await request(app).get("/chat");
        expect(res.status).toBe(200);
        expect(Array.isArray(res.body)).toBe(true);
        expect(res.body).toHaveLength(2);
    });

    it("returns an empty array when the user has no chats", async () => {
        mockQuery.mockResolvedValue(mockEmpty());
        const res = await request(app).get("/chat");
        expect(res.status).toBe(200);
        expect(res.body).toEqual([]);
    });

    it("scopes the query to the authenticated userId", async () => {
        mockQuery.mockResolvedValue(mockEmpty());
        await request(app).get("/chat");
        expect(mockQuery.mock.calls[0][1]).toContain(TEST_USER_ID);
    });

    it("returns 500 when the DB query fails", async () => {
        mockQuery.mockRejectedValue(new Error("DB error"));
        const res = await request(app).get("/chat");
        expect(res.status).toBe(500);
    });
});

// ── POST /chat ────────────────────────────────────────────────────────────────

describe("POST /chat", () => {
    it("creates a new chat and returns 201 with the new id", async () => {
        mockQuery.mockResolvedValue(mockRow({ id: "new-chat-id", title: null }));
        const res = await request(app).post("/chat").send({ projectId: null });
        expect(res.status).toBe(201);
        expect(res.body.id).toBe("new-chat-id");
    });

    it("associates the chat with a projectId when provided", async () => {
        mockQuery.mockResolvedValue(mockRow({ id: "new-chat-id", title: null }));
        await request(app).post("/chat").send({ projectId: "proj-123" });
        expect(mockQuery.mock.calls[0][1]).toContain("proj-123");
    });

    it("returns 500 when the DB query fails", async () => {
        mockQuery.mockRejectedValue(new Error("DB error"));
        const res = await request(app).post("/chat");
        expect(res.status).toBe(500);
    });
});

// ── GET /chat/:chatId/messages ────────────────────────────────────────────────

describe("GET /chat/:chatId/messages", () => {
    const chatId = "chat-abc";

    it("returns messages for a chat owned by the user", async () => {
        // First query: ownership check; second: messages.
        mockQuery
            .mockResolvedValueOnce(mockRow({ id: chatId, user_id: TEST_USER_ID }))
            .mockResolvedValueOnce(
                mockRows([
                    { id: "msg-1", role: "user", content: "Hello" },
                    { id: "msg-2", role: "assistant", content: "Hi!" },
                ]),
            );
        const res = await request(app).get(`/chat/${chatId}/messages`);
        expect(res.status).toBe(200);
        expect(res.body).toHaveLength(2);
    });

    it("returns 404 when the chat does not exist", async () => {
        mockQuery.mockResolvedValue(mockEmpty());
        const res = await request(app).get(`/chat/${chatId}/messages`);
        expect(res.status).toBe(404);
    });

    it("returns 403 when the chat belongs to a different user", async () => {
        mockQuery.mockResolvedValue(
            mockRow({ id: chatId, user_id: "other-user-id" }),
        );
        const res = await request(app).get(`/chat/${chatId}/messages`);
        expect(res.status).toBe(403);
    });
});

// ── PATCH /chat/:chatId/title ─────────────────────────────────────────────────

describe("PATCH /chat/:chatId/title", () => {
    const chatId = "chat-abc";

    it("updates the title and returns 200", async () => {
        mockQuery
            .mockResolvedValueOnce(mockRow({ id: chatId, user_id: TEST_USER_ID }))
            .mockResolvedValueOnce(mockEmpty());
        const res = await request(app)
            .patch(`/chat/${chatId}/title`)
            .send({ title: "New Title" });
        expect(res.status).toBe(200);
    });

    it("returns 404 when the chat does not exist", async () => {
        mockQuery.mockResolvedValue(mockEmpty());
        const res = await request(app)
            .patch(`/chat/${chatId}/title`)
            .send({ title: "New Title" });
        expect(res.status).toBe(404);
    });

    it("returns 403 when the chat belongs to another user", async () => {
        mockQuery.mockResolvedValue(mockRow({ id: chatId, user_id: "other" }));
        const res = await request(app)
            .patch(`/chat/${chatId}/title`)
            .send({ title: "New Title" });
        expect(res.status).toBe(403);
    });
});

// ── DELETE /chat/:chatId ──────────────────────────────────────────────────────

describe("DELETE /chat/:chatId", () => {
    const chatId = "chat-abc";

    it("deletes the chat and returns 204", async () => {
        mockQuery
            .mockResolvedValueOnce(mockRow({ id: chatId, user_id: TEST_USER_ID }))
            .mockResolvedValueOnce(mockEmpty());
        const res = await request(app).delete(`/chat/${chatId}`);
        expect(res.status).toBe(204);
    });

    it("returns 404 when the chat does not exist", async () => {
        mockQuery.mockResolvedValue(mockEmpty());
        const res = await request(app).delete(`/chat/${chatId}`);
        expect(res.status).toBe(404);
    });

    it("returns 403 when the chat belongs to another user", async () => {
        mockQuery.mockResolvedValue(mockRow({ id: chatId, user_id: "other" }));
        const res = await request(app).delete(`/chat/${chatId}`);
        expect(res.status).toBe(403);
    });
});
