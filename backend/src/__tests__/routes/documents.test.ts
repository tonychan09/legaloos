// Tests for /single-documents routes after migration to Azure PostgreSQL.

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

// multer processes multipart uploads — stub it out for unit tests.
jest.mock("multer", () => {
    const multer = () => ({
        single: () => (req: any, _res: any, next: any) => {
            req.file = {
                originalname: "test.pdf",
                mimetype: "application/pdf",
                size: 1024,
                buffer: Buffer.from("fake-pdf"),
            };
            next();
        },
    });
    multer.memoryStorage = () => ({});
    return multer;
});

let app: express.Express;

beforeAll(async () => {
    app = express();
    app.use(express.json());
    const { documentsRouter } = await import("../../routes/documents");
    app.use("/single-documents", documentsRouter);
});

beforeEach(() => mockQuery.mockReset());

// ── GET /single-documents ─────────────────────────────────────────────────────

describe("GET /single-documents", () => {
    it("returns documents belonging to the authenticated user", async () => {
        mockQuery.mockResolvedValue(
            mockRows([
                { id: "doc-1", filename: "contract.pdf", user_id: TEST_USER_ID },
            ]),
        );
        const res = await request(app).get("/single-documents");
        expect(res.status).toBe(200);
        expect(Array.isArray(res.body)).toBe(true);
    });

    it("scopes the query to the authenticated userId", async () => {
        mockQuery.mockResolvedValue(mockEmpty());
        await request(app).get("/single-documents");
        expect(mockQuery.mock.calls[0][1]).toContain(TEST_USER_ID);
    });

    it("returns an empty array when the user has no documents", async () => {
        mockQuery.mockResolvedValue(mockEmpty());
        const res = await request(app).get("/single-documents");
        expect(res.status).toBe(200);
        expect(res.body).toEqual([]);
    });
});

// ── GET /single-documents/:id ─────────────────────────────────────────────────

describe("GET /single-documents/:id", () => {
    it("returns the document when owned by the user", async () => {
        mockQuery.mockResolvedValue(
            mockRow({ id: "doc-1", filename: "contract.pdf", user_id: TEST_USER_ID }),
        );
        const res = await request(app).get("/single-documents/doc-1");
        expect(res.status).toBe(200);
        expect(res.body.id).toBe("doc-1");
    });

    it("returns 404 when the document does not exist", async () => {
        mockQuery.mockResolvedValue(mockEmpty());
        const res = await request(app).get("/single-documents/nonexistent");
        expect(res.status).toBe(404);
    });

    it("returns 403 when the document belongs to another user", async () => {
        mockQuery.mockResolvedValue(
            mockRow({ id: "doc-1", filename: "contract.pdf", user_id: "other" }),
        );
        const res = await request(app).get("/single-documents/doc-1");
        expect(res.status).toBe(403);
    });
});

// ── DELETE /single-documents/:id ──────────────────────────────────────────────

describe("DELETE /single-documents/:id", () => {
    it("deletes the document and returns 204", async () => {
        mockQuery
            .mockResolvedValueOnce(mockRow({ id: "doc-1", user_id: TEST_USER_ID }))
            .mockResolvedValueOnce(mockEmpty());
        const res = await request(app).delete("/single-documents/doc-1");
        expect(res.status).toBe(204);
    });

    it("returns 404 when the document does not exist", async () => {
        mockQuery.mockResolvedValue(mockEmpty());
        const res = await request(app).delete("/single-documents/doc-1");
        expect(res.status).toBe(404);
    });

    it("returns 403 when the document belongs to another user", async () => {
        mockQuery.mockResolvedValue(
            mockRow({ id: "doc-1", user_id: "other" }),
        );
        const res = await request(app).delete("/single-documents/doc-1");
        expect(res.status).toBe(403);
    });
});

// ── Document versions ─────────────────────────────────────────────────────────

describe("GET /single-documents/:id/versions", () => {
    it("returns the version list for a document owned by the user", async () => {
        mockQuery
            .mockResolvedValueOnce(mockRow({ id: "doc-1", user_id: TEST_USER_ID }))
            .mockResolvedValueOnce(
                mockRows([
                    { id: "v1", version_number: 1, source: "upload" },
                    { id: "v2", version_number: 2, source: "assistant_edit" },
                ]),
            );
        const res = await request(app).get("/single-documents/doc-1/versions");
        expect(res.status).toBe(200);
        expect(res.body).toHaveLength(2);
    });

    it("returns 403 when the document belongs to another user", async () => {
        mockQuery.mockResolvedValue(mockRow({ id: "doc-1", user_id: "other" }));
        const res = await request(app).get("/single-documents/doc-1/versions");
        expect(res.status).toBe(403);
    });
});

// ── Document edits ────────────────────────────────────────────────────────────

describe("GET /single-documents/:id/edits", () => {
    it("returns pending edits for the document", async () => {
        mockQuery
            .mockResolvedValueOnce(mockRow({ id: "doc-1", user_id: TEST_USER_ID }))
            .mockResolvedValueOnce(
                mockRows([{ id: "edit-1", status: "pending", inserted_text: "new text" }]),
            );
        const res = await request(app).get("/single-documents/doc-1/edits");
        expect(res.status).toBe(200);
    });
});

describe("PATCH /single-documents/:docId/edits/:editId", () => {
    it("accepts an edit and returns 200", async () => {
        mockQuery
            .mockResolvedValueOnce(mockRow({ id: "doc-1", user_id: TEST_USER_ID }))
            .mockResolvedValueOnce(mockRow({ id: "edit-1", status: "accepted" }));
        const res = await request(app)
            .patch("/single-documents/doc-1/edits/edit-1")
            .send({ status: "accepted" });
        expect(res.status).toBe(200);
    });

    it("returns 400 for an invalid status value", async () => {
        mockQuery.mockResolvedValue(mockRow({ id: "doc-1", user_id: TEST_USER_ID }));
        const res = await request(app)
            .patch("/single-documents/doc-1/edits/edit-1")
            .send({ status: "deleted" });
        expect(res.status).toBe(400);
    });
});
