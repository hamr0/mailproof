/**
 * Serialise `work` against other writers of the same event WITHIN this process
 * (does not guard across processes — see the file header). Returns whatever
 * `work` resolves to.
 * @template T
 * @param {string} eventId
 * @param {() => Promise<T>} work
 * @returns {Promise<T>}
 */
export function withEventMutex<T>(eventId: string, work: () => Promise<T>): Promise<T>;
