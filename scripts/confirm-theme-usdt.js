'use strict';

// Run only after independently checking the receiving Binance account or wallet,
// the chain/network, the unique transaction, and the net received amount.
require('dotenv').config();
const mongoose = require('mongoose');
const { confirmReceived } = require('../src/modules/theme/manualPayment.service');
const { ThemeCodeUse } = require('../src/modules/theme/subscription.model');

const values = Object.fromEntries(process.argv.slice(2).filter((part) => part.startsWith('--') && part.includes('='))
    .map((part) => part.slice(2).split(/=(.*)/s).slice(0, 2)));
if (!process.argv.includes('--confirm-received') || !process.env.MONGO_URI) {
    process.stderr.write('Usage: node scripts/confirm-theme-usdt.js --reference=THEME-... --network=TRC20|BEP20|BINANCE_ID --txid=... --reviewer=... --received=24.99 [--code=0123456789] --confirm-received\n');
    process.exit(2);
}

(async () => {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        await ThemeCodeUse.createIndexes();
        const result = await confirmReceived({ reference: values.reference, network: values.network,
            chainTransactionId: values.txid, reviewer: values.reviewer, receivedAmount: values.received,
            activationCode: values.code });
        process.stdout.write(`Verified ${result.reference}; one-time code ${result.code}; code expires ${result.codeExpiresAt.toISOString()}. Send it privately to the paying administrator.\n`);
    } catch (error) {
        process.stderr.write(`${error.code || error.name}: ${error.message}\n`);
        process.exitCode = 1;
    } finally { await mongoose.disconnect(); }
})();
