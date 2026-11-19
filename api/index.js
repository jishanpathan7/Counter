// Vercel entry point: the whole API runs as one serverless function.
// vercel.json rewrites /api/* and /webhooks/* here; the built app in dist/ is served as static files.
import { createRuntime } from '../server/runtime.js';

const { app } = createRuntime({ serverless: true });

export default app;
