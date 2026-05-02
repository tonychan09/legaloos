import { PublicClientApplication } from "@azure/msal-browser";

const msalConfig = {
    auth: {
        clientId: process.env.NEXT_PUBLIC_MSAL_CLIENT_ID ?? "",
        authority:
            process.env.NEXT_PUBLIC_MSAL_AUTHORITY ??
            `https://login.microsoftonline.com/${process.env.NEXT_PUBLIC_MSAL_TENANT_ID ?? "common"}`,
        redirectUri: process.env.NEXT_PUBLIC_MSAL_REDIRECT_URI ?? "/",
    },
    cache: {
        cacheLocation: "sessionStorage" as const,
        storeAuthStateInCookie: false,
    },
};

export const msalInstance = new PublicClientApplication(msalConfig);
