"use strict";
const { backgroundJobsPolicy } = require('../config/backgroundJobs');
const { spawnSync } = require('child_process');
const path = require('path');
const valid = {
    NODE_ENV: 'production', MONGO_URI: 'mongodb://db.example.invalid/test', JWT_SECRET: 'x'.repeat(40),
    FRONTEND_URL: 'https://example.invalid', FRONTEND_VERIFY_REDIRECT_URL: 'https://example.invalid/verify',
    APP_URL: 'https://example.invalid', ALLOWED_ORIGINS: 'https://example.invalid',
    SAFE_LOCAL_PRODUCTION_MODE: 'false', BACKGROUND_JOBS_ENABLED: 'true',
    BACKGROUND_JOBS_MAINTENANCE: 'false', BACKGROUND_JOBS_DISABLED_REASON: '',
};
test.each([
    [{}, 0],
    [{ BACKGROUND_JOBS_ENABLED: 'false' }, 1],
    [{ BACKGROUND_JOBS_ENABLED: 'false', BACKGROUND_JOBS_MAINTENANCE: 'true' }, 1],
    [{ BACKGROUND_JOBS_ENABLED: 'false', BACKGROUND_JOBS_MAINTENANCE: 'true', BACKGROUND_JOBS_DISABLED_REASON: 'planned maintenance' }, 0],
    [{ BACKGROUND_JOBS_ENABLED: 'flase' }, 1],
    [{ ORDER_POLL_INTERVAL_SECONDS: '1' }, 1],
    [{ ORDER_POLL_INTERVAL_SECONDS: '10' }, 0],
])('production preflight validates %j', (overrides, status) => {
    const result = spawnSync(process.execPath, [path.resolve('scripts/verify-production-env.js')], {
        cwd: require('os').tmpdir(), env: { ...process.env, ...valid, ...overrides }, encoding: 'utf8',
    });
    expect(result.status).toBe(status);
});
test('explicit maintenance preserves disabled policy', () => {
    expect(backgroundJobsPolicy({ ...valid, BACKGROUND_JOBS_ENABLED: 'false', BACKGROUND_JOBS_MAINTENANCE: 'true',
        BACKGROUND_JOBS_DISABLED_REASON: 'maintenance' })).toEqual({ enabled: false, maintenance: true, errors: [] });
});
