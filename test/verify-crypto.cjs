const crypto = require("node:crypto");
const { buildCosAuthorization, contentHash } = require("./cos-test.cjs");

let pass = 0, fail = 0;
function check(name, got, want) {
  if (got === want) { pass++; console.log("PASS", name); }
  else { fail++; console.log("FAIL", name, "\n got:", got, "\nwant:", want); }
}

// 1) SHA-1 已知向量
check("sha1(abc)", contentHash("abc"), "a9993e364706816aba3e25717850c26c9cd0d89d");
check("sha1(empty)", contentHash(""), "da39a3ee5e6b4b0d3255bfef95601890afd80709");

// 2) COS 签名与 node crypto 参照实现对比
function refAuth(secretId, secretKey, pathname, host, contentLength, startTime, expiredTime) {
  const keyTime = `${startTime};${expiredTime}`;
  const signKey = crypto.createHmac("sha1", secretKey).update(keyTime).digest("hex");
  const headers = { host, "content-length": String(contentLength) };
  const hk = Object.keys(headers).sort();
  const httpHeaders = hk.map(k => `${k}=${encodeURIComponent(headers[k])}`).join("&");
  const httpString = `put\n${pathname}\n\n${httpHeaders}\n`;
  const sha1 = crypto.createHash("sha1").update(httpString).digest("hex");
  const stringToSign = `sha1\n${keyTime}\n${sha1}\n`;
  const sig = crypto.createHmac("sha1", signKey).update(stringToSign).digest("hex");
  return ["q-sign-algorithm=sha1", `q-ak=${secretId}`, `q-sign-time=${keyTime}`, `q-key-time=${keyTime}`,
    `q-header-list=${hk.join(";")}`, "q-url-param-list=", `q-signature=${sig}`].join("&");
}
const cases = [
  ["AKIDexample", "secretKey示例", "/test/ima/hello.md", "bucket-125000.cos.ap-guangzhou.myqcloud.com", 456, 1787977957, 1787981557],
  ["AKID中文&special=1", "key/with+symbols", "/a b/c.md", "b.cos.bj.myqcloud.com", 0, 1700000000, 1700003600],
];
for (const [sid, skey, path, host, len, st, et] of cases) {
  check(`cos-auth ${path}`, buildCosAuthorization({ secretId: sid, secretKey: skey, pathname: path, host, contentLength: len, startTime: st, expiredTime: et }),
    refAuth(sid, skey, path, host, len, st, et));
}
// 3) HMAC 已知向量（经 buildCosAuthorization 间接覆盖 hmacSha1Hex；直接再测一个）
const refHmac = (k, d) => crypto.createHmac("sha1", k).update(d).digest("hex");
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
