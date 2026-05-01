// Tests for /workflows routes after migration to Azure PostgreSQL.
// Notable: listUsers() previously called supabase.auth.admin.listUsers() —
// after migration it must query the users table directly.

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
    const { workflowsRouter } = await import("../../routes/workflows");
    app.use("/workflows", workflowsRouter);
});

beforeEach(() => mockQuery.mockReset());

// ── GET /workflows ────────────────────────────────────────────────────────────

describe("GET /workflows", () => {
    it("returns system workflows and user-owned workflows", async () => {
        mockQuery.mockResolvedValue(
            mockRows([
                { id: "wf-system", title: "NDA Review", is_system: true, user_id: null },
                { id: "wf-user", title: "My Workflow", is_system: false, user_id: TEST_USER_ID },
            ]),
        );
        const res = await request(app).get("/workflows");
        expect(res.status).toBe(200);
        expect(res.body).toHaveLength(2);
    });

    it("excludes workflows the user has hidden", async () => {
        // First query returns all; second returns hidden IDs.
        mockQuery
            .mockResolvedValueOnce(
                mockRows([
                    { id: "wf-1", is_system: true },
                    { id: "wf-2", is_system: true },
                ]),
            )
            .mockResolvedValueOnce(mockRows([{ workflow_id: "wf-2" }]));
        const res = await request(app).get("/workflows");
        expect(res.status).toBe(200);
        expect(res.body.every((w: any) => w.id !== "wf-2")).toBe(true);
    });
});

// ── POST /workflows ───────────────────────────────────────────────────────────

describe("POST /workflows", () => {
    it("creates a workflow and returns 201", async () => {
        mockQuery.mockResolvedValue(
            mockRow({ id: "wf-new", title: "Custom", type: "extraction" }),
        );
        const res = await request(app)
            .post("/workflows")
            .send({ title: "Custom", type: "extraction", promptMd: "Extract clauses." });
        expect(res.status).toBe(201);
        expect(res.body.id).toBe("wf-new");
    });

    it("returns 400 when title is missing", async () => {
        const res = await request(app)
            .post("/workflows")
            .send({ type: "extraction" });
        expect(res.status).toBe(400);
    });

    it("returns 400 when type is missing", async () => {
        const res = await request(app)
            .post("/workflows")
            .send({ title: "Custom" });
        expect(res.status).toBe(400);
    });
});

// ── PATCH /workflows/:id ──────────────────────────────────────────────────────

describe("PATCH /workflows/:id", () => {
    it("updates a user-owned workflow and returns 200", async () => {
        mockQuery
            .mockResolvedValueOnce(mockRow({ id: "wf-1", user_id: TEST_USER_ID, is_system: false }))
            .mockResolvedValueOnce(mockRow({ id: "wf-1", title: "Updated" }));
        const res = await request(app)
            .patch("/workflows/wf-1")
            .send({ title: "Updated" });
        expect(res.status).toBe(200);
    });

    it("returns 403 when the user does not own the workflow", async () => {
        mockQuery.mockResolvedValue(mockRow({ id: "wf-1", user_id: "other", is_system: false }));
        const res = await request(app)
            .patch("/workflows/wf-1")
            .send({ title: "Updated" });
        expect(res.status).toBe(403);
    });

    it("returns 403 when attempting to edit a system workflow", async () => {
        mockQuery.mockResolvedValue(mockRow({ id: "wf-sys", user_id: null, is_system: true }));
        const res = await request(app)
            .patch("/workflows/wf-sys")
            .send({ title: "Hacked" });
        expect(res.status).toBe(403);
    });

    it("returns 404 when the workflow does not exist", async () => {
        mockQuery.mockResolvedValue(mockEmpty());
        const res = await request(app)
            .patch("/workflows/nonexistent")
            .send({ title: "Updated" });
        expect(res.status).toBe(404);
    });
});

// ── DELETE /workflows/:id ─────────────────────────────────────────────────────

