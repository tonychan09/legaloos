import type { Config } from "jest";

const config: Config = {
    preset: "ts-jest",
    testEnvironment: "jsdom",
    roots: ["<rootDir>/src"],
    testMatch: ["**/__tests__/**/*.test.{ts,tsx}"],
    setupFilesAfterFramework: ["<rootDir>/jest.setup.ts"],
    moduleNameMapper: {
        "^@/(.*)$": "<rootDir>/src/$1",
        // Stub out CSS modules and static assets.
        "\\.(css|less|scss|sass)$": "<rootDir>/src/__tests__/__mocks__/styleMock.ts",
    },
    clearMocks: true,
};

export default config;
