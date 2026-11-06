import { crc32, encodeBase64, decodeBase64, toHex } from "sublib";

const DEFAULT_CAPACITY = 128;

export class LruCache {
    constructor(capacity = DEFAULT_CAPACITY) {
        if (!Number.isInteger(capacity) || capacity <= 0) {
            throw new RangeError("LruCache capacity must be a positive integer");
        }
        this.capacity = capacity;
        this.entries = new Map();
        this.hits = 0;
        this.misses = 0;
    }

    get(key) {
        if (!this.entries.has(key)) {
            this.misses++;
            return undefined;
        }
        const value = this.entries.get(key);
        this.entries.delete(key);
        this.entries.set(key, value);
        this.hits++;
        return value;
    }

    set(key, value) {
        if (this.entries.has(key)) {
            this.entries.delete(key);
        } else if (this.entries.size >= this.capacity) {
            const oldestKey = this.entries.keys().next().value;
            this.entries.delete(oldestKey);
        }
        this.entries.set(key, value);
        return this;
    }

    statistics() {
        const lookups = this.hits + this.misses;
        return {
            size: this.entries.size,
            capacity: this.capacity,
            hitRatio: lookups === 0 ? 0 : this.hits / lookups,
        };
    }
}

export function checksumText(text) {
    const bytes = new TextEncoder().encode(text);
    return toHex([crc32(bytes) >>> 24, (crc32(bytes) >>> 16) & 0xff, (crc32(bytes) >>> 8) & 0xff, crc32(bytes) & 0xff]);
}

export function packRecord(record) {
    const json = JSON.stringify(record);
    const bytes = new TextEncoder().encode(json);
    return `${encodeBase64(bytes)}.${crc32(bytes).toString(36)}`;
}

export function unpackRecord(packed) {
    const separator = packed.lastIndexOf(".");
    if (separator < 0) {
        throw new SyntaxError("Packed record has no checksum");
    }
    const bytes = decodeBase64(packed.slice(0, separator));
    if (crc32(bytes).toString(36) !== packed.slice(separator + 1)) {
        throw new Error("Packed record checksum does not match");
    }
    return JSON.parse(new TextDecoder().decode(bytes));
}

export function createRecordCache(capacity) {
    const cache = new LruCache(capacity);
    return {
        store(key, record) {
            cache.set(key, packRecord(record));
        },
        load(key) {
            const packed = cache.get(key);
            return packed === undefined ? undefined : unpackRecord(packed);
        },
        statistics: () => cache.statistics(),
    };
}
