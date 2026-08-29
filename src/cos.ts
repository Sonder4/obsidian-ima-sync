import { requestUrl } from "obsidian";
import type { CosCredential } from "./types";

// 腾讯云 COS PUT Object 签名（移植自 ima-skill knowledge-base/scripts/cos-upload.cjs）
// 参考：https://cloud.tencent.com/document/product/436/7778

function hmacSha1(key: string, data: string): string {
	return hmacSha1Hex(key, data);
}

function sha1Hex(data: string): string {
	return sha1OfUtf8(data);
}

// ---- 纯 JS SHA-1 / HMAC-SHA1 实现（无 Node 依赖，兼容移动端） ----

function rotl(n: number, b: number): number {
	return ((n << b) | (n >>> (32 - b))) >>> 0;
}

function utf8Bytes(str: string): Uint8Array {
	return new TextEncoder().encode(str);
}

function sha1OfUtf8(input: string): string {
	return sha1OfBytes(utf8Bytes(input));
}

function hmacSha1Hex(keyStr: string, dataStr: string): string {
	let key = utf8Bytes(keyStr);
	if (key.length > 64) key = hexToBytes(sha1OfUtf8(keyStr));
	const block = new Uint8Array(64);
	block.set(key);

	const ipad = new Uint8Array(block.length + utf8Bytes(dataStr).length);
	const opad = new Uint8Array(block.length + 20);
	for (let i = 0; i < 64; i++) {
		ipad[i] = block[i] ^ 0x36;
		opad[i] = block[i] ^ 0x5c;
	}
	ipad.set(utf8Bytes(dataStr), 64);

	// 内层 hash 需要作用于 ipad 全部字节（二进制），先实现字节级 SHA-1
	const inner = sha1OfBytes(ipad);
	opad.set(hexToBytes(inner), 64);
	return sha1OfBytes(opad);
}

function hexToBytes(hex: string): Uint8Array {
	const out = new Uint8Array(hex.length / 2);
	for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	return out;
}

function sha1OfBytes(msg: Uint8Array): string {
	const ml = msg.length;
	const withPad = new Uint8Array((((ml + 8) >> 6) + 1) * 64);
	withPad.set(msg);
	withPad[ml] = 0x80;
	const bitLen = ml * 8;
	const dv = new DataView(withPad.buffer);
	dv.setUint32(withPad.length - 4, bitLen >>> 0);
	dv.setUint32(withPad.length - 8, Math.floor(bitLen / 0x100000000));

	let h0 = 0x67452301,
		h1 = 0xefcdab89,
		h2 = 0x98badcfe,
		h3 = 0x10325476,
		h4 = 0xc3d2e1f0;
	const w = new Uint32Array(80);

	for (let i = 0; i < withPad.length; i += 64) {
		for (let j = 0; j < 16; j++) w[j] = dv.getUint32(i + j * 4);
		for (let j = 16; j < 80; j++) w[j] = rotl(w[j - 3] ^ w[j - 8] ^ w[j - 14] ^ w[j - 16], 1);

		let a = h0,
			b = h1,
			c = h2,
			d = h3,
			e = h4;
		for (let j = 0; j < 80; j++) {
			let f: number, k: number;
			if (j < 20) {
				f = (b & c) | (~b & d);
				k = 0x5a827999;
			} else if (j < 40) {
				f = b ^ c ^ d;
				k = 0x6ed9eba1;
			} else if (j < 60) {
				f = (b & c) | (b & d) | (c & d);
				k = 0x8f1bbcdc;
			} else {
				f = b ^ c ^ d;
				k = 0xca62c1d6;
			}
			const t = (rotl(a, 5) + f + e + k + w[j]) >>> 0;
			e = d;
			d = c;
			c = rotl(b, 30);
			b = a;
			a = t;
		}
		h0 = (h0 + a) >>> 0;
		h1 = (h1 + b) >>> 0;
		h2 = (h2 + c) >>> 0;
		h3 = (h3 + d) >>> 0;
		h4 = (h4 + e) >>> 0;
	}
	return [h0, h1, h2, h3, h4].map((x) => x.toString(16).padStart(8, "0")).join("");
}

export function buildCosAuthorization(params: {
	secretId: string;
	secretKey: string;
	pathname: string;
	host: string;
	contentLength: number;
	startTime: number;
	expiredTime: number;
}): string {
	const { secretId, secretKey, pathname, host, contentLength, startTime, expiredTime } = params;
	const keyTime = `${startTime};${expiredTime}`;

	const signKey = hmacSha1(secretKey, keyTime);
	// 签名的头：host 与 content-length（与 cos-upload.cjs 一致）
	const headers: Record<string, string> = {
		host,
		"content-length": String(contentLength),
	};
	const headerKeys = Object.keys(headers).sort();
	const httpHeaders = headerKeys.map((k) => `${k}=${encodeURIComponent(headers[k])}`).join("&");
	const httpString = `put\n${pathname}\n\n${httpHeaders}\n`;
	const stringToSign = `sha1\n${keyTime}\n${sha1Hex(httpString)}\n`;
	const signature = hmacSha1(signKey, stringToSign);
	const headerList = headerKeys.join(";");
	return [
		"q-sign-algorithm=sha1",
		`q-ak=${secretId}`,
		`q-sign-time=${keyTime}`,
		`q-key-time=${keyTime}`,
		`q-header-list=${headerList}`,
		"q-url-param-list=",
		`q-signature=${signature}`,
	].join("&");
}

/** 上传文件内容到 COS（create_media 返回的临时凭证） */
export async function uploadToCos(
	content: ArrayBuffer | Uint8Array,
	cred: CosCredential,
	contentType: string,
): Promise<void> {
	const bytes = content instanceof Uint8Array ? content : new Uint8Array(content);
	const host = `${cred.bucket_name}.cos.${cred.region}.myqcloud.com`;
	const pathname = `/${cred.cos_key}`;
	const startTime = cred.start_time || Math.floor(Date.now() / 1000);
	const expiredTime = cred.expired_time || startTime + 3600;

	const authorization = buildCosAuthorization({
		secretId: cred.secret_id,
		secretKey: cred.secret_key,
		pathname,
		host,
		contentLength: bytes.byteLength,
		startTime,
		expiredTime,
	});

	const res = await requestUrl({
		url: `https://${host}${pathname}`,
		method: "PUT",
		headers: {
			"Content-Type": contentType,
			Authorization: authorization,
			"x-cos-security-token": cred.token,
		},
		body: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
		throw: false,
	});
	if (res.status < 200 || res.status >= 300) {
		throw new Error(`COS 上传失败（HTTP ${res.status}）：${res.text.slice(0, 200)}`);
	}
}

/** 计算内容哈希（上行变更检测用），返回 sha1 hex */
export function contentHash(text: string): string {
	return sha1OfUtf8(text);
}
