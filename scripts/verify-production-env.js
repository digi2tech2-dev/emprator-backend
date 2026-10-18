'use strict';

require('dotenv').config();

const errors = [];
const warnings = [];
const value = (key) => String(process.env[key] || '').trim();
const isHttpUrl = (raw) => {
    try {
        const url = new URL(raw);
        return url.protocol === 'https:' && Boolean(url.host);
    } catch (_) { return false; }
};

if (value('NODE_ENV') !== 'production') errors.push('NODE_ENV must equal production.');
if (!/^mongodb(?:\+srv)?:\/\//.test(value('MONGO_URI')) || /localhost|127\.0\.0\.1/i.test(value('MONGO_URI'))) {
    errors.push('MONGO_URI must point to a non-local MongoDB replica set or Atlas cluster.');
}
if (value('JWT_SECRET').length < 32 || value('JWT_SECRET') === 'replace_with_a_long_random_secret') {
    errors.push('JWT_SECRET must be a unique secret with at least 32 characters.');
}
for (const key of ['FRONTEND_URL', 'FRONTEND_VERIFY_REDIRECT_URL', 'APP_URL']) {
    if (!isHttpUrl(value(key))) errors.push(`${key} must be an HTTPS URL.`);
}
const origins = value('ALLOWED_ORIGINS').split(',').map((origin) => origin.trim()).filter(Boolean);
if (!origins.length || origins.some((origin) => !isHttpUrl(origin))) {
    errors.push('ALLOWED_ORIGINS must contain one or more comma-separated HTTPS frontend origins.');
}
if (value('SAFE_LOCAL_PRODUCTION_MODE').toLowerCase() === 'true') {
    errors.push('SAFE_LOCAL_PRODUCTION_MODE must not be true in production.');
}
if (value('BACKGROUND_JOBS_ENABLED').toLowerCase() === 'false') {
    warnings.push('BACKGROUND_JOBS_ENABLED=false: provider and fulfillment jobs will remain disabled.');
}
if (value('WHATSAPP_AUTO_INIT').toLowerCase() === 'false') {
    warnings.push('WHATSAPP_AUTO_INIT=false: WhatsApp notifications will remain disabled.');
}

warnings.forEach((message) => console.warn(`Warning: ${message}`));
if (errors.length) {
    errors.forEach((message) => console.error(`Invalid production configuration: ${message}`));
    process.exitCode = 1;
} else {
    console.log('Production environment configuration passed.');
}
