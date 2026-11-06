const CRC32_POLYNOMIAL = 0xedb88320;
const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

let crcTable = null;

function buildCrcTable() {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) {
            c = c & 1 ? CRC32_POLYNOMIAL ^ (c >>> 1) : c >>> 1;
        }
        table[n] = c >>> 0;
    }
    return table;
}

export function crc32(bytes) {
    if (crcTable === null) {
        crcTable = buildCrcTable();
    }
    let crc = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) {
        crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
}

export function encodeBase64(bytes) {
    let output = "";
    let i = 0;
    for (; i + 2 < bytes.length; i += 3) {
        const chunk = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
        output += BASE64_ALPHABET[(chunk >> 18) & 63];
        output += BASE64_ALPHABET[(chunk >> 12) & 63];
        output += BASE64_ALPHABET[(chunk >> 6) & 63];
        output += BASE64_ALPHABET[chunk & 63];
    }
    const remaining = bytes.length - i;
    if (remaining === 1) {
        const chunk = bytes[i] << 16;
        output += BASE64_ALPHABET[(chunk >> 18) & 63] + BASE64_ALPHABET[(chunk >> 12) & 63] + "==";
    } else if (remaining === 2) {
        const chunk = (bytes[i] << 16) | (bytes[i + 1] << 8);
        output += BASE64_ALPHABET[(chunk >> 18) & 63];
        output += BASE64_ALPHABET[(chunk >> 12) & 63];
        output += BASE64_ALPHABET[(chunk >> 6) & 63] + "=";
    }
    return output;
}

export function decodeBase64(text) {
    const clean = text.replace(/[^A-Za-z0-9+/]/g, "");
    const bytes = new Uint8Array(Math.floor((clean.length * 3) / 4));
    let byteIndex = 0;
    for (let i = 0; i < clean.length; i += 4) {
        const a = BASE64_ALPHABET.indexOf(clean[i]);
        const b = BASE64_ALPHABET.indexOf(clean[i + 1]);
        const c = BASE64_ALPHABET.indexOf(clean[i + 2]);
        const d = BASE64_ALPHABET.indexOf(clean[i + 3]);
        const chunk = (a << 18) | (b << 12) | ((c & 63) << 6) | (d & 63);
        bytes[byteIndex++] = (chunk >> 16) & 0xff;
        if (c >= 0 && byteIndex < bytes.length) bytes[byteIndex++] = (chunk >> 8) & 0xff;
        if (d >= 0 && byteIndex < bytes.length) bytes[byteIndex++] = chunk & 0xff;
    }
    return bytes;
}

export function toHex(bytes) {
    let output = "";
    for (const byte of bytes) {
        output += byte.toString(16).padStart(2, "0");
    }
    return output;
}
