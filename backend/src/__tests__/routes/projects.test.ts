// Tests for /projects routes after migration to Azure PostgreSQL.

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
    const { projectsRouter } = await import("../../routes/projects");
    app.use("/projects", projectsRouter);
});

beforeEach(() => mockQuery.mockReset());

// ── GET /projects ─────────────────────────────────────────────────────────────

describe("GET /projects", () => {
    it("returns projects owned by or shared with the user", async () => {
        mockQuery.mockResolvedValue(
            mockRows([
                { id: "proj-1", name: "Project One", user_id: TEST_USER_ID },
            ]),
        );
        const res = await request(app).get("/projects");
        expect(res.status).toBe(200);
        expect(Array.isArray(res.body)).toBe(true);
    });

    it("returns an empty array when the user has no projects", async () => {
        mockQuery.mockResolvedValue(mockEmpty());
        const res = await request(app).get("/projects");
        expect(res.status).toBe(200);
        expect(res.body).toEqual([]);
    });

    it("scopes the query to the authenticated userId", async () => {
        mockQuery.mockResolvedValue(mockEmpty());
        await request(app).get("/projects");
        expect(mockQuery.mock.calls[0][1]).toContain(TEST_USER_ID);
    });
});

// ── POST /projects ────────────────────────────────────────────────────────────

describe("POST /projects", () => {
    it("creates a project and returns 201 with the new record", async () => {
        mockQuery.mockResolvedValue(
            mockRow({ id: "new-proj", name: "My Project", user_id: TEST_USER_ID }),
        );
        const res = await request(app)
            .post("/projects")
            .send({ name: "My Project" });
        expect(res.status).toBe(201);
        expect(res.body.id).toBe("new-proj");
    });

    it("returns 400 when name is missing", async () => {
        const res = await request(app).post("/projects").send({});
        expect(res.status).toBe(400);
    });

    it("returns 400 when name is an empty string", async () => {
        const res = await request(app).post("/projects").send({ name: "" });
        expect(res.status).toBe(400);
    });
});

// ── GET /projects/:id ─────────────────────────────────────────────────────────

describe("GET /projects/:id", () => {
    it("returns the project when owned by the user", async () => {
        mockQuery.mockResolvedValue(
            mockRow({ id: "proj-1", name: "Project One", user_id: TEST_USER_ID }),
        );
        const res = await request(app).get("/projects/proj-1");
        expect(res.status).toBe(200);
        expect(res.body.id).toBe("proj-1");
    });

    it("returns 404 when the project does not exist", async () => {
        mockQuery.mockResolvedValue(mockEmpty());
        const res = await request(app).get("/projects/nonexistent");
        expect(res.status).toBe(404);
    });

    it("returns 403 when the project belongs to another user and is not shared", async () => {
        mockQuery.mockResolvedValue(
            mockRow({ id: "proj-1", name: "Other", user_id: "other-user", shared_with: [] }),
        );
        const res = await request(app).get("/projects/proj-1");
        expect(res.status).toBe(403);
    });
});

// ── PATCH /projects/:id ───────────────────────────────────────────────────────

describe("PATCH /projects/:id", () => {
    it("updates the project and returns 200", async () => {
        mockQuery
            .mockResolvedValueOnce(mockRow({ id: "proj-1", user_id: TEST_USER_ID }))
            .mockResolvedValueOnce(mockRow({ id: "proj-1", name: "Renamed" }));
        const res = await request(app)
            .patch("/projects/proj-1")
            .send({ name: "Renamed" });
        expect(res.status).toBe(200);
    });

    it("returns 403 when the user does not own the project", async () => {
        mockQuery.mockResolvedValue(mockRow({ id: "proj-1", user_id: "other" }));
        const res = await request(app)
            .patch("/projects/proj-1")
            .send({ name: "Renamed" });
        expect(res.status).toBe(403);
    });

    it("returns 404 when the project does not exist", async () => {
        mockQuery.mockResolvedValue(mockEmpty());
        const res = await request(app)
            .patch("/projects/proj-1")
            .send({ name: "Renamed" });
        expect(res.status).toBe(404);
    });
});

// ── DELETE /projects/:id ──────────────────────────────────────────────────────

describe("DELETE /projects/:id", () => {
    it("deletes the project and returns 204", async () => {
        mockQuery
            .mockResolvedValueOnce(mockRow({ id: "proj-1", user_id: TEST_USER_ID }))
            .mockResolvedValueOnce(mockEmpty());
        const res = await request(app).delete("/projects/proj-1");
        expect(res.status).toBe(204);
    });

    it("returns 403 when the user does not own the project", async () => {
        mockQuery.mockResolvedValue(mockRow({ id: "proj-1", user_id: "other" }));
        const res = await request(app).delete("/projects/proj-1");
        expect(res.status).toBe(403);
    });

    it("returns 404 when the project does not exist", async () => {
        mockQuery.mockResolvedValue(mockEmpty());
        const res = await request(app).delete("/projects/proj-1");
        expect(res.status).toBe(404);
    });
});

// ── Subfolders ────────────────────────────────────────────────────────────────

describe("POST /projects/:id/subfolders", () => {
    it("creates a subfolder and returns 201", async () => {
        mockQuery
            .mockResolvedValueOnce(mockRow({ id: "proj-1", user_id: TEST_USER_ID }))
            .mockResolvedValueOnce(mockRow({ id: "folder-1", name: "Folder A" }));
        const res = await request(app)
            .post("/projects/proj-1/subfolders")
            .send({ name: "Folder A" });
        expect(res.status).toBe(201);
    });

    it("returns 400 when folder name is missing", async () => {
        mockQuery.mockResolvedValue(mockRow({ id: "proj-1", user_id: TEST_USER_ID }));
        const res = await request(app)
            .post("/projects/proj-1/subfolders")
            .send({});
        expect(res.status).toBe(400);
    });

    it("returns 403 when the user does not own the project", async () => {
        mockQuery.mockResolvedValue(mockRow({ id: "proj-1", user_id: "other" }));
        const res = await request(app)
            .post("/projects/proj-1/subfolders")
            .send({ name: "Folder A" });
        expect(res.status).toBe(403);
    });
});

describe("DELETE /projects/:id/subfolders/:folderId", () => {
    it("deletes the subfolder and returns 204", async () => {
        mockQuery
            .mockResolvedValueOnce(mockRow({ id: "proj-1", user_id: TEST_USER_ID }))
            .mockResolvedValueOnce(mockEmpty());
        const res = await request(app).delete("/projects/proj-1/subfolders/folder-1");
        expect(res.status).toBe(204);
    });
});

// ── User email lookup (replaces supabase.auth.admin.listUsers) ────────────────

describe("GET /projects/:id/members", () => {
    it("returns member emails from the users table", async () => {
        mockQuery
            .mockResolvedValueOnce(
                mockRow({ id: "proj-1", user_id: TEST_USER_ID, shared_with: ["user-2"] }),
            )
            .mockResolvedValueOnce(
                mockRows([{ id: "user-2", email: "colleague@example.com" }]),
            );
        const res = await request(app).get("/projects/proj-1/members");
        expect(res.status).toBe(200);
        expect(res.body.some((m: any) => m.email === "colleague@example.com")).toBe(true);
    });
});
