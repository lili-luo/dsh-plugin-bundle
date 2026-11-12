/**
 * Identity of the code that is actually running: a digest of the compiled
 * plugin modules and of the `agy` binary. A version string alone cannot tell
 * two builds of `0.4.0` apart, so diagnostics record these digests instead.
 * @module dsh-llm-antigravity-acp/run-fingerprint
 */
import { createHash } from 'node:crypto';
import { createReadStream, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
let pluginDigest;
const binaryDigests = new Map();
/**
 * Digest of every compiled module next to this one, in name order.
 * @returns the first 12 hex characters of the SHA-256, or `unknown` when unreadable.
 */
export function pluginBuildDigest() {
    if (pluginDigest !== undefined)
        return pluginDigest;
    try {
        const dir = dirname(fileURLToPath(import.meta.url));
        const hash = createHash('sha256');
        for (const name of readdirSync(dir).filter(n => n.endsWith('.js')).sort()) {
            hash.update(name).update('\0').update(readFileSync(join(dir, name))).update('\0');
        }
        pluginDigest = hash.digest('hex').slice(0, 12);
    }
    catch {
        pluginDigest = 'unknown';
    }
    return pluginDigest;
}
/**
 * Digest of one executable, computed once per path.
 * @param path - absolute path of the binary.
 * @returns the first 12 hex characters of the SHA-256, or undefined when unreadable.
 */
export function binaryDigest(path) {
    let pending = binaryDigests.get(path);
    if (pending === undefined) {
        pending = new Promise(resolve => {
            const hash = createHash('sha256');
            const stream = createReadStream(path);
            stream.on('data', chunk => hash.update(chunk));
            stream.on('end', () => resolve(hash.digest('hex').slice(0, 12)));
            stream.on('error', () => resolve(undefined));
        });
        binaryDigests.set(path, pending);
    }
    return pending;
}
