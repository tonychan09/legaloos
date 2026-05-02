"use client";

import React, {
    createContext,
    useContext,
    useEffect,
    useState,
    ReactNode,
} from "react";
import { EventType, InteractionRequiredAuthError } from "@azure/msal-browser";
import { msalInstance } from "@/lib/msal";

interface User {
    id: string;
    email: string;
}

interface AuthContextType {
    user: User | null;
    isAuthenticated: boolean;
    authLoading: boolean;
    signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

const LOGIN_SCOPES = ["openid", "profile", "email"];
const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001";

async function ensureProfile(accessToken: string) {
    await fetch(`${API_BASE}/user/profile`, {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}` },
    }).catch(() => {});
}

export function AuthProvider({ children }: { children: ReactNode }) {
    const [user, setUser] = useState<User | null>(null);
    const [authLoading, setAuthLoading] = useState(true);

    async function resolveAccount(account: any) {
        try {
            const result = await msalInstance.acquireTokenSilent({
                scopes: LOGIN_SCOPES,
                account,
            });
            const claims = result.idTokenClaims as Record<string, unknown> | undefined;
            const oid = (claims?.oid as string) ?? (account.localAccountId as string);
            const email = ((claims?.email ?? account.username ?? "") as string).toLowerCase();
            setUser({ id: oid, email });
            await ensureProfile(result.accessToken);
        } catch (err) {
            if (err instanceof InteractionRequiredAuthError) {
                setUser(null);
            } else {
                throw err;
            }
        }
    }

    useEffect(() => {
        let callbackId: string | null = null;

        const checkUser = async () => {
            const accounts = msalInstance.getAllAccounts();
            if (accounts.length > 0) {
                await resolveAccount(accounts[0]);
            }
            setAuthLoading(false);
        };

        callbackId = msalInstance.addEventCallback(async (event: any) => {
            if (
                event.eventType === EventType.LOGIN_SUCCESS &&
                event.payload?.account
            ) {
                await resolveAccount(event.payload.account);
            } else if (event.eventType === EventType.LOGOUT_SUCCESS) {
                setUser(null);
            }
        });

        checkUser();

        return () => {
            if (callbackId) msalInstance.removeEventCallback(callbackId);
        };
    }, []);

    const signOut = async () => {
        await msalInstance.logoutRedirect();
        setUser(null);
    };

    return (
        <AuthContext.Provider
            value={{
                user,
                isAuthenticated: !!user,
                authLoading,
                signOut,
            }}
        >
            {children}
        </AuthContext.Provider>
    );
}

export function useAuth() {
    const context = useContext(AuthContext);
    if (context === undefined) {
        throw new Error("useAuth must be used within an AuthProvider");
    }
    return context;
}
