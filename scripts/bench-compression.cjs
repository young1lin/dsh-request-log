const zlib = require('node:zlib');
const { createHash } = require('node:crypto');

function msg(role, text) {
  return { id: 'm-' + Math.random().toString(36).slice(2, 8), role,
           content: [{ type: 'text', text }], sourceKind: role === 'user' ? 'user' : 'model' };
}
const base = [];
for (let i = 0; i < 24; i++) base.push(msg(i % 3 === 0 ? 'user' : 'assistant', ('turn-' + i + ': ').padEnd(400, 'lorem ipsum dolor sit amet consectetur adipiscing elit ')));
const TOOLS = Array.from({ length: 14 }, (_, i) => ({ name: 'tool_' + i, description: 'A fairly verbose tool description padded with enough words to matter for size measurements.'.repeat(4), parameters: { type: 'object', properties: { path: { type: 'string' }, limit: { type: 'number' } } } }));

const records = [];
for (let n = 0; n < 3; n++) {
  if (n > 0) {
    base.push(msg('assistant', ('assistant reply ').concat(n).padEnd(600, 'the model reasoned carefully about the repository layout and proposed edits ')));
    base.push(msg('user', ('next user turn ').concat(n).padEnd(500, 'here is some new context about the failing test and stack trace lines ')));
  }
  const system = 'You are DeepSeek, a coding agent. '.repeat(40);
  const request = { system, messages: base.slice(), tools: TOOLS };
  const response = {
    blocks: [
      { type: 'text', text: 'Final answer block content '.repeat(30) },
      { type: 'tool-call', id: 'c' + n, name: 'run_code', arguments: JSON.stringify({ code: 'const x = await tools.read({});'.repeat(20), description: 'd' }) },
    ],
    usage: { inputTokens: 90000 + n * 3000, outputTokens: 700 },
    finish: { kind: 'tool-calls' }, chunkCount: 220,
  };
  records.push({ schema: 1, id: 'uuid-' + n, sessionId: 'sess', provider: 'deepseek', model: 'glm-5',
                 requestHash: 'abc' + n, attempt: 1, timing: { startedAt: 1e12 + n }, request, response, status: 'ok' });
}

const lineOf = r => JSON.stringify(r);
const sizes = records.map(r => Buffer.byteLength(lineOf(r)));
console.log('record bytes:', sizes.join(', '), '| sum =', sizes.reduce((a, b) => a + b));

for (const [label, fn] of [
  ['gzip6 ', b => zlib.gzipSync(b, { level: 6 })],
  ['gzip3 ', b => zlib.gzipSync(b, { level: 3 })],
  ['rawdef', b => zlib.deflateRawSync(b, { level: 6 })],
  ['br-q4 ', b => zlib.brotliCompressSync(b, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 } })],
  ['br-q6 ', b => zlib.brotliCompressSync(b, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 6 } })],
]) {
  const tot = records.reduce((a, r) => a + fn(Buffer.from(lineOf(r))).length, 0);
  console.log(label, 'independent-per-record total:', tot);
}
const all = Buffer.from(records.map(lineOf).join('\n'));
console.log('file-mode gzip6 across all lines:', zlib.gzipSync(all, { level: 6 }).length);
console.log('file-mode br-q6 across all lines:', zlib.brotliCompressSync(all, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 6 } }).length);

// Dictionary probes
const dictFull = Buffer.from(JSON.stringify({ tools: TOOLS, system: records[0].request.system }));
console.log('dict bytes:', dictFull.length);
const dict = dictFull.subarray(0, Math.min(dictFull.length, 16384));
try {
  const big = Buffer.from(JSON.stringify(base.slice(-1)[0]));
  const withDict = zlib.deflateRawSync(big, { dictionary: dict });
  const noDict = zlib.deflateRawSync(big);
  const ok = zlib.inflateRawSync(withDict, { dictionary: dict }).toString() === big.toString();
  console.log('msg-only raw deflate w/ dict:', withDict.length, 'vs w/o:', noDict.length, '| roundtrip equal:', ok);
} catch (e) { console.log('dict probe FAILED:', e.message); }
try { zlib.deflateSync(Buffer.from('x'), { dictionary: dict }); console.log('zlib-wrapped accepts dictionary option'); }
catch (e) { console.log('zlib-wrapped rejects dictionary:', e.message.slice(0, 80)); }

// Chunk hashes: sha256 over canonicalized single message (~size of one message)
const canon = JSON.stringify(base[base.length - 1]);
const t0 = process.hrtime.bigint();
for (let i = 0; i < 100; i++) createHash('sha256').update(canon).digest();
const dt = Number(process.hrtime.bigint() - t0) / 1e6;
console.log('sha256 x100 of', canon.length, '-byte message:', dt.toFixed(2), 'ms');

// Compression timing at q-levels for one ~40KB blob
const blob = Buffer.from(lineOf(records[2]));
for (const [label, fn] of [
  ['deflateRaw L6', () => zlib.deflateRawSync(blob, { level: 6 })],
  ['br q4', () => zlib.brotliCompressSync(blob, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 } })],
  ['br q6', () => zlib.brotliCompressSync(blob, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 6 } })],
]) {
  const t1 = process.hrtime.bigint();
  const out = fn();
  console.log(label, ':', blob.length, '->', out.length, 'bytes in', Number(process.hrtime.bigint() - t1) / 1e6, 'ms');
}
