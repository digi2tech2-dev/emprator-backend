"use strict";

// Shared by runtime startup and the offline production preflight.
const backgroundJobsPolicy = (env = process.env) => {
    const value = String(env.BACKGROUND_JOBS_ENABLED ?? '').trim().toLowerCase();
    const disabled = value === 'false';
    const maintenance = env.BACKGROUND_JOBS_MAINTENANCE === 'true'
        && Boolean(String(env.BACKGROUND_JOBS_DISABLED_REASON || '').trim());
    const errors = [];
    try { require('./orderPolling').getOrderPollSchedule(env); }
    catch (error) { errors.push(error.message); }
    if (value && !['true', 'false'].includes(value)) errors.push('BACKGROUND_JOBS_ENABLED must be true or false.');
    if (env.NODE_ENV === 'production' && disabled && !maintenance) {
        errors.push('BACKGROUND_JOBS_ENABLED=false requires BACKGROUND_JOBS_MAINTENANCE=true and a non-empty BACKGROUND_JOBS_DISABLED_REASON.');
    }
    return { enabled: !disabled, maintenance: disabled && maintenance, errors };
};
module.exports = { backgroundJobsPolicy };
