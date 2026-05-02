// Manual mock for jsonwebtoken.
// Stores jest.fn() instances in global so they survive jest.resetModules(),
// which would otherwise create a fresh auto-mock (different jest.fn() instance)
// on every dynamic import in tests that call jest.resetModules().

if (!global.__jwtMocks) {
    global.__jwtMocks = {
        verify: jest.fn(),
        sign: jest.fn(),
        decode: jest.fn(),
    };
}

class JsonWebTokenError extends Error {
    constructor(message) {
        super(message);
        this.name = "JsonWebTokenError";
    }
}

class TokenExpiredError extends JsonWebTokenError {
    constructor(message, expiredAt) {
        super(message);
        this.name = "TokenExpiredError";
        this.expiredAt = expiredAt;
    }
}

class NotBeforeError extends JsonWebTokenError {
    constructor(message, date) {
        super(message);
        this.name = "NotBeforeError";
        this.date = date;
    }
}

const mock = {
    verify: global.__jwtMocks.verify,
    sign: global.__jwtMocks.sign,
    decode: global.__jwtMocks.decode,
    JsonWebTokenError,
    TokenExpiredError,
    NotBeforeError,
};

module.exports = mock;
module.exports.default = mock;
module.exports.__esModule = true;
