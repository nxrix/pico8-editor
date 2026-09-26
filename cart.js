/*
PICO-8 cartridge library

a cart is a plain object:

  {
    version : number            p8 format version (43 = 0.2.7)
    code    : string            lua source, one char per pico-8 glyph (byte 141 = ♪,
                                154-253 = katakana, 142 = 🅾️); what you see is
                                what pico-8 shows
    gfx     : Uint8Array 8192   spritesheet 4bpp, byte(x,y) = gfx[y*64 + (x>>1)],
                                even x = low nibble, odd x = high nibble.
                                sheet rows 64-127 double as map rows 32-63
    map     : Uint8Array 4096   map rows 0-31, tile(x,y) = map[y*128 + x]
    gff     : Uint8Array 256    sprite flags
    music   : Uint8Array 256    64 songs x 4 channel bytes, 0x40|ch = silence,
                                bit 7 = loop flag
    sfx     : Uint8Array 4352   64 sfx x 68 bytes: 32 notes x 2 bytes then
                                4 info bytes (editor mode, speed, loop start, loop end)
    label   : Uint8Array 16384  label image 128x128 palette indices (0-15),
                                pixel(x,y) = label[y*128 + x], all zeros = no label
    custom  : Uint8Array|null   16384 8bpp gfx colors 16-255 per pixel, only used by
                                the .p8 text format, null = none
    meta    : Uint8Array 5      png trailer bytes 0x8001-0x8005, copy through
  }

api:

  newCart(code = "")               -> cart                 empty cart with pico-8 defaults
  decodeP8(text | bytes)           -> cart                 parse .p8 text. bytes are the file
                                                            itself (utf-8, how pico-8 saves
                                                            glyph chars, or latin-1); a string
                                                            is one char per byte
  encodeP8(cart)                   -> string               write .p8 text, one char per byte.
                                                            file i/o is up to the caller:
                                                            browser: new Blob([Uint8Array.from(s,
                                                            c => c.charCodeAt(0))])
                                                            node:    Buffer.from(s, "latin1")
  decodePng(bytes)                 -> Promise<cart>        parse .p8.png file bytes
  encodePng(cart)                  -> Uint8Array           write .p8.png file bytes, injectable
                                                            into the pico-8 player. the label is
                                                            drawn at (16,24) 128x128 (an all-zero
                                                            label shows the gray placeholder) and
                                                            the title under it is the first two
                                                            code lines matching "-- ..." — the
                                                            same rules pico-8 itself uses
  sget(cart,x,y) -> 0-15   sset(cart,x,y,c)                spritesheet pixels 128x128
  mget(cart,x,y) -> 0-255  mset(cart,x,y,v)                map tiles 128x64 (y < 32 is cart.map,
                                                            y >= 32 reads the shared half of gfx)
  fget(cart,n) -> 0-255    fset(cart,n,v)                  sprite flags
  sfxNote(sfx, i, n)               -> {pitch, waveform, volume, effect}
  setSfxNote(sfx, i, n, props)                             props default to 0, waveform is 0-15
  PAL                              16 [r,g,b] colors
  nearest(r, g, b) -> 0-15         closest palette index
  FONT                             pico-8 glyph bitmaps by char code: hex string,
                                   bits = bit(y*w + x), w = 4 (6 hex digits) or
                                   8 (12 hex digits), chars 16-255 — enough to draw
                                   pico-8 text anywhere (titles, label text tools)

sfx note bytes: byte0 = pitch 6b | waveform low 2b, byte1 = waveform bit3 | volume 3b |
effect 3b | waveform bit2. there is no save/load here: the api returns bytes and strings,
making files from them is the caller's job.
*/

const PAL = [
  [0, 0, 0],
  [29, 43, 83],
  [126, 37, 83],
  [0, 135, 81],
  [171, 82, 54],
  [95, 87, 79],
  [194, 195, 199],
  [255, 241, 232],
  [255, 0, 77],
  [255, 163, 0],
  [255, 236, 39],
  [0, 228, 54],
  [41, 173, 255],
  [131, 118, 156],
  [255, 119, 168],
  [255, 204, 170],
];

function nearest(r, g, b) {
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < 16; i++) {
    const dr = PAL[i][0] - r;
    const dg = PAL[i][1] - g;
    const db = PAL[i][2] - b;
    const d = dr * dr + dg * dg + db * db;
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return best;
}

const KANA =
  "あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろわをんっゃゅょアイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲンッャュョ";
const P8SCII = {
  0: "\0",
  1: "¹",
  2: "²",
  3: "³",
  4: "⁴",
  5: "⁵",
  6: "⁶",
  7: "⁷",
  8: "⁸",
  9: "\t",
  10: "\n",
  11: "ᵇ",
  12: "ᶜ",
  13: "\r",
  14: "ᵉ",
  15: "ᶠ",
  16: "▮",
  17: "■",
  18: "□",
  19: "⁙",
  20: "⁘",
  21: "‖",
  22: "◀",
  23: "▶",
  24: "「",
  25: "」",
  26: "¥",
  27: "•",
  28: "、",
  29: "。",
  30: "゛",
  31: "゜",
  127: "○",
  128: "█",
  129: "▒",
  130: "🐱",
  131: "⬇️",
  132: "░",
  133: "✽",
  134: "●",
  135: "♥",
  136: "☉",
  137: "웃",
  138: "⌂",
  139: "⬅️",
  140: "😐",
  141: "♪",
  142: "🅾️",
  143: "◆",
  144: "…",
  145: "➡️",
  146: "★",
  147: "⧗",
  148: "⬆️",
  149: "ˇ",
  150: "∧",
  151: "❎",
  152: "▤",
  153: "▥",
  254: "◜",
  255: "◝",
};
for (let i = 0; i < KANA.length; i++) P8SCII[154 + i] = KANA[i];
const UNI_TO_P8SCII = new Map(
  Object.entries(P8SCII).map(function (e) {
    return [e[1], +e[0]];
  }),
);
for (let i = 0; i < 26; i++) UNI_TO_P8SCII.set(String.fromCodePoint(0x1d622 + i), 65 + i);

function bytesToStr(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += P8SCII[bytes[i]] ?? String.fromCharCode(bytes[i]);
  return s;
}

function strToBytes(s) {
  const out = new Uint8Array(s.length * 2);
  let n = 0;
  let i = 0;
  while (i < s.length) {
    let hit = false;
    for (let l = 3; l >= 1 && !hit; l--) {
      if (i + l <= s.length && UNI_TO_P8SCII.has(s.slice(i, i + l))) {
        out[n++] = UNI_TO_P8SCII.get(s.slice(i, i + l));
        i += l;
        hit = true;
      }
    }
    if (hit) continue;
    const c = s.charCodeAt(i);
    out[n++] = c < 256 ? c : 63;
    i++;
  }
  return out.subarray(0, n);
}

function p8DecodeText(bytes) {
  let s = "";
  let i = 0;
  while (i < bytes.length) {
    const b = bytes[i];
    const n = b >= 0xf0 && b <= 0xf4 ? 4 : b >= 0xe0 && b <= 0xef ? 3 : b >= 0xc2 && b <= 0xdf ? 2 : 0;
    let ok = n > 0 && i + n <= bytes.length;
    for (let k = 1; ok && k < n; k++) {
      if ((bytes[i + k] & 0xc0) !== 0x80) ok = false;
    }
    if (ok && n === 3) {
      ok = b === 0xe0 ? bytes[i + 1] >= 0xa0 : b === 0xed ? bytes[i + 1] <= 0x9f : true;
    }
    if (ok && n === 4) {
      ok = b === 0xf0 ? bytes[i + 1] >= 0x90 : b === 0xf4 ? bytes[i + 1] <= 0x8f : true;
    }
    if (b < 0x80) {
      s += String.fromCharCode(b);
      i++;
      continue;
    }
    if (!ok) {
      s += String.fromCharCode(0xdc00 + b);
      i++;
      continue;
    }
    let cp = b & (0xff >> n);
    for (let k = 1; k < n; k++) cp = (cp << 6) | (bytes[i + k] & 0x3f);
    s += String.fromCodePoint(cp);
    i += n;
  }
  return s;
}

function glyphBytes(s) {
  const out = [];
  let i = 0;
  while (i < s.length) {
    const c = s.codePointAt(i);
    if (c < 0x100) {
      out.push(c);
      i++;
      continue;
    }
    let hit = false;
    for (let l = 3; l >= 1 && !hit; l--) {
      if (i + l <= s.length && UNI_TO_P8SCII.has(s.slice(i, i + l))) {
        out.push(UNI_TO_P8SCII.get(s.slice(i, i + l)));
        i += l;
        hit = true;
      }
    }
    if (hit) continue;
    if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    i += c < 0x10000 ? 1 : 2;
  }
  return out;
}

function p8StrBytes(s) {
  const out = [];
  let i = 0;
  while (i < s.length) {
    const c = s.codePointAt(i);
    if (c >= 0xdc80 && c <= 0xdcff) {
      out.push(c - 0xdc00);
      i++;
      continue;
    }
    let hit = false;
    for (let l = 3; l >= 1 && !hit; l--) {
      if (i + l <= s.length && UNI_TO_P8SCII.has(s.slice(i, i + l))) {
        out.push(UNI_TO_P8SCII.get(s.slice(i, i + l)));
        i += l;
        hit = true;
      }
    }
    if (hit) continue;
    if (c < 0x80) {
      out.push(c);
      i++;
    } else {
      if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      i += c < 0x10000 ? 1 : 2;
    }
  }
  return out;
}

