// Tests for /tabular-review routes after migration to Azure PostgreSQL.

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
    const { tabularRouter } = await import("../../routes/tabular");
    app.use("/tabular-review", tabularRouter);
});

beforeEach(() => mockQuery.mockReset());

// ── GET /tabular-review ───────────────────────────────────────────────────────

describe("GET /tabular-review", () => {
    it("returns reviews owned by or shared with the user", async () => {
        mockQuery.mockResolvedValue(
            mockRows([{ id: "review-1", title: "NDA Review", user_id: TEST_USER_ID }]),
        );
        const res = await request(app).get("/tabular-review");
        expect(res.status).toBe(200);
        expect(Array.isArray(res.body)).toBe(true);
    });

    it("scopes query to the authenticated userId", async () => {
        mockQuery.mockResolvedValue(mockEmpty());
        await request(app).get("/tabular-review");
        expect(mockQuery.mock.calls[0][1]).toContain(TEST_USER_ID);
    });

    it("returns an empty array when none exist", async () => {
        mockQuery.mockResolvedValue(mockEmpty());
        const res = await request(app).get("/tabular-review");
        expect(res.body).toEqual([]);
    });
});

// ── POST /tabular-review ──────────────────────────────────────────────────────

describe("POST /tabular-review", () => {
    it("creates a review and returns 201", async () => {
        mockQuery.mockResolvedValue(mockRow({ id: "review-new", title: "My Review" }));
        const res = await request(app)
            .post("/tabular-review")
            .send({ title: "My Review", columnsConfig: [] });
        expect(res.status).toBe(201);
        expect(res.body.id).toBe("review-new");
    });

    it("returns 400 when title is missing", async () => {
        const res = await request(app)
            .post("/tabular-review")
            .send({ columnsConfig: [] });
        expect(res.status).toBe(400);
    });
});

// ── GET /tabular-review/:id ───────────────────────────────────────────────────

describe("GET /tabular-review/:id", () => {
    it("returns the review for its owner", async () => {
        mockQuery.mockResolvedValue(
            mockRow({ id: "review-1", user_id: TEST_USER_ID, shared_with: [] }),
        );
        const res = await request(app).get("/tabular-review/review-1");
        expect(res.status).toBe(200);
    });

    it("returns 404 when the review does not exist", async () => {
        mockQuery.mockResolvedValue(mockEmpty());
        const res = await request(app).get("/tabular-review/nonexistent");
        expect(res.status).toBe(404);
    });

    it("returns 403 when the user has no access", async () => {
        mockQuery.mockResolvedValue(
            mockRow({ id: "review-1", user_id: "other", shared_with: [] }),
        );
        const res = await request(app).get("/tabular-review/review-1");
        expect(res.status).toBe(403);
    });
});

// ── PATCH /tabular-review/:id ─────────────────────────────────────────────────

describe("PATCH /tabular-review/:id", () => {
    it("updates the review and returns 200", async () => {
        mockQuery
            .mockResolvedValueOnce(mockRow({ id: "review-1", user_id: TEST_USER_ID }))
            .mockResolvedValueOnce(mockRow({ id: "review-1", title: "Updated" }));
        const res = await request(app)
            .patch("/tabular-review/review-1")
            .send({ title: "Updated" });
        expect(res.status).toBe(200);
    });

    it("returns 403 when the user does not own the review", async () => {
        mockQuery.mockResolvedValue(mockRow({ id: "review-1", user_id: "other" }));
        const res = await request(app)
            .patch("/tabular-review/review-1")
            .send({ title: "Updated" });
        expect(res.status).toBe(403);
    });
});

// ── DELETE /tabular-review/:id ────────────────────────────────────────────────

describe("DELETE /tabular-review/:id", () => {
    it("deletes the review and returns 204", async () => {
        mockQuery
            .mockResolvedValueOnce(mockRow({ id: "review-1", user_id: TEST_USER_ID }))
            .mockResolvedValueOnce(mockEmpty());
        const res = await request(app).delete("/tabular-review/review-1");
        expect(res.status).toBe(204);
    });

    it("returns 403 when the user does not own the review", async () => {
        mockQuery.mockResolvedValue(mockRow({ id: "review-1", user_id: "other" }));
        const res = await request(app).delete("/tabular-review/review-1");
        expect(res.status).toBe(403);
    });

    it("returns 404 when the review does not exist", async () => {
        mockQuery.mockResolvedValue(mockEmpty());
        const res = await request(app).delete("/tabular-review/review-1");
        expect(res.status).toBe(404);
    });
});

// ── Tabular cells ─────────────────────────────────────────────────────────────

describe("GET /tabular-review/:id/cells", () => {
    it("returns all cells for the review", async () => {
        mockQuery
            .mockResolvedValueOnce(mockRow({ id: "review-1", user_id: TEST_USER_ID, shared_with: [] }))
            .mockResolvedValueOnce(
                mockRows([
                    { id: "cell-1", column_index: 0, content: "Yes", document_id: "doc-1" },
                ]),
            );
        const res = await request(app).get("/tabular-review/review-1/cells");
        expect(res.status).toBe(200);
        expect(Array.isArray(res.body)).toBe(true);
    });
});

// ── Tabular review chats ──────────────────────────────────────────────────────

describe("GET /tabular-review/:id/chats", () => {
    it("returns the list of chats for the review", async () => {
        mockQuery
            .mockResolvedValueOnce(mockRow({ id: "review-1", user_id: TEST_USER_ID, shared_with: [] }))
            .mockResolvedValueOnce(mockRows([{ id: "tr-chat-1", title: "Analysis" }]));
        const res = await request(app).get("/tabular-review/review-1/chats");
        expect(res.status).toBe(200);
    });
});

describe("POST /tabular-review/:id/chats", () => {
    it("creates a tabular review chat and returns 201", async () => {
        mockQuery
            .mockResolvedValueOnce(mockRow({ id: "review-1", user_id: TEST_USER_ID, shared_with: [] }))
            .mockResolvedValueOnce(mockRow({ id: "tr-chat-new", title: null }));
        const res = await request(app).post("/tabular-review/review-1/chats");
        expect(res.status).toBe(201);
    });
});
