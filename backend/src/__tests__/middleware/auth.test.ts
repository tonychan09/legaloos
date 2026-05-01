// Tests for the new Entra-based auth middleware (src/middleware/auth.ts).
// The middleware must:
//   1. Validate the JWT against Entra's JWKS endpoint
//   2. Check iss, aud, and exp claims
//   3. Extract the `oid` claim as userId and `email` as userEmail
//   4. Call next() on success, return 401/500 on failure

import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";

// Mock jwks-rsa so tests never hit the network.
jest.mock("jwks-rsa", () => ({
    __esModule: true,
    default: jest.fn().mockImplementation(() => ({
        getSigningKey: jest.fn((_kid, cb) =>
            cb(null, { getPublicKey: () => "mock-public-key" }),
        ),
    })),
}));

// Mock jsonwebtoken so we control what the decoded token looks like.
jest.mock("jsonwebtoken");
const mockVerify = jwt.verify as jest.Mock;

const TENANT_ID = "test-tenant-id";
const CLIENT_ID = "test-client-id";

function makeReq(authHeader?: string): Partial<Request> {
    return { headers: { authorization: authHeader } };
}

function makeRes(): Partial<Response> & {
    locals: Record<string, unknown>;
    statusCode?: number;
    body?: unknown;
} {
    const res: any = { locals: {} };
    res.status = jest.fn().mockReturnValue(res);
    res.json = jest.fn().mockImplementation((body) => {
        res.body = body;
        return res;
    });
    return res;
}

const next: NextFunction = jest.fn();

async function callMiddleware(req: Partial<Request>, res: Partial<Response>) {
    // Import lazily so env vars set in each test take effect.
    jest.resetModules();
    const { requireAuth } = await import("../../middleware/auth");
    await requireAuth(req as Request, res as Response, next);
}

beforeEach(() => {
    jest.clearAllMocks();
    process.env.ENTRA_TENANT_ID = TENANT_ID;
    process.env.ENTRA_CLIENT_ID = CLIENT_ID;
});

describe("requireAuth middleware", () => {
    describe("missing / malformed Authorization header", () => {
        it("returns 401 when Authorization header is absent", async () => {
            const res = makeRes();
            await callMiddleware(makeReq(undefined), res);
            expect((res.status as jest.Mock).mock.calls[0][0]).toBe(401);
            expect(next).not.toHaveBeenCalled();
        });

        it("returns 401 when scheme is not Bearer", async () => {
            const res = makeRes();
            await callMiddleware(makeReq("Basic abc123"), res);
            expect((res.status as jest.Mock).mock.calls[0][0]).toBe(401);
            expect(next).not.toHaveBeenCalled();
        });

        it("returns 401 when Bearer token is empty", async () => {
            const res = makeRes();
            await callMiddleware(makeReq("Bearer "), res);
            expect((res.status as jest.Mock).mock.calls[0][0]).toBe(401);
            expect(next).not.toHaveBeenCalled();
        });
    });

    describe("missing server configuration", () => {
        it("returns 500 when ENTRA_TENANT_ID is not set", async () => {
            delete process.env.ENTRA_TENANT_ID;
            const res = makeRes();
            await callMiddleware(makeReq("Bearer valid.token.here"), res);
            expect((res.status as jest.Mock).mock.calls[0][0]).toBe(500);
        });

        it("returns 500 when ENTRA_CLIENT_ID is not set", async () => {
            delete process.env.ENTRA_CLIENT_ID;
            const res = makeRes();
            await callMiddleware(makeReq("Bearer valid.token.here"), res);
            expect((res.status as jest.Mock).mock.calls[0][0]).toBe(500);
        });
    });

    describe("invalid tokens", () => {
        it("returns 401 when jwt.verify throws JsonWebTokenError", async () => {
            mockVerify.mockImplementation(() => {
                throw new jwt.JsonWebTokenError("invalid signature");
            });
            const res = makeRes();
            await callMiddleware(makeReq("Bearer bad.token"), res);
            expect((res.status as jest.Mock).mock.calls[0][0]).toBe(401);
            expect(next).not.toHaveBeenCalled();
        });

        it("returns 401 when token is expired", async () => {
            mockVerify.mockImplementation(() => {
                throw new jwt.TokenExpiredError("jwt expired", new Date());
            });
            const res = makeRes();
            await callMiddleware(makeReq("Bearer expired.token"), res);
            expect((res.status as jest.Mock).mock.calls[0][0]).toBe(401);
            expect(next).not.toHaveBeenCalled();
        });

        it("returns 401 when issuer does not match tenant", async () => {
            mockVerify.mockImplementation(() => {
                throw new jwt.JsonWebTokenError("jwt issuer invalid");
            });
            const res = makeRes();
            await callMiddleware(makeReq("Bearer wrong.iss.token"), res);
            expect((res.status as jest.Mock).mock.calls[0][0]).toBe(401);
        });

        it("returns 401 when audience does not match client ID", async () => {
            mockVerify.mockImplementation(() => {
                throw new jwt.JsonWebTokenError("jwt audience invalid");
            });
            const res = makeRes();
            await callMiddleware(makeReq("Bearer wrong.aud.token"), res);
            expect((res.status as jest.Mock).mock.calls[0][0]).toBe(401);
        });

        it("returns 401 when oid claim is missing from valid token", async () => {
            mockVerify.mockReturnValue({ email: "user@example.com" }); // no oid
            const res = makeRes();
            await callMiddleware(makeReq("Bearer no.oid.token"), res);
            expect((res.status as jest.Mock).mock.calls[0][0]).toBe(401);
            expect(next).not.toHaveBeenCalled();
        });
    });

    describe("valid token", () => {
        const validClaims = {
            oid: "user-object-id-123",
            email: "user@example.com",
            iss: `https://login.microsoftonline.com/${TENANT_ID}/v2.0`,
            aud: CLIENT_ID,
            exp: Math.floor(Date.now() / 1000) + 3600,
        };

        it("calls next() for a valid token", async () => {
            mockVerify.mockReturnValue(validClaims);
            const res = makeRes();
            await callMiddleware(makeReq("Bearer valid.token"), res);
            expect(next).toHaveBeenCalledTimes(1);
        });

        it("sets res.locals.userId to the oid claim", async () => {
            mockVerify.mockReturnValue(validClaims);
            const res = makeRes();
            await callMiddleware(makeReq("Bearer valid.token"), res);
            expect(res.locals.userId).toBe("user-object-id-123");
        });

        it("sets res.locals.userEmail to lowercase email claim", async () => {
            mockVerify.mockReturnValue({
                ...validClaims,
                email: "User@Example.COM",
            });
            const res = makeRes();
            await callMiddleware(makeReq("Bearer valid.token"), res);
            expect(res.locals.userEmail).toBe("user@example.com");
        });

        it("falls back to preferred_username when email claim is absent", async () => {
            mockVerify.mockReturnValue({
                ...validClaims,
                email: undefined,
                preferred_username: "fallback@example.com",
            });
            const res = makeRes();
            await callMiddleware(makeReq("Bearer valid.token"), res);
            expect(res.locals.userEmail).toBe("fallback@example.com");
        });

        it("does not return an error response for a valid token", async () => {
            mockVerify.mockReturnValue(validClaims);
            const res = makeRes();
            await callMiddleware(makeReq("Bearer valid.token"), res);
            expect((res.status as jest.Mock)).not.toHaveBeenCalled();
        });
    });
});
