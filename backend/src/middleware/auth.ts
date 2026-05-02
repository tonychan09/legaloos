import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import jwksClient from "jwks-rsa";

export async function requireAuth(
    req: Request,
    res: Response,
    next: NextFunction,
): Promise<void> {
    const auth = req.headers.authorization ?? "";
    if (!auth.startsWith("Bearer ") || !auth.slice(7).trim()) {
        res.status(401).json({ detail: "Missing or invalid Authorization header" });
        return;
    }
    const token = auth.slice(7).trim();

    const tenantId = process.env.ENTRA_TENANT_ID ?? "";
    const clientId = process.env.ENTRA_CLIENT_ID ?? "";

    if (!tenantId || !clientId) {
        res.status(500).json({ detail: "Server auth is not configured" });
        return;
    }

    const issuer = `https://login.microsoftonline.com/${tenantId}/v2.0`;
    const jwksUri = `${issuer}/discovery/v2.0/keys`;

    const client = jwksClient({ jwksUri });

    let decoded: jwt.JwtPayload;
    try {
        const kid = (jwt.decode(token, { complete: true }) as any)?.header?.kid;
        const signingKey = await new Promise<string>((resolve, reject) => {
            client.getSigningKey(kid, (err, key) => {
                if (err) reject(err);
                else resolve(key!.getPublicKey());
            });
        });
        decoded = jwt.verify(token, signingKey, {
            audience: clientId,
            issuer,
            algorithms: ["RS256"],
        }) as jwt.JwtPayload;
    } catch (err: any) {
        res.status(401).json({ detail: err.message ?? "Invalid or expired token" });
        return;
    }

    if (!decoded?.oid) {
        res.status(401).json({ detail: "Token missing oid claim" });
        return;
    }

    res.locals.userId = decoded.oid as string;
    res.locals.userEmail = (
        (decoded.email ?? decoded.preferred_username ?? "") as string
    ).toLowerCase();
    res.locals.token = token;
    next();
}
