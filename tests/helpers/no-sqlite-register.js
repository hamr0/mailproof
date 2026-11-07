// TEST-ONLY: `node --import tests/helpers/no-sqlite-register.js child.js` runs child.js with better-sqlite3 unloadable.
import { register } from 'node:module';
register('./no-sqlite-hooks.js', import.meta.url);
