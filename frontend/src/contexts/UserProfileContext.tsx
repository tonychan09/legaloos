"use client";

import React, {
    createContext,
    useContext,
    useEffect,
    useState,
    ReactNode,
    useCallback,
} from "react";
import { apiFetch } from "@/app/lib/mikeApi";
import { useAuth } from "@/contexts/AuthContext";

interface UserProfile {
    displayName: string | null;
    organisation: string | null;
    messageCreditsUsed: number;
    creditsResetDate: string;
    creditsRemaining: number;
    tier: string;
    tabularModel: string;
    claudeApiKey: string | null;
    geminiApiKey: string | null;
    azureApiKey: string | null;
    azureEndpoint: string | null;
}

interface UserProfileContextType {
    profile: UserProfile | null;
    loading: boolean;
    updateDisplayName: (name: string) => Promise<boolean>;
    updateOrganisation: (organisation: string) => Promise<boolean>;
    updateModelPreference: (
        field: "tabularModel",
        value: string,
    ) => Promise<boolean>;
    updateApiKey: (
        provider: "claude" | "gemini" | "azure",
        value: string | null,
    ) => Promise<boolean>;
    updateAzureEndpoint: (value: string | null) => Promise<boolean>;
    reloadProfile: () => Promise<void>;
    incrementMessageCredits: () => Promise<boolean>;
}

const UserProfileContext = createContext<UserProfileContextType | undefined>(
    undefined,
);

const DEFAULT_PROFILE: UserProfile = {
    displayName: null,
    organisation: null,
    messageCreditsUsed: 0,
    creditsResetDate: new Date(Date.now() + 30 * 86400000).toISOString(),
    creditsRemaining: 999999,
    tier: "Free",
    tabularModel: "gemini-3-flash-preview",
    claudeApiKey: null,
    geminiApiKey: null,
    azureApiKey: null,
    azureEndpoint: null,
};

export function UserProfileProvider({ children }: { children: ReactNode }) {
    const { isAuthenticated } = useAuth();
    const [profile, setProfile] = useState<UserProfile | null>(null);
    const [loading, setLoading] = useState(true);

    const loadProfile = useCallback(async () => {
        try {
            const resp = await apiFetch("/user/profile", { method: "GET" });
            if (!resp.ok) {
                setProfile(DEFAULT_PROFILE);
                return;
            }
            const data = await resp.json();
            setProfile(data as UserProfile);
        } catch {
            setProfile(DEFAULT_PROFILE);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        if (isAuthenticated) {
            setLoading(true);
            loadProfile();
        } else {
            setProfile(null);
            setLoading(false);
        }
    }, [isAuthenticated, loadProfile]);

    const updateDisplayName = useCallback(
        async (displayName: string): Promise<boolean> => {
            try {
                const resp = await apiFetch("/user/profile/display-name", {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ displayName }),
                });
                if (!resp.ok) return false;
                setProfile((prev) => (prev ? { ...prev, displayName } : null));
                return true;
            } catch {
                return false;
            }
        },
        [],
    );

    const updateOrganisation = useCallback(
        async (organisation: string): Promise<boolean> => {
            try {
                const resp = await apiFetch("/user/profile/organisation", {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ organisation }),
                });
                if (!resp.ok) return false;
                setProfile((prev) => (prev ? { ...prev, organisation } : null));
                return true;
            } catch {
                return false;
            }
        },
        [],
    );

    const updateModelPreference = useCallback(
        async (field: "tabularModel", value: string): Promise<boolean> => {
            try {
                const resp = await apiFetch("/user/profile/model", {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ model: value }),
                });
                if (!resp.ok) return false;
                setProfile((prev) => (prev ? { ...prev, [field]: value } : null));
                return true;
            } catch {
                return false;
            }
        },
        [],
    );

    const updateApiKey = useCallback(
        async (
            provider: "claude" | "gemini" | "azure",
            value: string | null,
        ): Promise<boolean> => {
            const stateField =
                provider === "claude"
                    ? "claudeApiKey"
                    : provider === "azure"
                      ? "azureApiKey"
                      : "geminiApiKey";
            const apiKey = value?.trim() || null;
            try {
                const resp = await apiFetch("/user/profile/api-key", {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ provider, apiKey }),
                });
                if (!resp.ok) return false;
                setProfile((prev) =>
                    prev ? { ...prev, [stateField]: apiKey } : null,
                );
                return true;
            } catch {
                return false;
            }
        },
        [],
    );

    const updateAzureEndpoint = useCallback(
        async (value: string | null): Promise<boolean> => {
            const endpoint = value?.trim() || null;
            try {
                const resp = await apiFetch("/user/profile/azure-endpoint", {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ endpoint }),
                });
                if (!resp.ok) return false;
                setProfile((prev) =>
                    prev ? { ...prev, azureEndpoint: endpoint } : null,
                );
                return true;
            } catch {
                return false;
            }
        },
        [],
    );

    const reloadProfile = useCallback(async () => {
        await loadProfile();
    }, [loadProfile]);

    const incrementMessageCredits = useCallback(async (): Promise<boolean> => {
        if (!profile) return false;
        if (profile.creditsRemaining <= 0) return false;
        const newCreditsUsed = profile.messageCreditsUsed + 1;
        setProfile((prev) =>
            prev
                ? {
                      ...prev,
                      messageCreditsUsed: newCreditsUsed,
                      creditsRemaining: 999999 - newCreditsUsed,
                  }
                : null,
        );
        return true;
    }, [profile]);

    return (
        <UserProfileContext.Provider
            value={{
                profile,
                loading,
                updateDisplayName,
                updateOrganisation,
                updateModelPreference,
                updateApiKey,
                updateAzureEndpoint,
                reloadProfile,
                incrementMessageCredits,
            }}
        >
            {children}
        </UserProfileContext.Provider>
    );
}

export function useUserProfile() {
    const context = useContext(UserProfileContext);
    if (context === undefined) {
        throw new Error(
            "useUserProfile must be used within a UserProfileProvider",
        );
    }
    return context;
}
