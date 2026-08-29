var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/cos.ts
var cos_exports = {};
__export(cos_exports, {
  buildCosAuthorization: () => buildCosAuthorization,
  contentHash: () => contentHash,
  uploadToCos: () => uploadToCos
});
module.exports = __toCommonJS(cos_exports);

// test/obsidian-stub.js
var requestUrl = () => {
};

// src/cos.ts
function hmacSha1(key, data) {
  return hmacSha1Hex(key, data);
}
function sha1Hex(data) {
  return sha1OfUtf8(data);
}
function rotl(n, b) {
  return (n << b | n >>> 32 - b) >>> 0;
}
function utf8Bytes(str) {
  return new TextEncoder().encode(str);
}
function sha1OfUtf8(input) {
  return sha1OfBytes(utf8Bytes(input));
}
function hmacSha1Hex(keyStr, dataStr) {
  let key = utf8Bytes(keyStr);
  if (key.length > 64) key = hexToBytes(sha1OfUtf8(keyStr));
  const block = new Uint8Array(64);
  block.set(key);
  const ipad = new Uint8Array(block.length + utf8Bytes(dataStr).length);
  const opad = new Uint8Array(block.length + 20);
  for (let i = 0; i < 64; i++) {
    ipad[i] = block[i] ^ 54;
    opad[i] = block[i] ^ 92;
  }
  ipad.set(utf8Bytes(dataStr), 64);
  const inner = sha1OfBytes(ipad);
  opad.set(hexToBytes(inner), 64);
  return sha1OfBytes(opad);
}
function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
function sha1OfBytes(msg) {
  const ml = msg.length;
  const withPad = new Uint8Array(((ml + 8 >> 6) + 1) * 64);
  withPad.set(msg);
  withPad[ml] = 128;
  const bitLen = ml * 8;
  const dv = new DataView(withPad.buffer);
  dv.setUint32(withPad.length - 4, bitLen >>> 0);
  dv.setUint32(withPad.length - 8, Math.floor(bitLen / 4294967296));
  let h0 = 1732584193, h1 = 4023233417, h2 = 2562383102, h3 = 271733878, h4 = 3285377520;
  const w = new Uint32Array(80);
  for (let i = 0; i < withPad.length; i += 64) {
    for (let j = 0; j < 16; j++) w[j] = dv.getUint32(i + j * 4);
    for (let j = 16; j < 80; j++) w[j] = rotl(w[j - 3] ^ w[j - 8] ^ w[j - 14] ^ w[j - 16], 1);
    let a = h0, b = h1, c = h2, d = h3, e = h4;
    for (let j = 0; j < 80; j++) {
      let f, k;
      if (j < 20) {
        f = b & c | ~b & d;
        k = 1518500249;
      } else if (j < 40) {
        f = b ^ c ^ d;
        k = 1859775393;
      } else if (j < 60) {
        f = b & c | b & d | c & d;
        k = 2400959708;
      } else {
        f = b ^ c ^ d;
        k = 3395469782;
      }
      const t = rotl(a, 5) + f + e + k + w[j] >>> 0;
      e = d;
      d = c;
      c = rotl(b, 30);
      b = a;
      a = t;
    }
    h0 = h0 + a >>> 0;
    h1 = h1 + b >>> 0;
    h2 = h2 + c >>> 0;
    h3 = h3 + d >>> 0;
    h4 = h4 + e >>> 0;
  }
  return [h0, h1, h2, h3, h4].map((x) => x.toString(16).padStart(8, "0")).join("");
}
function buildCosAuthorization(params) {
  const { secretId, secretKey, pathname, host, contentLength, startTime, expiredTime } = params;
  const keyTime = `${startTime};${expiredTime}`;
  const signKey = hmacSha1(secretKey, keyTime);
  const headers = {
    host,
    "content-length": String(contentLength)
  };
  const headerKeys = Object.keys(headers).sort();
  const httpHeaders = headerKeys.map((k) => `${k}=${encodeURIComponent(headers[k])}`).join("&");
  const httpString = `put
${pathname}

${httpHeaders}
`;
  const stringToSign = `sha1
${keyTime}
${sha1Hex(httpString)}
`;
  const signature = hmacSha1(signKey, stringToSign);
  const headerList = headerKeys.join(";");
  return [
    "q-sign-algorithm=sha1",
    `q-ak=${secretId}`,
    `q-sign-time=${keyTime}`,
    `q-key-time=${keyTime}`,
    `q-header-list=${headerList}`,
    "q-url-param-list=",
    `q-signature=${signature}`
  ].join("&");
}
async function uploadToCos(content, cred, contentType) {
  const bytes = content instanceof Uint8Array ? content : new Uint8Array(content);
  const host = `${cred.bucket_name}.cos.${cred.region}.myqcloud.com`;
  const pathname = `/${cred.cos_key}`;
  const startTime = cred.start_time || Math.floor(Date.now() / 1e3);
  const expiredTime = cred.expired_time || startTime + 3600;
  const authorization = buildCosAuthorization({
    secretId: cred.secret_id,
    secretKey: cred.secret_key,
    pathname,
    host,
    contentLength: bytes.byteLength,
    startTime,
    expiredTime
  });
  const res = await requestUrl({
    url: `https://${host}${pathname}`,
    method: "PUT",
    headers: {
      "Content-Type": contentType,
      Authorization: authorization,
      "x-cos-security-token": cred.token
    },
    body: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    throw: false
  });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`COS \u4E0A\u4F20\u5931\u8D25\uFF08HTTP ${res.status}\uFF09\uFF1A${res.text.slice(0, 200)}`);
  }
}
function contentHash(text) {
  return sha1OfUtf8(text);
}
