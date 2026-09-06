/* Minimal QR Code encoder — byte mode, error correction level M, versions 1–6.
 * Zero dependencies. Invite links (~90 chars) fit version 6-M (106 bytes).
 * API: makeQR(text) -> { version, size, mask, at(x,y) } or null if too long.
 * Works in browsers (global) and Node (module.exports) for self-tests.
 */
var makeQR = (function () {
'use strict';

// Per-version tables (index = version-1)
var DATA_CW  = [16, 28, 44, 64, 86, 108]; // data codewords
var EC_PER   = [10, 16, 26, 18, 24, 16];  // ec codewords per block
var BLOCKS   = [1, 1, 1, 2, 2, 4];        // number of blocks (equal size)
var CAPACITY = [14, 26, 42, 62, 84, 106]; // byte-mode capacity, EC-M
var ALIGN    = [[], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34]];
var REM_BITS = [0, 7, 7, 7, 7, 7];

// --- GF(256) with primitive poly x^8+x^4+x^3+x^2+1 ---
var EXP = new Array(512), LOG = new Array(256);
(function () {
  var x = 1, i;
  for (i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11D; }
  for (i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();
function gfMul(a, b) { return (a === 0 || b === 0) ? 0 : EXP[LOG[a] + LOG[b]]; }
function rsGen(deg) {
  var poly = [1], i, j, next;
  for (i = 0; i < deg; i++) {
    next = new Array(poly.length + 1).fill(0);
    for (j = 0; j < poly.length; j++) {
      next[j] ^= poly[j]; // × x (high-to-low order)
      next[j + 1] ^= gfMul(poly[j], EXP[i]); // × α^i
    }
    poly = next;
  }
  return poly;
}
function rsEncode(data, deg) {
  var gen = rsGen(deg);
  var res = data.concat(new Array(deg).fill(0));
  for (var i = 0; i < data.length; i++) {
    var c = res[i];
    if (c !== 0) for (var j = 0; j < gen.length; j++) res[i + j] ^= gfMul(gen[j], c);
  }
  return res.slice(data.length, data.length + deg);
}

function toBytes(text) {
  if (typeof TextEncoder !== 'undefined') return Array.from(new TextEncoder().encode(text));
  var out = [], i, c;
  for (i = 0; i < text.length; i++) {
    c = text.charCodeAt(i);
    if (c < 128) out.push(c);
    else if (c < 2048) out.push(192 | (c >> 6), 128 | (c & 63));
    else out.push(224 | (c >> 12), 128 | ((c >> 6) & 63), 128 | (c & 63));
  }
  return out;
}

function encodeData(bytes, dataCw) {
  var bits = [];
  function put(v, len) { for (var i = len - 1; i >= 0; i--) bits.push((v >>> i) & 1); }
  put(4, 4); // byte mode
  put(bytes.length, 8); // char count (versions 1-9)
  for (var i = 0; i < bytes.length; i++) put(bytes[i], 8);
  var cap = dataCw * 8;
  put(0, Math.min(4, cap - bits.length)); // terminator
  while (bits.length % 8 !== 0) bits.push(0);
  var cw = [];
  for (i = 0; i < bits.length; i += 8) {
    var b = 0;
    for (var k = 0; k < 8; k++) b = (b << 1) | bits[i + k];
    cw.push(b);
  }
  var pads = [236, 17], p = 0;
  while (cw.length < dataCw) { cw.push(pads[p % 2]); p++; }
  return cw;
}

// 15-bit format info for EC level M (00) + mask; BCH + standard XOR mask.
function formatBits(mask) {
  var data = mask & 7, g = 0x537, rem = data << 10, i;
  for (i = 14; i >= 10; i--) if ((rem >>> i) & 1) rem ^= g << (i - 10);
  return (((data << 10) | rem) ^ 0x5412) & 0x7FFF;
}

function maskBit(m, r, c) {
  switch (m) {
    case 0: return (r + c) % 2 === 0;
    case 1: return r % 2 === 0;
    case 2: return c % 3 === 0;
    case 3: return (r + c) % 3 === 0;
    case 4: return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
    case 5: return ((r * c) % 2 + (r * c) % 3) === 0;
    case 6: return (((r * c) % 2 + (r * c) % 3) % 2) === 0;
    default: return ((((r + c) % 2) + ((r * c) % 3)) % 2) === 0;
  }
}

function makeQR(text) {
  var bytes = toBytes(String(text));
  var vi = -1, i;
  for (i = 0; i < 6; i++) if (bytes.length <= CAPACITY[i]) { vi = i; break; }
  if (vi < 0) return null;
  var version = vi + 1, n = 4 * version + 17;
  var dataCw = DATA_CW[vi], ecPer = EC_PER[vi], nBlocks = BLOCKS[vi];

  // data codewords -> blocks -> RS -> interleave
  var data = encodeData(bytes, dataCw);
  var perBlock = dataCw / nBlocks, dBlocks = [], eBlocks = [];
  for (i = 0; i < nBlocks; i++) {
    var blk = data.slice(i * perBlock, (i + 1) * perBlock);
    dBlocks.push(blk);
    eBlocks.push(rsEncode(blk, ecPer));
  }
  var seq = [];
  for (i = 0; i < perBlock; i++) for (var b = 0; b < nBlocks; b++) seq.push(dBlocks[b][i]);
  for (i = 0; i < ecPer; i++) for (b = 0; b < nBlocks; b++) seq.push(eBlocks[b][i]);

  // function-module map + data placement order
  var fn = [], y, x;
  for (y = 0; y < n; y++) { fn.push([]); for (x = 0; x < n; x++) fn[y].push(false); }
  function finder(fx, fy) {
    for (y = -1; y <= 7; y++) for (x = -1; x <= 7; x++) {
      var xx = fx + x, yy = fy + y;
      if (xx < 0 || yy < 0 || xx >= n || yy >= n) continue;
      fn[yy][xx] = true;
    }
  }
  finder(0, 0); finder(n - 7, 0); finder(0, n - 7);
  // timing
  for (i = 8; i < n - 8; i++) { fn[6][i] = true; fn[i][6] = true; }
  // alignment
  var ap = ALIGN[vi];
  var zones = [{ x0: 0, y0: 0, x1: 8, y1: 8 }, { x0: n - 8, y0: 0, x1: n, y1: 8 }, { x0: 0, y0: n - 8, x1: 8, y1: n }];
  for (var ai = 0; ai < ap.length; ai++) for (var aj = 0; aj < ap.length; aj++) {
    var cx = ap[aj], cy = ap[ai], overlap = false;
    for (var z = 0; z < zones.length; z++) {
      if (cx + 2 >= zones[z].x0 && cx - 2 < zones[z].x1 && cy + 2 >= zones[z].y0 && cy - 2 < zones[z].y1) { overlap = true; break; }
    }
    if (overlap) continue;
    for (y = -2; y <= 2; y++) for (x = -2; x <= 2; x++) fn[cy + y][cx + x] = true;
  }
  // format info cells (both copies) + dark module
  var fmtCells = [];
  for (i = 0; i <= 5; i++) fmtCells.push([8, i]);
  fmtCells.push([8, 7]);
  fmtCells.push([8, 8]); fmtCells.push([7, 8]);
  for (i = 5; i >= 0; i--) fmtCells.push([i, 8]);
  for (i = 0; i < 7; i++) fmtCells.push([8, n - 1 - i]); // vertical strip, col 8
  for (i = 0; i < 8; i++) fmtCells.push([n - 8 + i, 8]); // horizontal strip, row 8
  for (i = 0; i < fmtCells.length; i++) fn[fmtCells[i][1]][fmtCells[i][0]] = true;
  fn[4 * version + 9][8] = true; // dark module

  // data placement order (zigzag, skipping function modules)
  var order = [], right, vert, j;
  for (right = n - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    var upward = ((right + 1) & 2) === 0;
    for (vert = 0; vert < n; vert++) {
      for (j = 0; j < 2; j++) {
        x = right - j;
        y = upward ? n - 1 - vert : vert;
        if (!fn[y][x]) order.push([x, y]);
      }
    }
  }

  // bit stream: codewords MSB-first + remainder zeros
  var bits = [];
  for (i = 0; i < seq.length; i++) for (j = 7; j >= 0; j--) bits.push((seq[i] >>> j) & 1);
  for (i = 0; i < REM_BITS[vi]; i++) bits.push(0);

  // try every mask, keep the most balanced (any mask decodes; balance scans best)
  var best = null;
  for (var m = 0; m < 8; m++) {
    var grid = [];
    for (y = 0; y < n; y++) { grid.push([]); for (x = 0; x < n; x++) grid[y].push(0); }
    // function patterns
    function drawFinder(fx, fy) {
      for (y = 0; y < 7; y++) for (x = 0; x < 7; x++) {
        var dark = (x === 0 || x === 6 || y === 0 || y === 6 || (x >= 2 && x <= 4 && y >= 2 && y <= 4));
        grid[fy + y][fx + x] = dark ? 1 : 0;
      }
    }
    drawFinder(0, 0); drawFinder(n - 7, 0); drawFinder(0, n - 7);
    for (i = 8; i < n - 8; i++) { grid[6][i] = i % 2 === 0 ? 1 : 0; grid[i][6] = i % 2 === 0 ? 1 : 0; }
    for (ai = 0; ai < ap.length; ai++) for (aj = 0; aj < ap.length; aj++) {
      cx = ap[aj]; cy = ap[ai]; overlap = false;
      for (z = 0; z < zones.length; z++) {
        if (cx + 2 >= zones[z].x0 && cx - 2 < zones[z].x1 && cy + 2 >= zones[z].y0 && cy - 2 < zones[z].y1) { overlap = true; break; }
      }
      if (overlap) continue;
      for (y = -2; y <= 2; y++) for (x = -2; x <= 2; x++) {
        grid[cy + y][cx + x] = (Math.abs(x) === 2 || Math.abs(y) === 2 || (x === 0 && y === 0)) ? 1 : 0;
      }
    }
    grid[4 * version + 9][8] = 1;
    // data + mask
    for (i = 0; i < order.length && i < bits.length; i++) {
      var bit = bits[i] ^ (maskBit(m, order[i][1], order[i][0]) ? 1 : 0);
      grid[order[i][1]][order[i][0]] = bit;
    }
    // format info
    var fb = formatBits(m);
    function fbit(k) { return (fb >>> k) & 1; }
    var copyA = [[8,0],[8,1],[8,2],[8,3],[8,4],[8,5],[8,7],[8,8],[7,8],[5,8],[4,8],[3,8],[2,8],[1,8],[0,8]];
    for (i = 0; i < 15; i++) grid[copyA[i][1]][copyA[i][0]] = fbit(14 - i);
    for (i = 0; i < 7; i++) grid[n - 1 - i][8] = fbit(14 - i);
    for (i = 0; i < 8; i++) grid[8][n - 8 + i] = fbit(7 - i);
    var dark = 0;
    for (y = 0; y < n; y++) for (x = 0; x < n; x++) dark += grid[y][x];
    var score = Math.abs(dark - (n * n) / 2);
    if (!best || score < best.score) best = { grid: grid, mask: m, score: score };
  }

  var final = best.grid;
  return {
    version: version, size: n, mask: best.mask,
    at: function (x, y) { return final[y][x]; },
    grid: final,
  };
}

makeQR._test = { rsEncode: rsEncode, formatBits: formatBits, CAPACITY: CAPACITY, DATA_CW: DATA_CW, EC_PER: EC_PER, BLOCKS: BLOCKS };
return makeQR;
})();

if (typeof module !== 'undefined' && module.exports) module.exports = makeQR;
