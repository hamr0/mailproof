// TEST-ONLY module-resolution hook: makes `import 'better-sqlite3'` fail the way a platform without the native addon
// would. Registered by no-sqlite-register.js (node --import). NEVER imported from src/.
export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'better-sqlite3') throw Object.assign(new Error('Cannot find package \'better-sqlite3\''), { code: 'ERR_MODULE_NOT_FOUND' });
  return nextResolve(specifier, context);
}
