// TEST-ONLY worker for pool.js (passed as `workerUrl`): throws while loading, so it never says hello.
// NEVER imported from src/.
throw new Error('boom at startup');
