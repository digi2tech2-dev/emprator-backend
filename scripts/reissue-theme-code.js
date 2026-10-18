'use strict';

// A replacement code must be delivered by the connected server-side WhatsApp
// session. This legacy standalone command intentionally cannot expose codes.
process.stderr.write('This command is retired. Sign in to /admin/themes on the running server and use “Issue and send a new code” after WhatsApp is connected.\n');
process.exitCode = 2;