describe("DELETE /workflows/:id", () => {
    it("deletes a user-owned workflow and returns 204", async () => {
        mockQuery
            .mockResolvedValueOnce(mockRow({ id: "wf-1", user_id: TEST_USER_ID, is_system: false }))
            .mockResolvedValueOnce(mockEmpty());
        const res = await request(app).delete("/workflows/wf-1");
        expect(res.status).toBe(204);
    });

    it("returns 403 when the user does not own the workflow", async () => {
        mockQuery.mockResolvedValue(mockRow({ id: "wf-1", user_id: "other", is_system: false }));
        const res = await request(app).delete("/workflows/wf-1");
        expect(res.status).toBe(403);
    });

    it("returns 403 for system workflows", async () => {
        mockQuery.mockResolvedValue(mockRow({ id: "wf-sys", user_id: null, is_system: true }));
        const res = await request(app).delete("/workflows/wf-sys");
        expect(res.status).toBe(403);
    });
});

// ── Workflow sharing ──────────────────────────────────────────────────────────

describe("POST /workflows/:id/shares", () => {
    it("shares a workflow with an email and returns 201", async () => {
        mockQuery
            .mockResolvedValueOnce(mockRow({ id: "wf-1", user_id: TEST_USER_ID }))
            .mockResolvedValueOnce(mockRow({ id: "share-1" }));
        const res = await request(app)
            .post("/workflows/wf-1/shares")
            .send({ email: "colleague@example.com", allowEdit: false });
        expect(res.status).toBe(201);
    });

    it("returns 400 when email is missing", async () => {
        mockQuery.mockResolvedValue(mockRow({ id: "wf-1", user_id: TEST_USER_ID }));
        const res = await request(app)
            .post("/workflows/wf-1/shares")
            .send({});
        expect(res.status).toBe(400);
    });

    it("returns 403 when the user does not own the workflow", async () => {
        mockQuery.mockResolvedValue(mockRow({ id: "wf-1", user_id: "other" }));
        const res = await request(app)
            .post("/workflows/wf-1/shares")
            .send({ email: "someone@example.com" });
        expect(res.status).toBe(403);
    });
});

describe("DELETE /workflows/:id/shares/:shareId", () => {
    it("removes a share and returns 204", async () => {
        mockQuery
            .mockResolvedValueOnce(mockRow({ id: "wf-1", user_id: TEST_USER_ID }))
            .mockResolvedValueOnce(mockEmpty());
        const res = await request(app).delete("/workflows/wf-1/shares/share-1");
        expect(res.status).toBe(204);
    });
});

// ── Hidden workflows ──────────────────────────────────────────────────────────

describe("POST /workflows/:id/hide", () => {
    it("hides a workflow for the user and returns 200", async () => {
        mockQuery.mockResolvedValue(mockEmpty());
        const res = await request(app).post("/workflows/wf-sys/hide");
        expect(res.status).toBe(200);
    });
});

describe("DELETE /workflows/:id/hide", () => {
    it("unhides a workflow for the user and returns 200", async () => {
        mockQuery.mockResolvedValue(mockEmpty());
        const res = await request(app).delete("/workflows/wf-sys/hide");
        expect(res.status).toBe(200);
    });
});

// ── User email lookup (replaces supabase.auth.admin.listUsers) ────────────────

describe("workflow shares email lookup", () => {
    it("resolves share emails from the users table, not Supabase Auth", async () => {
        mockQuery
            .mockResolvedValueOnce(mockRow({ id: "wf-1", user_id: TEST_USER_ID }))
            .mockResolvedValueOnce(
                mockRows([
                    { shared_with_email: "a@example.com", allow_edit: false },
                ]),
            )
            // Users table lookup by email.
            .mockResolvedValueOnce(mockRows([{ id: "user-2", email: "a@example.com" }]));
        const res = await request(app).get("/workflows/wf-1/shares");
        expect(res.status).toBe(200);
    });
});
