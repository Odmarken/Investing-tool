/* Ritar appikonen till build/icon.png (256×256) inför `npm run app:exe`:
   en mörk rundad ruta med en grön ring och en våg — Riptide. Ren Node, inga
   bildbibliotek: varje pixel räknas fram med 4×4 översampling. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const S = 256, SS = 4;
const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'build', 'icon.png');

const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const BG1 = [3, 9, 12], BG2 = [12, 34, 28], RING = [113, 232, 211], WAVE1 = [187, 255, 223], WAVE2 = [67, 214, 177];

function sample(x, y){
  // rundad ruta
  const r = 52, m = 8;
  const qx = Math.max(m + r - x, 0, x - (S - m - r)), qy = Math.max(m + r - y, 0, y - (S - m - r));
  if(Math.hypot(qx, qy) > r) return null;
  let c = mix(BG1, BG2, Math.min(1, Math.hypot(x - S * .7, y - S * .3) < 150 ? 1 - Math.hypot(x - S * .7, y - S * .3) / 150 : 0));
  const d = Math.hypot(x - S / 2, y - S / 2);
  if(Math.abs(d - 88) < 3.2) c = RING;                       // ringen
  else if(Math.abs(d - 100) < 1.2 && (Math.atan2(y - S / 2, x - S / 2) * 12 % 1 + 1) % 1 < .35) c = mix(BG2, RING, .6);   // prickad ytterring
  const wy = S / 2 + Math.sin((x - 40) / 176 * Math.PI * 2) * 30;
  if(x > 44 && x < 212 && Math.abs(y - wy) < 6.5) c = mix(WAVE1, WAVE2, (x - 44) / 168);   // vågen
  if(Math.hypot(x - 186, y - 76) < 9) c = WAVE1;             // signalpricken
  return c;
}

const raw = Buffer.alloc(S * (S * 4 + 1));
for(let y = 0; y < S; y++){
  raw[y * (S * 4 + 1)] = 0;
  for(let x = 0; x < S; x++){
    let r = 0, g = 0, b = 0, a = 0;
    for(let sy = 0; sy < SS; sy++) for(let sx = 0; sx < SS; sx++){
      const c = sample(x + (sx + .5) / SS, y + (sy + .5) / SS);
      if(c){ r += c[0]; g += c[1]; b += c[2]; a++; }
    }
    const o = y * (S * 4 + 1) + 1 + x * 4;
    raw[o] = a ? Math.round(r / a) : 0; raw[o + 1] = a ? Math.round(g / a) : 0; raw[o + 2] = a ? Math.round(b / a) : 0;
    raw[o + 3] = Math.round(a / (SS * SS) * 255);
  }
}

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for(let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = buf => { let c = 0xffffffff; for(const v of buf) c = crcTable[(c ^ v) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body));
  return Buffer.concat([len, body, sum]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4); ihdr[8] = 8; ihdr[9] = 6;
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, png);
console.log('Ikon: ' + OUT);
