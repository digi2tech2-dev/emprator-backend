'use strict';

// Kept as a clear migration notice for server operators who used the old
// command. Running an isolated Node process cannot safely use the live
// application's connected WhatsApp session, and it must never print a code.
process.stderr.write('This command is retired. Sign in to /admin/themes on the running server, verify the transfer manually, then use “Confirm payment and send code”. The connected server WhatsApp session sends the code without exposing it in the terminal.\n');
process.exitCode = 2;
