const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function crc32(buf) {
  let table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function makeChunk(type, data) {
  const typeBuf = Buffer.from(type);
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);

  const body = Buffer.concat([typeBuf, data]);
  const crcVal = crc32(body);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crcVal, 0);

  return Buffer.concat([lenBuf, body, crcBuf]);
}

function createPng(size) {
  const width = size;
  const height = size;

  // Scanlines: (1 byte filter (0) + width * 4 bytes RGBA) * height
  const rawData = Buffer.alloc((width * 4 + 1) * height);
  const center = size / 2;
  const radius = size * 0.44;

  let offset = 0;
  for (let y = 0; y < height; y++) {
    rawData[offset++] = 0; // Filter: None
    for (let x = 0; x < width; x++) {
      const dx = x - center;
      const dy = y - center;
      const dist = Math.sqrt(dx * dx + dy * dy);

      // Background rounded circle (Primary brand blue: #0A517D)
      if (dist <= radius) {
        // Spine accent orange arc / clock hand or letter 'S'
        const isClockBorder = dist >= radius - (size * 0.12);
        const isCenterDot = dist <= size * 0.1;
        const isHourHand = (x >= center - (size * 0.05) && x <= center + (size * 0.05) && y <= center && y >= center - (size * 0.28));
        const isMinuteHand = (y >= center - (size * 0.05) && y <= center + (size * 0.05) && x >= center && x <= center + (size * 0.32));

        if (isClockBorder) {
          // Orange ring: #EA580C
          rawData[offset++] = 234;
          rawData[offset++] = 88;
          rawData[offset++] = 12;
          rawData[offset++] = 255;
        } else if (isHourHand || isMinuteHand || isCenterDot) {
          // White clock hands
          rawData[offset++] = 255;
          rawData[offset++] = 255;
          rawData[offset++] = 255;
          rawData[offset++] = 255;
        } else {
          // Deep Blue Background: #0a517d
          rawData[offset++] = 10;
          rawData[offset++] = 81;
          rawData[offset++] = 125;
          rawData[offset++] = 255;
        }
      } else {
        // Transparent
        rawData[offset++] = 0;
        rawData[offset++] = 0;
        rawData[offset++] = 0;
        rawData[offset++] = 0;
      }
    }
  }

  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  // IHDR
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const ihdrChunk = makeChunk('IHDR', ihdr);
  const idatData = zlib.deflateSync(rawData);
  const idatChunk = makeChunk('IDAT', idatData);
  const iendChunk = makeChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([signature, ihdrChunk, idatChunk, iendChunk]);
}

const iconsDir = path.join(__dirname, 'icons');
if (!fs.existsSync(iconsDir)) {
  fs.mkdirSync(iconsDir, { recursive: true });
}

[16, 48, 128].forEach(size => {
  const png = createPng(size);
  fs.writeFileSync(path.join(iconsDir, `icon${size}.png`), png);
  console.log(`Generated icon${size}.png (${png.length} bytes)`);
});