function sha1(bytes) {
  const ml = bytes.length;
  const padded = new Uint8Array((((ml + 8) >> 6) + 1) << 6);
  padded.set(bytes);
  padded[ml] = 0x80;
  const dv = new DataView(padded.buffer);
  dv.setUint32(padded.length - 4, ml << 3, false);
  let h0 = 0x67452301,
    h1 = 0xefcdab89,
    h2 = 0x98badcfe,
    h3 = 0x10325476,
    h4 = 0xc3d2e1f0;
  const w = new Int32Array(80);
  function rol(v, n) {
    return (v << n) | (v >>> (32 - n)) | 0;
  }
  for (let block = 0; block < padded.length; block += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getInt32(block + i * 4, false);
    for (let i = 16; i < 80; i++) w[i] = rol(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
    let a = h0,
      b = h1,
      c = h2,
      d = h3,
      e = h4;
    for (let i = 0; i < 80; i++) {
      let f, k;
      if (i < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (i < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (i < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }
      const temp = (rol(a, 5) + f + e + k + w[i]) | 0;
      e = d;
      d = c;
      c = rol(b, 30);
      b = a;
      a = temp;
    }
    h0 = (h0 + a) | 0;
    h1 = (h1 + b) | 0;
    h2 = (h2 + c) | 0;
    h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0;
  }
  const out = new Uint8Array(20);
  const odv = new DataView(out.buffer);
  [h0, h1, h2, h3, h4].forEach(function (h, i) {
    odv.setUint32(i * 4, h >>> 0, false);
  });
  return out;
}

const CRC_TABLE = (function () {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function adler32(buf) {
  let a = 1,
    b = 0;
  for (let i = 0; i < buf.length; i++) {
    a = (a + buf[i]) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

function pngChunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

function pngWrite(pixels, w, h) {
  const stride = w * 4 + 1;
  const raw = new Uint8Array(stride * h);
  for (let y = 0; y < h; y++) {
    raw[y * stride] = 0;
    raw.set(pixels.subarray(y * w * 4, (y + 1) * w * 4), y * stride + 1);
  }
  const nBlocks = Math.ceil(raw.length / 65535) || 1;
  const z = new Uint8Array(2 + raw.length + nBlocks * 5 + 4);
  z[0] = 0x78;
  z[1] = 0x01;
  let p = 2;
  let off = 0;
  for (let b = 0; b < nBlocks; b++) {
    const len = Math.min(65535, raw.length - off);
    z[p] = b === nBlocks - 1 ? 1 : 0;
    z[p + 1] = len & 255;
    z[p + 2] = len >> 8;
    z[p + 3] = ~len & 255;
    z[p + 4] = (~len >> 8) & 255;
    z.set(raw.subarray(off, off + len), p + 5);
    p += 5 + len;
    off += len;
  }
  const ad = adler32(raw);
  z[p] = (ad >>> 24) & 255;
  z[p + 1] = (ad >>> 16) & 255;
  z[p + 2] = (ad >>> 8) & 255;
  z[p + 3] = ad & 255;
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w);
  dv.setUint32(4, h);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const parts = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", z.subarray(0, p + 4)),
    pngChunk("IEND", new Uint8Array(0)),
  ];
  const out = new Uint8Array(
    parts.reduce(function (n, part) {
      return n + part.length;
    }, 0),
  );
  let o = 0;
  for (const part of parts) {
    out.set(part, o);
    o += part.length;
  }
  return out;
}

async function pngRead(bytes) {
  bytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (bytes[0] !== 0x89 || bytes[1] !== 0x50) throw new Error("not a png file");
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 8;
  let w = 0,
    h = 0,
    bitDepth = 8,
    colorType = 6,
    interlace = 0;
  let plte = null,
    trns = null;
  const idat = [];
  while (pos + 8 <= bytes.length) {
    const len = dv.getUint32(pos);
    const type = String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]);
    const data = bytes.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      const hd = new DataView(data.buffer, data.byteOffset, data.byteLength);
      w = hd.getUint32(0);
      h = hd.getUint32(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === "PLTE") plte = data.slice();
    else if (type === "tRNS") trns = data.slice();
    else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    pos += 12 + len;
  }
  if (!w || !h) throw new Error("bad png header");
  if (bitDepth !== 8) throw new Error(`unsupported bit depth ${bitDepth}`);
  if (interlace) throw new Error("interlaced png not supported");
  const bpp = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!bpp) throw new Error(`unsupported color type ${colorType}`);
  const z = new Uint8Array(
    idat.reduce(function (n, c) {
      return n + c.length;
    }, 0),
  );
  let o = 0;
  for (const c of idat) {
    z.set(c, o);
    o += c.length;
  }
  if (typeof DecompressionStream !== "function") {
    throw new Error("DecompressionStream is not available — a browser or Node >= 18 is required");
  }
  const raw = new Uint8Array(
    await new Response(new Blob([z]).stream().pipeThrough(new DecompressionStream("deflate"))).arrayBuffer(),
  );
  const stride = w * bpp;
  if (raw.length < (stride + 1) * h) throw new Error("png data too short");
  const out = new Uint8Array(w * h * 4);
  let prev = new Uint8Array(stride);
  function paeth(a, b, c) {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  }
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const cur = new Uint8Array(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      let v = line[x];
      if (f === 1) v = (v + a) & 255;
      else if (f === 2) v = (v + b) & 255;
      else if (f === 3) v = (v + ((a + b) >> 1)) & 255;
      else if (f === 4) v = (v + paeth(a, b, c)) & 255;
      cur[x] = v;
    }
    for (let x = 0; x < w; x++) {
      const dst = (y * w + x) * 4;
      const s = x * bpp;
      if (colorType === 6) {
        out[dst] = cur[s];
        out[dst + 1] = cur[s + 1];
        out[dst + 2] = cur[s + 2];
        out[dst + 3] = cur[s + 3];
      } else if (colorType === 2) {
        out[dst] = cur[s];
        out[dst + 1] = cur[s + 1];
        out[dst + 2] = cur[s + 2];
        out[dst + 3] = 255;
      } else if (colorType === 0) {
        out[dst] = out[dst + 1] = out[dst + 2] = cur[s];
        out[dst + 3] = 255;
      } else if (colorType === 4) {
        out[dst] = out[dst + 1] = out[dst + 2] = cur[s];
        out[dst + 3] = cur[s + 1];
      } else {
        const idx = cur[s];
        out[dst] = plte ? plte[idx * 3] : 0;
        out[dst + 1] = plte ? plte[idx * 3 + 1] : 0;
        out[dst + 2] = plte ? plte[idx * 3 + 2] : 0;
        out[dst + 3] = trns && idx < trns.length ? trns[idx] : 255;
      }
    }
    prev = cur;
  }
  return { w, h, pixels: out };
}
const CODE_SIZE = 0x3d00;
const MIN_C = 3;
const HEADER_PXA = [0x00, 0x70, 0x78, 0x61];
const HEADER_LEGACY = [0x3a, 0x63, 0x3a, 0x00];
const LEGACY_TABLE = "#\n 0123456789abcdefghijklmnopqrstuvwxyz!#%(){}[]<>+=/*:;.,~_";
const FUTURE1 = "if(_update60)_update=function()_update60()_update60()end";
const FUTURE2 = "if(_update60)_update=function()_update60()_update_buttons()_update60()end";

function bitLength(v) {
  return v <= 0 ? 0 : 32 - Math.clz32(v);
}
function roundUp(v, step) {
  return Math.ceil(v / step) * step;
}
function roundDown(v, step) {
  return Math.floor(v / step) * step;
}

function makeBitWriter() {
  const bytes = [];
  let acc = 0;
  let n = 0;
  function bit(b) {
    acc |= (b ? 1 : 0) << n;
    if (++n === 8) {
      bytes.push(acc);
      acc = 0;
      n = 0;
    }
  }
  function bits(count, v) {
    for (let i = 0; i < count; i++) bit((v >>> i) & 1);
  }
  function flush() {
    while (n !== 0) bit(0);
  }
  function toBytes() {
    const out = new Uint8Array(bytes.length + (n ? 1 : 0));
    for (let i = 0; i < bytes.length; i++) out[i] = bytes[i];
    if (n) out[bytes.length] = acc;
    return out;
  }
  return { bit, bits, flush, toBytes };
}

function mtfCost(chI) {
  let mask = 1 << 4;
  let count = 6;
  while (chI >= mask) {
    mask = (mask << 1) | (1 << 4);
    count += 2;
  }
  if (chI >= 16) count -= 1;
  return count;
}

function updateMtf(mtf, idx, ch) {
  for (let ii = idx; ii > 0; ii--) mtf[ii] = mtf[ii - 1];
  mtf[0] = ch;
}

function* getLz77(
  code,
  {
    minC = MIN_C,
    maxC = 0x7fff,
    maxO = 0x7fff,
    measure = null,
    minCost = null,
    getCheaperC = null,
    maxOSteps = null,
    noRepeat = false,
    fastC = null,
    litblockIdxs = null,
  },
) {
  const len = code.length;
  const matches = new Map();
  const litblocks = litblockIdxs ? [...litblockIdxs] : null;
  let nextLitblock = litblocks && litblocks.length ? litblocks.shift() : len;

  function key(i, c) {
    return c === 3
      ? String.fromCharCode(code[i], code[i + 1], code[i + 2])
      : String.fromCharCode.apply(null, code.subarray(i, i + c));
  }

  function matchLength(leftI, rightI, startC) {
    let c = startC;
    const limit = Math.min(len - leftI, len - rightI);
    while (c < limit && code[leftI + c] === code[rightI + c]) c++;
    return c;
  }

  function findMatch(i, depthC = minC, depthMaxO = maxO, dict = matches) {
    const node = dict.get(key(i, depthC));
    if (node && node.sub) {
      let [bestC, bestJ] = findMatch(i, depthC + 1, depthMaxO, node.sub);
      if (!bestC && node.bestJ >= 0) {
        let c = depthC;
        const j = node.bestJ;
        if (maxC != null) c = Math.min(c, maxC);
        if (noRepeat) c = Math.min(c, i - j);
        if (!(depthMaxO != null && j < i - depthMaxO)) {
          bestC = c;
          bestJ = j;
        }
      }
      return [bestC, bestJ];
    }
    const list = node || [];
    let bestC = 0,
      bestJ = -1;
    for (let li = list.length - 1; li >= 0; li--) {
      const j = list[li];
      if (depthMaxO != null && j < i - depthMaxO) break;
      if (bestC > 0) {
        let ok = true;
        for (let t = 0; t < bestC; t++) {
          if (code[i + t] !== code[j + t]) {
            ok = false;
            break;
          }
        }
        if (!ok) continue;
      }
      const c0 = matchLength(i, j, bestC > 0 ? bestC : depthC);
      let c = c0;
      if (maxC != null) c = Math.min(c, maxC);
      if (noRepeat) c = Math.min(c, i - j);
      if ((c > bestC && c >= depthC) || (c === bestC && j > bestJ)) {
        bestC = c;
        bestJ = j;
      }
    }
    return [bestC, bestJ];
  }

  function convertToSubDict(list, minI, c) {
    const sub = new Map();
    let bestJ = -1;
    for (const j of list) {
      if (maxO != null && j < minI - maxO) continue;
      const k = key(j, c);
      let arr = sub.get(k);
      if (!arr) {
        arr = [];
        sub.set(k, arr);
      }
      arr.push(j);
      bestJ = j;
    }
    return { sub, bestJ };
  }

  let advances = [];
  let currAdv = null;

  function addAdvance(cost, ctxt, c, item) {
    const nextI = i + c;
    let insertIdx = null;
    let doReplace = false;
    for (let idx = 0; idx < advances.length; idx++) {
      const adv = advances[idx];
      if (insertIdx == null) {
        if (nextI === adv.nextI) {
          insertIdx = idx;
          doReplace = true;
        } else if (nextI < adv.nextI) insertIdx = idx;
      }
      if (insertIdx != null) {
        let advCost = adv.cost;
        if (minCost) advCost -= minCost(adv.nextI - nextI);
        if (cost >= advCost) return;
      }
    }
    const nextAdv = { i, nextI, cost, ctxt, item, prev: currAdv };
    if (doReplace) advances[insertIdx] = nextAdv;
    else if (insertIdx != null) advances.splice(insertIdx, 0, nextAdv);
    else advances.push(nextAdv);
  }

  function addLz77Advance(j, c) {
    const item = { offset: i - j, count: c };
    const [cost, ctxt] = measure(currAdv ? currAdv.ctxt : null, item);
    addAdvance((currAdv ? currAdv.cost : 0) + cost, ctxt, c, item);
  }

  function* advanceChain(adv) {
    const items = [];
    while (adv) {
      items.push([adv.i, adv.item]);
      adv = adv.prev;
    }
    for (let n = items.length - 1; n >= 0; n--) yield items[n];
  }

  let i = 0;
  let prevI = 0;
  let bestC = 0;

  while (i < len) {
    if (i >= nextLitblock) {
      if (currAdv) {
        yield* advanceChain(currAdv);
        currAdv = null;
        advances = [];
      }
      bestC = Infinity;
      const endLitblock = litblocks && litblocks.length ? litblocks.shift() : len;
      yield [i, code.subarray(i, endLitblock)];
      i = endLitblock;
      nextLitblock = litblocks && litblocks.length ? litblocks.shift() : len;
    } else if (measure) {
      const currCtxt = currAdv ? currAdv.ctxt : null;
      const currCost = currAdv ? currAdv.cost : 0;
      const [chCost, chCtxt] = measure(currCtxt, code[i]);
      addAdvance(currCost + chCost, chCtxt, 1, code[i]);
      const [bC, bJ] = findMatch(i);
      bestC = bC;
      if (bestC > 0) {
        addLz77Advance(bJ, bestC);
        if (getCheaperC) {
          const cheapC = getCheaperC(bestC);
          if (bestC > cheapC && cheapC >= minC) addLz77Advance(bJ, cheapC);
        }
        if (maxOSteps) {
          for (const step of maxOSteps) {
            if (i - bJ <= step) break;
            const [shC, shJ] = findMatch(i, minC, step);
            if (shC > 0) {
              addLz77Advance(shJ, shC);
              if (getCheaperC) {
                const shCheapC = getCheaperC(shC);
                if (shC > shCheapC && shCheapC >= minC) addLz77Advance(shJ, shCheapC);
              }
            }
          }
        }
      }
      currAdv = advances.shift();
      i = currAdv.nextI;
      if (!advances.length) {
        yield* advanceChain(currAdv);
        currAdv = null;
      }
    } else {
      const [bC, bJ] = findMatch(i);
      bestC = bC;
      if (bestC > 0) {
        const [skipC] = findMatch(i + 1);
        if (skipC > bestC) {
          yield [i, code[i]];
          i++;
        } else {
          yield [i, { offset: i - bJ, count: bestC }];
          i += bestC;
        }
      } else {
        yield [i, code[i]];
        i++;
      }
    }

    if (fastC == null || bestC < fastC) {
      for (let j = prevI; j < i; j++) {
        let dict = matches;
        let c = minC;
        let k = key(j, c);
        let node = dict.get(k);
        while (node && node.sub) {
          node.bestJ = j;
          dict = node.sub;
          c++;
          k = key(j, c);
          node = dict.get(k);
        }
        if (!node) {
          node = [];
          dict.set(k, node);
        }
        node.push(j);
        if (node.length > 200 && dict.size > 5 && c < minC * 6) {
          dict.set(k, convertToSubDict(node, i, c + 1));
        }
      }
    }
    prevI = i;
  }
}

function pxaCompress(code) {
  const len = code.length;
  if (len === 0) return null;
  if (len >= 0x10000) throw new Error("cart has too many characters (max 65535)");

  const bw = makeBitWriter();
  const mtf = new Uint8Array(256);
  for (let i = 0; i < 256; i++) mtf[i] = i;

  function measure(ctxtMtf, item) {
    if (item && item.offset !== undefined) {
      const offsetBits = Math.max(roundUp(bitLength(item.offset - 1), 5), 5);
      const countBits = (Math.floor((item.count - MIN_C) / 7) + 1) * 3;
      return [2 + (offsetBits < 15 ? 1 : 0) + offsetBits + countBits, null];
    }
    const m = ctxtMtf || mtf;
    const chI = m.indexOf(item);
    const cost = mtfCost(chI);
    const nextMtf = Uint8Array.from(m);
    updateMtf(nextMtf, chI, item);
    return [cost, nextMtf];
  }

  function minCost(dist) {
    return Math.max((Math.floor((dist - MIN_C) / 7) + 1) * 3 - 11, 0);
  }
  function getCheaperC(c) {
    return roundDown(c - MIN_C, 7) - 1 + MIN_C;
  }

  function preprocessLitblockIdxs() {
    const premtf = new Uint8Array(256);
    for (let i = 0; i < 256; i++) premtf[i] = i;
    const preMinC = 4;
    const lastCostLen = 0x20;
    const mask = lastCostLen - 1;
    const lastCosts = new Array(lastCostLen).fill(0);
    let sumCosts = 0;
    const idxs = [];
    let inLitblock = false;

    function suffixSum(arr, j) {
      let s = 0;
      for (let k = arr.length - 1 - j; k < arr.length; k++) s += arr[k];
      return s;
    }

    function addLastCost(i, cost) {
      const costI = i & mask;
      sumCosts -= lastCosts[costI];
      lastCosts[costI] = cost;
      sumCosts += cost;
      if ((i >= lastCostLen && !inLitblock && sumCosts > 19) || (inLitblock && sumCosts < 0)) {
        inLitblock = !inLitblock;
        const ordered = lastCosts.slice(costI + 1).concat(lastCosts.slice(0, costI + 1));
        let bestJ = 0;
        let bestSum = suffixSum(ordered, 0);
        for (let j = 1; j < lastCostLen; j++) {
          const s = suffixSum(ordered, j);
          if (inLitblock ? s > bestSum : s < bestSum) {
            bestSum = s;
            bestJ = j;
          }
        }
        idxs.push(i - bestJ);
      }
    }

    for (const [at, item] of getLz77(code, { minC: preMinC, fastC: 1 })) {
      if (item && item.offset !== undefined) {
        const cost = Math.floor((20 - item.count * 8) / item.count);
        for (let j = 0; j < item.count; j++) addLastCost(at + j, cost);
      } else {
        const chI = premtf.indexOf(item);
        updateMtf(premtf, chI, item);
        addLastCost(at, mtfCost(chI) - 8);
      }
    }
    for (let i = 0; i < lastCostLen; i++) addLastCost(len + i, 0);
    return idxs;
  }

  function writeMatch(item) {
    bw.bit(0);
    const offsetVal = item.offset - 1;
    let countVal = item.count - MIN_C;
    const offsetBits = Math.max(roundUp(bitLength(offsetVal), 5), 5);
    bw.bit(offsetBits < 15);
    if (offsetBits < 15) bw.bit(offsetBits < 10);
    bw.bits(offsetBits, offsetVal);
    while (countVal >= 7) {
      bw.bits(3, 7);
      countVal -= 7;
    }
    bw.bits(3, countVal);
  }

  function writeLiteral(ch) {
    bw.bit(1);
    const chI = mtf.indexOf(ch);
    let iVal = chI;
    let iBits = 4;
    while (iVal >= 1 << iBits) {
      bw.bit(1);
      iVal -= 1 << iBits;
      iBits++;
    }
    bw.bit(0);
    bw.bits(iBits, iVal);
    updateMtf(mtf, chI, ch);
  }

  function writeLitblock(bytes) {
    bw.bit(0);
    bw.bit(1);
    bw.bit(0);
    bw.bits(10, 0);
    for (const ch of bytes) bw.bits(8, ch);
    bw.bits(8, 0);
  }

  for (const [, item] of getLz77(code, {
    measure,
    minCost,
    getCheaperC,
    maxOSteps: [0x20, 0x400],
    litblockIdxs: preprocessLitblockIdxs(),
  })) {
    if (item && item.offset !== undefined) writeMatch(item);
    else if (item instanceof Uint8Array) writeLitblock(item);
    else writeLiteral(item);
  }
  bw.flush();

  const stream = bw.toBytes();
  const out = new Uint8Array(8 + stream.length);
  out.set(HEADER_PXA, 0);
  out[4] = (len >> 8) & 255;
  out[5] = len & 255;
  out[6] = (out.length >> 8) & 255;
  out[7] = out.length & 255;
  out.set(stream, 8);
  return out;
}

function pxaDecompress(region) {
  const rawLen = (region[4] << 8) | region[5];
  const compLen = (region[6] << 8) | region[7];
  const out = new Uint8Array(Math.max(rawLen, 1) + 1);
  let srcPos = 8;
  let bit = 1;
  let destPos = 0;
  function getbit() {
    if (srcPos >= region.length) return 0;
    const v = region[srcPos] & bit ? 1 : 0;
    bit <<= 1;
    if (bit === 256) {
      bit = 1;
      srcPos++;
    }
    return v;
  }
  function getval(bits) {
    let v = 0;
    for (let q = 0; q < bits; q++) if (getbit()) v |= 1 << q;
    return v;
  }
  function getchain(linkBits, maxBits) {
    const maxLink = (1 << linkBits) - 1;
    let val = 0;
    let vv = maxLink;
    let read = 0;
    while (vv === maxLink) {
      vv = getval(linkBits);
      read += linkBits;
      val += vv;
      if (read >= maxBits) return val;
    }
    return val;
  }
  function getnum() {
    const bits = (3 - getchain(1, 2)) * 5;
    const v = getval(bits);
    return v === 0 && bits === 10 ? -1 : v;
  }
  const literal = new Uint8Array(256);
  for (let m = 0; m < 256; m++) literal[m] = m;
  while (srcPos < compLen && destPos < rawLen) {
    if (getbit() === 0) {
      const offset = getnum() + 1;
      if (offset === 0) {
        while (destPos < rawLen) {
          const ch = getval(8);
          if (ch === 0) break;
          out[destPos++] = ch;
        }
      } else {
        let blockLen = getchain(3, 100000) + MIN_C;
        while (blockLen > 0 && destPos < out.length) {
          out[destPos] = out[destPos - offset];
          destPos++;
          blockLen--;
        }
      }
    } else {
      let lpos = 0;
      let bits = 0;
      let safety = 0;
      while (getbit() === 1 && safety++ < 16) {
        lpos += 1 << (4 + bits);
        bits++;
      }
      bits += 4;
      lpos += getval(bits);
      if (lpos > 255) break;
      const c = literal[lpos];
      out[destPos++] = c;
      for (let mi = lpos; mi > 0; mi--) literal[mi] = literal[mi - 1];
      literal[0] = c;
    }
  }
  return out.subarray(0, Math.min(rawLen, destPos));
}

function legacyDecompress(region) {
  const codeLen = (region[4] << 8) | region[5];
  const out = new Uint8Array(Math.max(codeLen, 1));
  let outI = 0;
  let inI = 8;
  while (outI < codeLen && inI < region.length) {
    const ch = region[inI];
    if (ch === 0) {
      inI++;
      const ch2 = region[inI];
      if (ch2 === 0) break;
      out[outI++] = ch2;
    } else if (ch <= 0x3b) {
      out[outI++] = LEGACY_TABLE.charCodeAt(ch);
    } else {
      inI++;
      const ch2 = region[inI];
      const count = (ch2 >> 4) + 2;
      const offset = ((ch - 0x3c) << 4) + (ch2 & 0xf);
      out.copyWithin(outI, outI - offset, outI - offset + count);
      outI += count;
    }
    inI++;
  }
  let end = outI;
  for (const suffix of [FUTURE1, FUTURE2]) {
    if (end > suffix.length) {
      let match = true;
      for (let i = 0; i < suffix.length; i++) {
        if (out[end - suffix.length + i] !== suffix.charCodeAt(i)) {
          match = false;
          break;
        }
      }
      if (match) {
        end -= suffix.length;
        if (end > 0 && out[end - 1] === 10) end--;
      }
    }
  }
  return out.subarray(0, end);
}

function codeFromRegion(region) {
  if (region[0] === 0 && region[1] === 0x70 && region[2] === 0x78 && region[3] === 0x61) {
    return pxaDecompress(region);
  }
  if (region[0] === 0x3a && region[1] === 0x63 && region[2] === 0x3a && region[3] === 0x00) {
    return legacyDecompress(region);
  }
  let end = region.indexOf(0);
  if (end < 0) end = region.length;
  return region.slice(0, end);
}

function codeToRegion(code) {
  const region = new Uint8Array(CODE_SIZE);
  if (!code.length) return region;
  let payload = null;
  try {
    const comp = pxaCompress(code);
    if (comp && comp.length <= CODE_SIZE) payload = comp;
  } catch (e) {
    if (!/too many characters/.test(e.message)) throw e;
  }
  if (!payload && code.length <= CODE_SIZE) payload = code;
  if (!payload) {
    throw new Error(`cart code is too large: ${code.length} bytes do not fit the ${CODE_SIZE}-byte code region`);
  }
  region.set(payload);
  return region;
}
function newLabel() {
  return new Uint8Array(16384);
}

function sfxNote(sfx, i, n) {
  const base = i * 68 + n * 2;
  const b0 = sfx[base];
  const b1 = sfx[base + 1];
  return {
    pitch: b0 & 63,
    waveform: ((b1 & 0x80) >> 4) | ((b1 & 1) << 2) | ((b0 >> 6) & 3),
    volume: (b1 >> 1) & 7,
    effect: (b1 >> 4) & 7,
  };
}

function setSfxNote(sfx, i, n, { pitch = 0, waveform = 0, volume = 0, effect = 0 } = {}) {
  const base = i * 68 + n * 2;
  sfx[base] = (pitch & 63) | ((waveform & 3) << 6);
  sfx[base + 1] = ((waveform & 8) << 4) | ((waveform & 4) >> 2) | ((effect & 7) << 4) | ((volume & 7) << 1);
}

const VERSION = 43;
const DEFAULT_META = [0x00, 0x02, 0x07, 0x77, 0x00];
const SILENT = [0x41, 0x42, 0x43, 0x44];

function newCart(code = "") {
  const cart = {
    version: VERSION,
    code: String(code ?? ""),
    gfx: new Uint8Array(0x2000),
    map: new Uint8Array(0x1000),
    gff: new Uint8Array(0x0100),
    music: new Uint8Array(0x0100),
    sfx: new Uint8Array(0x1100),
    label: newLabel(),
    custom: null,
    meta: Uint8Array.from(DEFAULT_META),
  };
  for (let i = 0; i < 64; i++) cart.music.set(SILENT, i * 4);
  for (let i = 0; i < 64; i++) cart.sfx[i * 68 + 65] = i === 0 ? 1 : 16;
  return cart;
}

function cartToData(cart) {
  const d = new Uint8Array(0x8020);
  d.set(cart.gfx, 0x0000);
  d.set(cart.map, 0x2000);
  d.set(cart.gff, 0x3000);
  d.set(cart.music, 0x3100);
  d.set(cart.sfx, 0x3200);
  d.set(codeToRegion(strToBytes(cart.code)), 0x4300);
  d[0x8000] = cart.version || VERSION;
  d.set((cart.meta || DEFAULT_META).subarray(0, 5), 0x8001);
  d.set(sha1(d.subarray(0, 0x8000)), 0x8006);
  return d;
}

function dataToCart(data) {
  const cart = newCart("");
  cart.gfx = data.slice(0x0000, 0x2000);
  cart.map = data.slice(0x2000, 0x3000);
  cart.gff = data.slice(0x3000, 0x3100);
  cart.music = data.slice(0x3100, 0x3200);
  cart.sfx = data.slice(0x3200, 0x4300);
  cart.code = bytesToStr(codeFromRegion(data.subarray(0x4300, 0x8000)));
  cart.version = data[0x8000];
  cart.meta = data.slice(0x8001, 0x8006);
  return cart;
}

function hex2(b) {
  return b.toString(16).padStart(2, "0");
}
function hex1(b) {
  return b.toString(16).padStart(1, "0");
}
function ext1(b) {
  return b < 16 ? hex1(b) : String.fromCharCode(103 + b - 16);
}

function defaultSfxRow(i) {
  const row = new Uint8Array(68);
  row[65] = i === 0 ? 1 : 16;
  return row;
}

function rowsEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function rowEmpty(row, from) {
  if (from === undefined) from = 0;
  for (let i = from; i < row.length; i++) if (row[i]) return false;
  return true;
}

function encodeP8(cart) {
  const lines = ["pico-8 cartridge // http://www.pico-8.com", `version ${cart.version}`];
  const codeBytes = strToBytes(cart.code);
  let codeText = "";
  for (let i = 0; i < codeBytes.length; i++) codeText += String.fromCharCode(codeBytes[i]);
  lines.push("__lua__", ...codeText.split("\n"));

  let last = -1;
  for (let y = 0; y < 128; y++) {
    if (!rowEmpty(cart.gfx.subarray(y * 64, (y + 1) * 64))) last = y;
    else if (cart.custom && !rowEmpty(cart.custom.subarray(y * 128, (y + 1) * 128))) last = y;
  }
  if (last >= 0) {
    lines.push("__gfx__");
    for (let y = 0; y <= last; y++) {
      const custom = cart.custom && !rowEmpty(cart.custom.subarray(y * 128, (y + 1) * 128));
      let row = "";
      if (custom) {
        for (let x = 0; x < 128; x++) {
          const v = cart.custom[y * 128 + x] || (cart.gfx[y * 64 + (x >> 1)] >> ((x & 1) * 4)) & 15;
          row += hex2(v);
        }
      } else {
        for (const b of cart.gfx.subarray(y * 64, (y + 1) * 64)) row += hex1(b & 15) + hex1(b >> 4);
      }
      lines.push(row);
    }
  }

  last = -1;
  for (let y = 0; y < 2; y++) if (!rowEmpty(cart.gff.subarray(y * 128, (y + 1) * 128))) last = y;
  if (last >= 0) {
    lines.push("__gff__");
    for (let y = 0; y <= last; y++) {
      let row = "";
      for (const b of cart.gff.subarray(y * 128, (y + 1) * 128)) row += hex2(b);
      lines.push(row);
    }
  }

  last = -1;
  for (let y = 0; y < 32; y++) if (!rowEmpty(cart.map.subarray(y * 128, (y + 1) * 128))) last = y;
  if (last >= 0) {
    lines.push("__map__");
    for (let y = 0; y <= last; y++) {
      let row = "";
      for (const b of cart.map.subarray(y * 128, (y + 1) * 128)) row += hex2(b);
      lines.push(row);
    }
  }

  last = -1;
  for (let i = 0; i < 64; i++) {
    if (!rowsEqual(cart.sfx.subarray(i * 68, (i + 1) * 68), defaultSfxRow(i))) last = i;
  }
  if (last >= 0) {
    lines.push("__sfx__");
    for (let i = 0; i <= last; i++) {
      const base = i * 68;
      let row = "";
      for (let k = 0; k < 4; k++) row += hex2(cart.sfx[base + 64 + k]);
      for (let n = 0; n < 32; n++) {
        const lo = cart.sfx[base + n * 2];
        const hi = cart.sfx[base + n * 2 + 1];
        const value = lo | (hi << 8);
        const pitch = value & 0x3f;
        const wave = ((value >> 6) & 0x7) | ((value >> 12) & 0x8);
        const vol = (value >> 9) & 0x7;
        const fx = (value >> 12) & 0x7;
        row += hex2(pitch) + hex1(wave) + hex1(vol) + hex1(fx);
      }
      lines.push(row);
    }
  }

  last = -1;
  for (let i = 0; i < 64; i++) {
    const row = cart.music.subarray(i * 4, (i + 1) * 4);
    let isDefault = true;
    for (let ch = 0; ch < 4; ch++) {
      if ((row[ch] & 0x7f) !== SILENT[ch] || row[ch] & 0x80) isDefault = false;
    }
    if (!isDefault) last = i;
  }
  if (last >= 0) {
    lines.push("__music__");
    for (let i = 0; i <= last; i++) {
      const row = cart.music.subarray(i * 4, (i + 1) * 4);
      const flags = (row[0] >> 7) | ((row[1] >> 7) << 1) | ((row[2] >> 7) << 2) | ((row[3] >> 7) << 3);
      lines.push(
        hex2(flags) + " " + hex2(row[0] & 0x7f) + hex2(row[1] & 0x7f) + hex2(row[2] & 0x7f) + hex2(row[3] & 0x7f),
      );
    }
  }

  if (cart.label && !rowEmpty(cart.label)) {
    lines.push("__label__");
    for (let y = 0; y < 128; y++) {
      let row = "";
      for (let x = 0; x < 128; x++) row += ext1(cart.label[y * 128 + x]);
      lines.push(row);
    }
  }

  return lines.join("\n") + "\n";
}

function decodeP8(input) {
  let text;
  const fromString = typeof input === "string";
  if (fromString) text = input;
  else {
    const bytes =
      input instanceof Uint8Array
        ? input
        : input instanceof ArrayBuffer
          ? new Uint8Array(input)
          : ArrayBuffer.isView(input)
            ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
            : null;
    if (!bytes) throw new Error("decodeP8: expected a string or bytes");
    text = p8DecodeText(bytes);
  }
  const cart = newCart("");
  let section = null;
  let codeLines = [];
  let gfxRow = 0,
    gffRow = 0,
    mapRow = 0,
    sfxRow = 0,
    songRow = 0,
    labelRow = 0;
  const lines = text.split(/\r?\n/);
  if (lines.length && !lines[lines.length - 1]) lines.pop();

  function flushCode() {
    if (section === "lua") {
      const raw = codeLines.join("\n");
      cart.code = bytesToStr(fromString ? glyphBytes(raw) : p8StrBytes(raw));
      codeLines = [];
    }
  }

  for (const line of lines) {
    const header = line.match(/^__([a-zA-Z:_0-9]+)__\s*$/);
    if (header) {
      flushCode();
      section = header[1];
      continue;
    }
    const clean = section === "lua" ? line : line.trim();
    switch (section) {
      case null: {
        const m = clean.match(/^version (\d+)$/);
        if (m) cart.version = parseInt(m[1], 10);
        break;
      }
      case "lua":
        codeLines.push(line);
        break;
      case "gfx": {
        if (!clean || gfxRow >= 128) break;
        if (clean.length === 256) {
          const rowBytes = new Uint8Array(64);
          for (let x = 0; x < 128; x++) {
            const v = parseInt(clean.substr(x * 2, 2), 16) || 0;
            rowBytes[x >> 1] |= x & 1 ? (v & 15) << 4 : v & 15;
            if (v > 15) {
              if (!cart.custom) cart.custom = new Uint8Array(16384);
              cart.custom[gfxRow * 128 + x] = v;
            }
          }
          cart.gfx.set(rowBytes, gfxRow * 64);
        } else {
          for (let x = 0; x < 128 && x < clean.length; x++) {
            const v = parseInt(clean[x], 16);
            if (!v) continue;
            const i = gfxRow * 64 + (x >> 1);
            cart.gfx[i] = x & 1 ? (cart.gfx[i] & 15) | (v << 4) : (cart.gfx[i] & 240) | v;
          }
        }
        gfxRow++;
        break;
      }
      case "gff": {
        if (!clean || gffRow >= 2) break;
        for (let i = 0; i < 128 && i * 2 < clean.length; i++) {
          cart.gff[gffRow * 128 + i] = parseInt(clean.substr(i * 2, 2).padEnd(2, "0"), 16) || 0;
        }
        gffRow++;
        break;
      }
      case "map": {
        if (!clean || mapRow >= 64) break;
        for (let i = 0; i < 128 && i * 2 < clean.length; i++) {
          const v = parseInt(clean.substr(i * 2, 2).padEnd(2, "0"), 16) || 0;
          if (mapRow < 32) cart.map[mapRow * 128 + i] = v;
          else cart.gfx[0x1000 + (mapRow - 32) * 128 + i] = v;
        }
        mapRow++;
        break;
      }
      case "sfx": {
        if (!clean || sfxRow >= 64) break;
        const base = sfxRow * 68;
        for (let k = 0; k < 4; k++) {
          cart.sfx[base + 64 + k] = parseInt(clean.substr(k * 2, 2).padEnd(2, "0"), 16) || 0;
        }
        for (let n = 0; n < 32; n++) {
          const at = 8 + n * 5;
          if (at + 5 > clean.length) break;
          const bph = parseInt(clean.substr(at, 2), 16);
          const bw = parseInt(clean.substr(at + 2, 1), 16);
          const bv = parseInt(clean.substr(at + 3, 1), 16);
          const be = parseInt(clean.substr(at + 4, 1), 16);
          const value = (bph & 0x3f) | ((bw & 0x7) << 6) | ((bv & 0x7) << 9) | ((be & 0x7) << 12) | ((bw & 0x8) << 12);
          cart.sfx[base + n * 2] = value & 0xff;
          cart.sfx[base + n * 2 + 1] = (value >> 8) & 0xff;
        }
        sfxRow++;
        break;
      }
      case "music": {
        if (!clean || songRow >= 64) break;
        const flags = parseInt(clean.substr(0, 2).padEnd(2, "0"), 16) || 0;
        const rest = clean.slice(2).replace(/\s+/g, "");
        for (let ch = 0; ch < 4; ch++) {
          const id = parseInt(rest.substr(ch * 2, 2).padEnd(2, "0"), 16) || 0;
          cart.music[songRow * 4 + ch] = (id & 0x7f) | (((flags >> ch) & 1) << 7);
        }
        songRow++;
        break;
      }
      case "label": {
        if (!clean || labelRow >= 128) break;
        for (let x = 0; x < 128 && x < clean.length; x++) {
          const c = clean[x];
          const v = c >= "g" && c <= "v" ? c.charCodeAt(0) - 103 + 16 : parseInt(c, 16) || 0;
          cart.label[labelRow * 128 + x] = v;
        }
        labelRow++;
        break;
      }
    }
  }
  flushCode();
  return cart;
}
const PNG_W = 160;
const PNG_H = 205;
const ART_B64 = "A2RkaACaAAQI/AVkZGgAAQAECPyaZGRk/AEABAj8A2RkaAABAAQI/JxkZGT8AQAECPwBZGRoAAEABAj8nmRkZPwCAAQI/J5kZGT8AgAECPyeZGRk/AIABAj8LmRkZPwB/ABM/G9kZGT8AgAECPwtZGRk/AH8mAD8Afzw6PwB/My8/G5kZGT8AgAECPwsZGRk/AH85CT8A/zw6PwB/HSo/G1kZGT8AgAECPwtZGRk/AEA4DD8Afzw6PwBhHCo/G5kZGT8AgAECPwPZGRk/AT88Oj8AWRkZPwE/PDo/AJkZGT8A/zw6PwCZGRk/AT88Oj8BWRkZPwE/PDo/AJkZGT8ASis/PwuZGRk/AGwqKT8AWRkZPwBsKik/AFkZGT8AbCopPwBZGRk/AGwqKT8AWRkZPwBsKik/AFkZGT8AbCopPwDZGRk/AOwqKT8AWRkZPwDsKik/AJkZGT8ArCopPwCZGRk/AKwqKT8BWRkZPwDsKik/ARkZGT8ArCopPwCZGRk/AKwqKT8AWRkZPwDsKik/A5kZGT8AgAECPwOZGRk/AL88Oj8AWRkZPwC/PDo/AJkZGT8Avzw6PwCZGRk/AL88Oj8A2RkZPwC/PDo/AFkZGT8Avzw6PwFZGRk/AH88Oj8AmRkZPwB/PDo/DFkZGT8AbCopPwBZGRk/AGwqKT8AWRkZPwBsKik/AFkZGT8AbCopPwBZGRk/AGwqKT8AWRkZPwBsKik/ANkZGT8AbCopPwBZGRk/AGwqKT8AmRkZPwBsKik/AJkZGT8AbCopPwDZGRk/AGwqKT8AWRkZPwBsKik/AVkZGT8AbCopPwBZGRk/AGwqKT8A2RkZPwBsKik/ANkZGT8AbCopPwBZGRk/AGwqKT8AWRkZPwDsKik/A5kZGT8AgAECPwOZGRk/AX88Oj8AmRkZPwC/PDo/AJkZGT8Avzw6PwDZGRk/AL88Oj8AWRkZPwC/PDo/AFkZGT8Avzw6PwBZGRk/AX88Oj8MWRkZPwBsKik/AFkZGT8AbCopPwBZGRk/AGwqKT8AWRkZPwBsKik/AFkZGT8AbCopPwBZGRk/AGwqKT8A2RkZPwDsKik/AJkZGT8AbCopPwCZGRk/AGwqKT8A2RkZPwBsKik/AFkZGT8AbCopPwBZGRk/AOwqKT8AWRkZPwDsKik/ANkZGT8AbCopPwDZGRk/AGwqKT8AWRkZPwBsKik/AFkZGT8AbCopPwBZGRk/AGwqKT8DmRkZPwCAAQI/A5kZGT8Avzw6PwFZGRk/AL88Oj8AmRkZPwC/PDo/ANkZGT8Avzw6PwBZGRk/AL88Oj8BGRkZPwC/PDo/AJkZGT8Afzw6PwxZGRk/AOwqKT8AWRkZPwDsKik/AFkZGT8A7CopPwDZGRk/AGwqKT8BGRkZPwBsKik/AJkZGT8AbCopPwDZGRk/AGwqKT8AWRkZPwBsKik/AVkZGT8AbCopPwBZGRk/AGwqKT8A2RkZPwBsKik/ANkZGT8AbCopPwBZGRk/AGwqKT8AWRkZPwBsKik/AFkZGT8AbCopPwOZGRk/AIABAj8DmRkZPwC/PDo/ARkZGT8BPzw6PwBZGRk/AT88Oj8AWRkZPwE/PDo/AVkZGT8Bfzw6PwxZGRk/AOwqKT8AWRkZPwDsKik/AFkZGT8A7CopPwBZGRk/AGwqKT8AWRkZPwBsKik/ANkZGT8A7CopPwCZGRk/AKwqKT8AWRkZPwCsKik/AZkZGT8A7CopPwBZGRk/AGwqKT8AmRkZPwCsKik/AFkZGT8ArCopPwCZGRk/AGwqKT8AWRkZPwBsKik/A5kZGT8AgAECPyeZGRk/AIABAj8nmRkZPwCAAQI/J5kZGT8AgAECPyeZGRk/AIABAj8nmRkZPwCAAQI/J5kZGT8AgAECPyeZGRk/AIABAj8nmRkZPwCAAQI/A5kZGT8ggAECPwOZGRk/AIABAj8DmRkZPwBAAQI/ICIiIj8AQAECPwOZGRk/AIABAj8DmRkZPwBAAQI/ICIiIj8AQAECPwOZGRk/AIABAj8DmRkZPwBAAQI/ICIiIj8AQAECPwOZGRk/AIABAj8DmRkZPwBAAQI/ICIiIj8AQAECPwOZGRk/AIABAj8DmRkZPwBAAQI/ICIiIj8AQAECPwOZGRk/AIABAj8DmRkZPwBAAQI/ICIiIj8AQAECPwOZGRk/AIABAj8DmRkZPwBAAQI/ICIiIj8AQAECPwOZGRk/AIABAj8DmRkZPwBAAQI/ICIiIj8AQAECPwOZGRk/AIABAj8DmRkZPwBAAQI/ICIiIj8AQAECPwOZGRk/AIABAj8DmRkZPwBAAQI/ICIiIj8AQAECPwOZGRk/AIABAj8DmRkZPwBAAQI/ICIiIj8AQAECPwOZGRk/AIABAj8DmRkZPwBAAQI/ICIiIj8AQAECPwOZGRk/AIABAj8DmRkZPwBAAQI/ICIiIj8AQAECPwOZGRk/AIABAj8DmRkZPwBAAQI/ICIiIj8AQAECPwOZGRk/AIABAj8DmRkZPwBAAQI/ICIiIj8AQAECPwOZGRk/AIABAj8DmRkZPwBAAQI/ICIiIj8AQAECPwOZGRk/AIABAj8DmRkZPwBAAQI/ICIiIj8AQAECPwOZGRk/AIABAj8DmRkZPwBAAQI/ICIiIj8AQAECPwOZGRk/AIABAj8DmRkZPwBAAQI/ICIiIj8AQAECPwOZGRk/AIABAj8DmRkZPwBAAQI/ICIiIj8AQAECPwOZGRk/AIABAj8DmRkZPwBAAQI/ICIiIj8AQAECPwOZGRk/AIABAj8DmRkZPwBAAQI/ICIiIj8AQAECPwOZGRk/AIABAj8DmRkZPwBAAQI/ICIiIj8AQAECPwOZGRk/AIABAj8DmRkZPwBAAQI/ICIiIj8AQAECPwOZGRk/AIABAj8DmRkZPwBAAQI/ICIiIj8AQAECPwOZGRk/AIABAj8DmRkZPwBAAQI/ICIiIj8AQAECPwOZGRk/AIABAj8DmRkZPwBAAQI/ICIiIj8AQAECPwOZGRk/AIABAj8DmRkZPwBAAQI/ICIiIj8AQAECPwOZGRk/AIABAj8DmRkZPwBAAQI/ICIiIj8AQAECPwOZGRk/AIABAj8DmRkZPwBAAQI/ICIiIj8AQAECPwOZGRk/AIABAj8DmRkZPwBAAQI/ICIiIj8AQAECPwOZGRk/AIABAj8DmRkZPwBAAQI/ICIiIj8AQAECPwOZGRk/AIABAj8DmRkZPwBAAQI/ICIiIj8AQAECPwOZGRk/AIABAj8DmRkZPwBAAQI/ICIiIj8AQAECPwOZGRk/AIABAj8DmRkZPwBAAQI/ICIiIj8AQAECPwOZGRk/AIABAj8DmRkZPwBAAQI/ICIiIj8AQAECPwOZGRk/AIABAj8DmRkZPwBAAQI/ICIiIj8AQAECPwOZGRk/AIABAj8DmRkZPwBAAQI/ICIiIj8AQAECPwOZGRk/AIABAj8DmRkZPwBAAQI/ICIiIj8AQAECPwOZGRk/AIABAj8DmRkZPwBAAQI/ICIiIj8AQAECPwOZGRk/AIABAj8DmRkZPwBAAQI/ICIiIj8AQAECPwOZGRk/AIABAj8DmRkZPwBAAQI/ICIiIj8AQAECPwOZGRk/AIABAj8DmRkZPwBAAQI/ICIiIj8AQAECPwOZGRk/AIABAj8DmRkZPwBAAQI/ICIiIj8AQAECPwOZGRk/AIABAj8DmRkZPwBAAQI/ICIiIj8AQAECPwOZGRk/AIABAj8DmRkZPwBAAQI/ICIiIj8AQAECPwOZGRk/AIABAj8DmRkZPwBAAQI/ICIiIj8AQAECPwOZGRk/AIABAj8DmRkZPwBAAQI/ICIiIj8AQAECPwOZGRk/AIABAj8DmRkZPwBAAQI/ICIiIj8AQAECPwOZGRk/AIABAj8DmRkZPwBAAQI/ICIiIj8AQAECPwOZGRk/AIABAj8DmRkZPwBAAQI/ICIiIj8AQAECPwOZGRk/AIABAj8DmRkZPwBAAQI/ICIiIj8AQAECPwOZGRk/AIABAj8DmRkZPwBAAQI/ICIiIj8AQAECPwOZGRk/AIABAj8DmRkZPwBAAQI/ICIiIj8AQAECPwOZGRk/AIABAj8DmRkZPwBAAQI/ICIiIj8AQAECPwOZGRk/AIABAj8DmRkZPwBAAQI/ICIiIj8AQAECPwOZGRk/AIABAj8DmRkZPwBAAQI/ICIiIj8AQAECPwOZGRk/AIABAj8DmRkZPwBAAQI/ICIiIj8AQAECPwOZGRk/AIABAj8DmRkZPwBAAQI/ICIiIj8AQAECPwOZGRk/AIABAj8DmRkZPwBAAQI/ICIiIj8AQAECPwOZGRk/AIABAj8DmRkZPwBAAQI/ICIiIj8AQAECPwOZGRk/AIABAj8DmRkZPwBAAQI/ICIiIj8AQAECPwOZGRk/AIABAj8DmRkZPwBAAQI/ICIiIj8AQAECPwOZGRk/AIABAj8DmRkZPwBAAQI/ICIiIj8AQAECPwOZGRk/AIABAj8DmRkZPwBAAQI/ICIiIj8AQAECPwOZGRk/AIABAj8DmRkZPwBAAQI/ICIiIj8AQAECPwOZGRk/AIABAj8DmRkZPwBAAQI/ICIiIj8AQAECPwOZGRk/AIABAj8DmRkZPwBAAQI/ICIiIj8AQAECPwOZGRk/AIABAj8DmRkZPwBAAQI/ICIiIj8AQAECPwOZGRk/AIABAj8DmRkZPwBAAQI/ICIiIj8AQAECPwOZGRk/AIABAj8DmRkZPwBAAQI/ICIiIj8AQAECPwOZGRk/AIABAj8DmRkZPwBAAQI/ICIiIj8AQAECPwOZGRk/AIABAj8DmRkZPwBAAQI/ICIiIj8AQAECPwOZGRk/AIABAj8DmRkZPwBAAQI/ICIiIj8AQAECPwOZGRk/AIABAj8DmRkZPwBAAQI/ICIiIj8AQAECPwOZGRk/AIABAj8DmRkZPwBAAQI/ICIiIj8AQAECPwOZGRk/AIABAj8DmRkZPwBAAQI/ICIiIj8AQAECPwOZGRk/AIABAj8DmRkZPwBAAQI/ICIiIj8AQAECPwOZGRk/AIABAj8DmRkZPwBAAQI/ICIiIj8AQAECPwOZGRk/AIABAj8DmRkZPwBAAQI/ICIiIj8AQAECPwOZGRk/AIABAj8DmRkZPwBAAQI/ICIiIj8AQAECPwOZGRk/AIABAj8DmRkZPwBAAQI/ICIiIj8AQAECPwOZGRk/AIABAj8DmRkZPwBAAQI/ICIiIj8AQAECPwOZGRk/AIABAj8DmRkZPwBAAQI/ICIiIj8AQAECPwOZGRk/AIABAj8DmRkZPwBAAQI/ICIiIj8AQAECPwOZGRk/AIABAj8DmRkZPwBAAQI/ICIiIj8AQAECPwOZGRk/AIABAj8DmRkZPwBAAQI/ICIiIj8AQAECPwOZGRk/AIABAj8DmRkZPwBAAQI/ICIiIj8AQAECPwOZGRk/AIABAj8DmRkZPwBAAQI/ICIiIj8AQAECPwOZGRk/AIABAj8DmRkZPwBAAQI/ICIiIj8AQAECPwOZGRk/AIABAj8DmRkZPwBAAQI/ICIiIj8AQAECPwOZGRk/AIABAj8DmRkZPwBAAQI/ICIiIj8AQAECPwOZGRk/AIABAj8DmRkZPwBAAQI/ICIiIj8AQAECPwOZGRk/AIABAj8DmRkZPwBAAQI/ICIiIj8AQAECPwOZGRk/AIABAj8DmRkZPwBAAQI/ICIiIj8AQAECPwOZGRk/AIABAj8DmRkZPwBAAQI/ICIiIj8AQAECPwOZGRk/AIABAj8DmRkZPwBAAQI/ICIiIj8AQAECPwOZGRk/AIABAj8DmRkZPwBAAQI/ICIiIj8AQAECPwOZGRk/AIABAj8DmRkZPwBAAQI/ICIiIj8AQAECPwOZGRk/AIABAj8DmRkZPwBAAQI/ICIiIj8AQAECPwOZGRk/AIABAj8DmRkZPwBAAQI/ICIiIj8AQAECPwOZGRk/AIABAj8DmRkZPwBAAQI/ICIiIj8AQAECPwOZGRk/AIABAj8DmRkZPwBAAQI/ICIiIj8AQAECPwOZGRk/AIABAj8DmRkZPwBAAQI/ICIiIj8AQAECPwOZGRk/AIABAj8DmRkZPwBAAQI/ICIiIj8AQAECPwOZGRk/AIABAj8DmRkZPwBAAQI/ICIiIj8AQAECPwOZGRk/AIABAj8DmRkZPwBAAQI/ICIiIj8AQAECPwOZGRk/AIABAj8DmRkZPwBAAQI/ICIiIj8AQAECPwOZGRk/AIABAj8DmRkZPwBAAQI/ICIiIj8AQAECPwOZGRk/AIABAj8DmRkZPwBAAQI/ICIiIj8AQAECPwOZGRk/AIABAj8DmRkZPwBAAQI/ICIiIj8AQAECPwOZGRk/AIABAj8DmRkZPwBAAQI/ICIiIj8AQAECPwOZGRk/AIABAj8DmRkZPwBAAQI/ICIiIj8AQAECPwOZGRk/AIABAj8DmRkZPwBAAQI/ICIiIj8AQAECPwOZGRk/AIABAj8DmRkZPwBAAQI/ICIiIj8AQAECPwOZGRk/AIABAj8DmRkZPwBAAQI/ICIiIj8AQAECPwOZGRk/AIABAj8DmRkZPwBAAQI/ICIiIj8AQAECPwOZGRk/AIABAj8DmRkZPwBAAQI/ICIiIj8AQAECPwOZGRk/AIABAj8DmRkZPwBAAQI/ICIiIj8AQAECPwOZGRk/AIABAj8DmRkZPwBAAQI/ICIiIj8AQAECPwOZGRk/AIABAj8DmRkZPwBAAQI/ICIiIj8AQAECPwOZGRk/AIABAj8DmRkZPwBAAQI/ICIiIj8AQAECPwOZGRk/AIABAj8DmRkZPwBAAQI/ICIiIj8AQAECPwOZGRk/AIABAj8DmRkZPwBAAQI/ICIiIj8AQAECPwOZGRk/AIABAj8DmRkZPwBAAQI/ICIiIj8AQAECPwOZGRk/AIABAj8DmRkZPwBAAQI/ICIiIj8AQAECPwOZGRk/AIABAj8DmRkZPwBAAQI/ICIiIj8AQAECPwOZGRk/AIABAj8DmRkZPwBAAQI/ICIiIj8AQAECPwOZGRk/AIABAj8DmRkZPyCAAQI/A5kZGT8AgAECPyeZGRk/AIABAj8nmRkZPwCAAQI/J5kZGT8AgAECPyeZGRk/AIABAj8nmRkZPwCAAQI/J5kZGT8AgAECPyeZGRk/AIABAj8nmRkZPwCAAQI/J5kZGT8AgAECPyeZGRk/AIABAj8DmRkZPyCNDQ0/A5kZGT8AgAECPwOZGRk/II0NDT8DmRkZPwCAAQI/A5kZGT8gjQ0NPwOZGRk/AIABAj8DmRkZPyCNDQ0/A5kZGT8AgAECPwOZGRk/II0NDT8DmRkZPwCAAQI/A5kZGT8gjQ0NPwOZGRk/AIABAj8DmRkZPyCNDQ0/A5kZGT8AgAECPwOZGRk/II0NDT8DmRkZPwCAAQI/A5kZGT8gjQ0NPwOZGRk/AIABAj8DmRkZPyCNDQ0/A5kZGT8AgAECPwOZGRk/II0NDT8DmRkZPwCAAQI/A5kZGT8gjQ0NPwOZGRk/AIABAj8DmRkZPyCNDQ0/A5kZGT8AgAECPwOZGRk/II0NDT8DmRkZPwCAAQI/A5kZGT8gjQ0NPwOZGRk/AIABAj8DmRkZPyCNDQ0/A5kZGT8AgAECPwOZGRk/II0NDT8DmRkZPwCAAQI/A5kZGT8gjQ0NPwOZGRk/AIABAj8DmRkZPyCNDQ0/A5kZGT8AgAECPwOZGRk/II0NDT8DmRkZPwCAAQI/A5kZGT8gjQ0NPwOZGRk/AIABAj8DmRkZPyCNDQ0/A5kZGT8AgAECPwOZGRk/II0NDT8DmRkZPwCAAQI/A5kZGT8gjQ0NPwOZGRk/AIABAj8DmRkZPwDNDQ0/AOgoKD8ATQ0NPwDoKCg/AI0NDT8AqCgoPwCNDQ0/AKgoKD8BTQ0NPwDoKCg/AY0NDT8AqCgoPwBNDQ0/AOgoKD8ATQ0NPwDoKCg/AE0NDT8A6CgoPwBNDQ0/AOgoKD8ATQ0NPwDoKCg/AE0NDT8AqCgoPwDNDQ0/AKgoKD8ATQ0NPwDoKCg/EA0NDT8DmRkZPwCAAQI/A5kZGT8AzQ0NPwBoKCg/AE0NDT8AaCgoPwCNDQ0/AGgoKD8AjQ0NPwBoKCg/AM0NDT8AaCgoPwBNDQ0/AGgoKD8BTQ0NPwBoKCg/AE0NDT8AaCgoPwFNDQ0/AGgoKD8AzQ0NPwBoKCg/AE0NDT8AaCgoPwBNDQ0/AGgoKD8ATQ0NPwBoKCg/AI0NDT8AaCgoPwCNDQ0/AGgoKD8ATQ0NPwBoKCg/AI0NDT8AaCgoPwCNDQ0/AGgoKD8ATQ0NPwBoKCg/AE0NDT8AaCgoPwDNDQ0/AGgoKD8QjQ0NPwOZGRk/AIABAj8DmRkZPwDNDQ0/AOgoKD8AjQ0NPwBoKCg/AI0NDT8AaCgoPwDNDQ0/AGgoKD8ATQ0NPwBoKCg/AE0NDT8A6CgoPwBNDQ0/AOgoKD8BTQ0NPwBoKCg/AM0NDT8A6CgoPwBNDQ0/AKgoKD8AzQ0NPwBoKCg/AI0NDT8AqCgoPwDNDQ0/AGgoKD8AjQ0NPwBoKCg/AE0NDT8AaCgoPwBNDQ0/AGgoKD8AzQ0NPwCoKCg/EE0NDT8DmRkZPwCAAQI/A5kZGT8AzQ0NPwBoKCg/AQ0NDT8AaCgoPwCNDQ0/AGgoKD8AzQ0NPwBoKCg/AE0NDT8AaCgoPwFNDQ0/AGgoKD8ATQ0NPwBoKCg/AU0NDT8AaCgoPwDNDQ0/AGgoKD8ATQ0NPwBoKCg/AE0NDT8AaCgoPwBNDQ0/AGgoKD8AjQ0NPwBoKCg/AI0NDT8AaCgoPwBNDQ0/AGgoKD8AjQ0NPwBoKCg/AI0NDT8AaCgoPwBNDQ0/AGgoKD8ATQ0NPwBoKCg/AE0NDT8AaCgoPwBNDQ0/AGgoKD8QjQ0NPwOZGRk/AIABAj8DmRkZPwDNDQ0/AGgoKD8AzQ0NPwDoKCg/AI0NDT8AqCgoPwBNDQ0/AKgoKD8BjQ0NPwDoKCg/AY0NDT8AqCgoPwBNDQ0/AGgoKD8ATQ0NPwBoKCg/AE0NDT8AaCgoPwBNDQ0/AGgoKD8AjQ0NPwBoKCg/AI0NDT8AaCgoPwBNDQ0/AGgoKD8ATQ0NPwDoKCg/AE0NDT8A6CgoPwBNDQ0/AOgoKD8ATQ0NPwDoKCg/EA0NDT8DmRkZPwCAAQI/A5kZGT8gjQ0NPwOZGRk/AIABAj8DmRkZPyCNDQ0/A5kZGT8AgAECPwOZGRk/II0NDT8DmRkZPwCAAQI/J1kZGT8AQAECPwBZGRoAAEABAj8nGRkZPwBAAQI/AJkZGgAAQAECPybZGRk/AEABAj8A2RkaAABAAQI/JpkZGT8AQAECPwEZGRoAAEABAj8mWRkZPwBAAQI/AVkZGgAAQAECPyYZGRk/AEABAj8BmRkaAABAAQI/JdkZGT8AQAECPwIZGRoAAEABAj8lWRkZPwBAAQI/ApkZGgAAQAECPyTZGRk/AEABAj8DGRkaACTAAQI/ApkZGgA";

const ART = (function () {
  const bin = atob(ART_B64);
  const out = new Uint8Array(PNG_W * PNG_H * 4);
  let i = 0;
  for (let k = 0; k < bin.length; k += 5) {
    const n = bin.charCodeAt(k);
    for (let j = 0; j < n; j++) {
      const o = i * 4;
      out[o] = bin.charCodeAt(k + 1);
      out[o + 1] = bin.charCodeAt(k + 2);
      out[o + 2] = bin.charCodeAt(k + 3);
      out[o + 3] = bin.charCodeAt(k + 4);
      i++;
    }
  }
  return out;
})();

const FONT = {16:"077777",17:"007770",18:"007570",19:"005250",20:"005050",21:"005550",22:"046764",23:"013731",24:"001117",25:"074440",26:"027275",27:"000200",28:"021000",29:"033000",30:"000055",31:"000252",33:"020222",34:"000055",35:"057575",36:"027637",37:"051245",38:"075633",39:"000012",40:"021112",41:"024442",42:"052725",43:"002720",44:"012000",45:"000700",46:"020000",47:"012224",48:"075557",49:"072223",50:"071747",51:"074647",52:"044755",53:"074717",54:"075711",55:"044447",56:"075757",57:"044757",58:"002020",59:"012020",60:"042124",61:"007070",62:"012421",63:"020647",64:"061552",65:"057560",66:"075330",67:"061160",68:"035530",69:"061370",70:"011370",71:"075160",72:"057550",73:"072270",74:"032270",75:"055350",76:"061110",77:"055770",78:"055530",79:"035560",80:"017560",81:"063520",82:"053530",83:"034160",84:"022270",85:"065550",86:"027550",87:"077550",88:"052250",89:"034750",90:"071470",91:"031113",92:"042221",93:"064446",94:"000052",95:"070000",96:"000042",97:"055757",98:"075357",99:"061116",100:"075553",101:"071317",102:"011317",103:"075116",104:"055755",105:"072227",106:"032227",107:"055355",108:"071111",109:"055577",110:"055553",111:"035556",112:"011757",113:"063552",114:"055357",115:"034716",116:"022227",117:"065555",118:"027555",119:"077555",120:"055255",121:"074755",122:"071247",123:"062326",124:"022222",125:"032623",126:"001740",127:"002520",128:"007f7f7f7f7f",129:"00552a552a55",130:"003e5d5d7f41",131:"003e7763633e",132:"001144114411",133:"00101e1c3c04",134:"001c3e3e2e1c",135:"00081c3e3e36",136:"001c3677361c",137:"00141c3e1c1c",138:"003a2a7f3e1c",139:"003e6763673e",140:"007f417f5d7f",141:"000e0e080838",142:"003e636b633e",143:"00081c3e1c08",144:"000000550000",145:"003e7363733e",146:"00223e7f1c08",147:"003e1c081c3e",148:"003e6363773e",149:"000020520500",150:"0000442a1100",151:"003e6b776b3e",152:"007f007f007f",153:"005555555555",154:"00262d1e040e",155:"000225212111",156:"001c20201e0c",157:"001a24081e08",158:"0026453e044e",159:"000a12125f22",160:"0006113c081e",161:"00100c020c10",162:"001222227a22",163:"003c0200201e",164:"000c02103c08",165:"001c22020202",166:"00080c083e08",167:"001c02123f12",168:"0038047e103c",169:"003202320702",170:"001c100e020f",171:"00182040403e",172:"00100808103e",173:"003c02043808",174:"001878120732",175:"00720a02427a",176:"00666d4b3e09",177:"00327322271a",178:"004649494a3c",179:"001a3a123a12",180:"001c22226223",181:"004d2a08000c",182:"004021120c00",183:"005d3d11797d",184:"002e1e083c3e",185:"0010267e2406",186:"003c46044e24",187:"0030465a3c0a",188:"0038441e041e",189:"000808243e14",190:"00083052563a",191:"00061e041c04",192:"001c203e0208",193:"001820262222",194:"00307224183e",195:"0064262c3604",196:"00304224183e",197:"00122322271a",198:"0078281c640e",199:"00192b060204",200:"0008100e0000",201:"0004121f0a00",202:"000d150f0400",203:"000e060c0400",204:"00020414203e",205:"0008080e0830",206:"001820223e08",207:"003e0808083e",208:"001214187e10",209:"003222243e04",210:"00083e083e08",211:"00081022243c",212:"000810127c04",213:"003e2020203e",214:"001020247e24",215:"000c10262006",216:"00261810203e",217:"003804243e04",218:"000c10202422",219:"000c302d223e",220:"0004083e081c",221:"000c10202a2a",222:"0004083e001c",223:"0004241c0404",224:"000408083e08",225:"003e00001c00",226:"002c1028203e",227:"00085e303e08",228:"000e10202020",229:"004244242410",230:"001c02021e02",231:"000c1020203e",232:"00004021120c",233:"002a2a083e08",234:"00100814203e",235:"001e003e003c",236:"007e42240408",237:"000668102840",238:"003c041e041e",239:"000404243e04",240:"003e1010101c",241:"001e101e101e",242:"0018203e003e",243:"001020242424",244:"003254141414",245:"000e12220202",246:"003e2222223e",247:"000c1020223e",248:"0018203c203e",249:"000e10202006",250:"000608101500",251:"0004141e0400",252:"001e080c0000",253:"001c10181c00",254:"000810630408",255:"000804631008"};

const PAL6 = {};
for (let i = 0; i < 16; i++) {
  const c = PAL[i];
  PAL6[(c[0] & ~3) + "," + (c[1] & ~3) + "," + (c[2] & ~3)] = i;
}

function drawGlyphs(px, text, x0, y0) {
  let x = x0;
  for (let k = 0; k < text.length; k++) {
    const chi = text.charCodeAt(k);
    const w = chi >= 128 ? 8 : 4;
    if (x - x0 + w > 124) break;
    const g = FONT[chi];
    if (g) {
      const bits = parseInt(g, 16);
      for (let py = 0; py < 6; py++) {
        for (let cx = 0; cx < w; cx++) {
          if (bits & (1 << (py * w + cx))) {
            const o = ((y0 + py) * PNG_W + x + cx) * 4;
            px[o] = 252;
            px[o + 1] = 248;
            px[o + 2] = 240;
          }
        }
      }
    }
    x += w;
  }
}

function titleOf(code) {
  const lines = code.split("\n", 2);
  const out = ["", ""];
  for (let i = 0; i < 2; i++) {
    const m = i < lines.length ? lines[i].match(/^-- ?(.*)$/) : null;
    if (m) out[i] = m[1];
  }
  return out;
}

function encodePng(cart) {
  const data = cartToData(cart);
  const px = ART.slice();
  const label = cart.label;
  let hasLabel = false;
  for (let i = 0; i < 16384; i++)
    if (label[i]) {
      hasLabel = true;
      break;
    }
  if (hasLabel) {
    for (let y = 0; y < 128; y++) {
      for (let x = 0; x < 128; x++) {
        const c = PAL[label[y * 128 + x] & 15];
        const o = ((y + 24) * PNG_W + x + 16) * 4;
        px[o] = c[0] & ~3;
        px[o + 1] = c[1] & ~3;
        px[o + 2] = c[2] & ~3;
        px[o + 3] = 252;
      }
    }
  }
  const title = titleOf(cart.code);
  drawGlyphs(px, title[0], 18, 167);
  drawGlyphs(px, title[1], 18, 175);
  for (let i = 0; i < 0x8020; i++) {
    const o = i * 4;
    const b = data[i];
    px[o] |= (b >> 4) & 3;
    px[o + 1] |= (b >> 2) & 3;
    px[o + 2] |= b & 3;
    px[o + 3] |= (b >> 6) & 3;
  }
  return pngWrite(px, PNG_W, PNG_H);
}

async function decodePng(bytes) {
  const img = await pngRead(bytes);
  if (img.w !== PNG_W || img.h < PNG_H) {
    throw new Error("expected a " + PNG_W + "x" + PNG_H + "+ png cart, got " + img.w + "x" + img.h);
  }
  const data = new Uint8Array(0x8020);
  const count = Math.min(0x8020, img.w * img.h);
  for (let i = 0; i < count; i++) {
    const o = i * 4;
    data[i] =
      ((img.pixels[o] & 3) << 4) |
      ((img.pixels[o + 1] & 3) << 2) |
      (img.pixels[o + 2] & 3) |
      ((img.pixels[o + 3] & 3) << 6);
  }
  const cart = dataToCart(data);
  cart.label = newLabel();
  let empty = true;
  for (let y = 0; y < 128 && empty; y++) {
    for (let x = 0; x < 128; x++) {
      const o = ((y + 24) * img.w + x + 16) * 4;
      if (
        (img.pixels[o] & ~3) !== 136 ||
        (img.pixels[o + 1] & ~3) !== 136 ||
        (img.pixels[o + 2] & ~3) !== 136 ||
        (img.pixels[o + 3] & ~3) !== 252
      ) {
        empty = false;
        break;
      }
    }
  }
  if (!empty) {
    for (let y = 0; y < 128; y++) {
      for (let x = 0; x < 128; x++) {
        const o = ((y + 24) * img.w + x + 16) * 4;
        const r = img.pixels[o],
          g = img.pixels[o + 1],
          b = img.pixels[o + 2];
        const hit = PAL6[(r & ~3) + "," + (g & ~3) + "," + (b & ~3)];
        cart.label[y * 128 + x] = hit === undefined ? nearest(r, g, b) : hit;
      }
    }
  }
  return cart;
}

function sget(cart, x, y) {
  return x < 0 || x > 127 || y < 0 || y > 127 ? 0 : (cart.gfx[y * 64 + (x >> 1)] >> ((x & 1) * 4)) & 15;
}

function sset(cart, x, y, c) {
  if (x < 0 || x > 127 || y < 0 || y > 127) return;
  const i = y * 64 + (x >> 1);
  cart.gfx[i] = x & 1 ? (cart.gfx[i] & 15) | ((c & 15) << 4) : (cart.gfx[i] & 240) | (c & 15);
}

function mget(cart, x, y) {
  if (x < 0 || x > 127 || y < 0 || y > 63) return 0;
  return y < 32 ? cart.map[y * 128 + x] : cart.gfx[0x1000 + (y - 32) * 128 + x];
}

function mset(cart, x, y, v) {
  if (x < 0 || x > 127 || y < 0 || y > 63) return;
  if (y < 32) cart.map[y * 128 + x] = v & 255;
  else cart.gfx[0x1000 + (y - 32) * 128 + x] = v & 255;
}

function fget(cart, n) {
  return cart.gff[n & 255];
}

function fset(cart, n, v) {
  cart.gff[n & 255] = v & 255;
}

export {
  newCart,
  decodeP8,
  encodeP8,
  decodePng,
  encodePng,
  sget,
  sset,
  mget,
  mset,
  fget,
  fset,
  sfxNote,
  setSfxNote,
  PAL,
  nearest,
  FONT,
};
