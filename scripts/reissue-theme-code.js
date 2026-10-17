'use strict';

// Operator-only recovery for a verified transfer whose code expired or was lost.
require('dotenv').config();
const mongoose = require('mongoose');
const { reissueCode } = require('../src/modules/theme/manualPayment.service');
const { ThemeCodeUse } = require('../src/modules/theme/subscription.model');

const values = Object.fromEntries(process.argv.slice(2).filter((part) => part.startsWith('--') && part.includes('='))
    .map((part) => part.slice(2).split(/=(.*)/s).slice(0, 2)));
if (!process.argv.includes('--reissue-code') || !process.env.MONGO_URI) {
    process.stderr.write('Usage: node scripts/reissue-theme-code.js --reference=THEME-... --reviewer=... [--code=0123456789] --reissue-code\n');
    process.exit(2);
}

(async () => {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        await ThemeCodeUse.createIndexes();
        const result = await reissueCode({ reference: values.reference, reviewer: values.reviewer,
            activationCode: values.code });
        process.stdout.write(`Reissued ${result.reference}; one-time code ${result.code}; code expires ${result.codeExpiresAt.toISOString()}. Send it privately to the paying administrator.\n`);
    } catch (error) {
        process.stderr.write(`${error.code || error.name}: ${error.message}\n`);
        process.exitCode = 1;
    } finally { await mongoose.disconnect(); }
})();
