// Script tạo icon PNG đơn giản cho Chrome Extension
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function createPng(size, r, g, b) {
  // Tạo hình vuông PNG với màu gradient đơn giản và chữ E ở giữa
  const width = size;
  const height = size;
  
  // Tạo raw RGBA buffer
  const rawData = Buffer.alloc(height * (1 + width * 4));
  
  for (let y = 0; y < height; y++) {
    const rowOffset = y * (1 + width * 4);
    rawData[rowOffset] = 0; // Filter type: None
    
    for (let x = 0; x < width; x++) {
      const pixelOffset = rowOffset + 1 + x * 4;
      
      // Tính toán bán kính bo tròn góc
      const radius = size * 0.22;
      const dx = Math.max(0, Math.max(radius - x, x - (width - 1 - radius)));
      const dy = Math.max(0, Math.max(radius - y, y - (height - 1 - radius)));
      const isInside = (dx * dx + dy * dy) <= radius * radius;
      
      if (!isInside) {
        // Trong suốt bên ngoài góc bo
        rawData[pixelOffset] = 0;
        rawData[pixelOffset + 1] = 0;
        rawData[pixelOffset + 2] = 0;
        rawData[pixelOffset + 3] = 0;
        continue;
      }

      // Màu nền gradient xanh dương - tím (#3B82F6 -> #1D4ED8)
      const grad = y / height;
      const red = Math.floor(r * (1 - grad * 0.3));
      const green = Math.floor(g * (1 - grad * 0.2));
      const blue = Math.floor(b);

      // Vẽ chữ "E" đơn giản ở giữa
      const cx = x / width;
      const cy = y / height;
      const isE = (
        (cx >= 0.28 && cx <= 0.40 && cy >= 0.25 && cy <= 0.75) || // Cột dọc
        (cx >= 0.28 && cx <= 0.72 && cy >= 0.25 && cy <= 0.37) || // Thanh ngang trên
        (cx >= 0.28 && cx <= 0.64 && cy >= 0.44 && cy <= 0.56) || // Thanh ngang giữa
        (cx >= 0.28 && cx <= 0.72 && cy >= 0.63 && cy <= 0.75)    // Thanh ngang dưới
      );

      if (isE) {
        // Màu trắng cho chữ E
        rawData[pixelOffset] = 255;
        rawData[pixelOffset + 1] = 255;
        rawData[pixelOffset + 2] = 255;
        rawData[pixelOffset + 3] = 255;
      } else {
        rawData[pixelOffset] = red;
        rawData[pixelOffset + 1] = green;
        rawData[pixelOffset + 2] = blue;
        rawData[pixelOffset + 3] = 255;
      }
    }
  }

  // Nén IDAT
  const compressed = zlib.deflateSync(rawData);

  // CRC32 helper
  function crc32(buf) {
    let table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = ((c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1));
      table[i] = c;
    }
    let crc = 0 ^ (-1);
    for (let i = 0; i < buf.length; i++) {
      crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xFF];
    }
    return (crc ^ (-1)) >>> 0;
  }

  function makeChunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, 'ascii');
    const typeAndData = Buffer.concat([typeBuf, data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(typeAndData), 0);
    return Buffer.concat([len, typeAndData, crc]);
  }

  // Header PNG
  const signature = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  
  // IHDR
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = 6; // color type RGBA
  ihdrData[10] = 0; // compression
  ihdrData[11] = 0; // filter
  ihdrData[12] = 0; // interlace
  const ihdrChunk = makeChunk('IHDR', ihdrData);

  // IDAT
  const idatChunk = makeChunk('IDAT', compressed);

  // IEND
  const iendChunk = makeChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([signature, ihdrChunk, idatChunk, iendChunk]);
}

const iconsDir = path.join(__dirname, 'icons');
if (!fs.existsSync(iconsDir)) {
  fs.mkdirSync(iconsDir, { recursive: true });
}

[16, 48, 128].forEach(size => {
  const pngBuf = createPng(size, 43, 114, 246); // Xanh dương hiện đại
  fs.writeFileSync(path.join(iconsDir, `icon${size}.png`), pngBuf);
  console.log(`Đã tạo icon${size}.png thành công`);
});
