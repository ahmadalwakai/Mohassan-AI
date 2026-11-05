import { createApplication } from './app.js';
import { getConfig } from './config.js';
const config = getConfig();
const {app} = await createApplication(config);
await app.listen({port: Number(process.env.SERVER_PORT ?? 4000), host: process.env.SERVER_HOST ?? '127.0.0.1'});
console.log(`Mohassan API ready on port ${process.env.SERVER_PORT ?? 4000}`);
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, async () => {await app.close(); process.exit(0);});
