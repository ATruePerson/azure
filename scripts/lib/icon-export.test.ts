import { assert, describe, it } from "@effect/vitest";

import {
  encodePngIcns,
  encodePngIco,
  MAC_ICNS_PNG_CHUNK_TYPES,
  readPngDimensions,
} from "./icon-export.ts";

const pngHeader = (width: number, height: number) => {
  const contents = Buffer.alloc(26);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(contents);
  contents.write("IHDR", 12, "ascii");
  contents.writeUInt32BE(width, 16);
  contents.writeUInt32BE(height, 20);
  contents[25] = 6;
  return contents;
};

describe("icon export", () => {
  it("reads dimensions from a PNG IHDR chunk", () => {
    assert.deepEqual(readPngDimensions(pngHeader(1024, 512)), { width: 1024, height: 512 });
  });

  it("encodes PNG renditions into an ICO directory", () => {
    const small = pngHeader(16, 16);
    const large = pngHeader(256, 256);
    const ico = encodePngIco([
      { size: 16, contents: small },
      { size: 256, contents: large },
    ]);

    assert.equal(ico.readUInt16LE(2), 1);
    assert.equal(ico.readUInt16LE(4), 2);
    assert.equal(ico.readUInt8(6), 16);
    assert.equal(ico.readUInt8(22), 0);
    assert.equal(ico.readUInt32LE(18), 38);
    assert.equal(ico.readUInt32LE(34), 38 + small.length);
    assert.deepEqual(ico.subarray(38, 38 + small.length), small);
    assert.deepEqual(ico.subarray(38 + small.length), large);
  });

  it("encodes the required transparent PNG renditions into ICNS chunks", () => {
    const icns = encodePngIcns(
      MAC_ICNS_PNG_CHUNK_TYPES.map(({ type, size }) => ({
        type,
        contents: pngHeader(size, size),
      })),
    );

    assert.equal(icns.toString("ascii", 0, 4), "icns");
    assert.equal(icns.readUInt32BE(4), icns.length);
    let offset = 8;
    for (const { type, size } of MAC_ICNS_PNG_CHUNK_TYPES) {
      assert.equal(icns.toString("ascii", offset, offset + 4), type);
      const chunkSize = icns.readUInt32BE(offset + 4);
      const png = icns.subarray(offset + 8, offset + chunkSize);
      assert.deepEqual(readPngDimensions(png), { width: size, height: size });
      assert.equal(png[25], 6);
      offset += chunkSize;
    }
    assert.equal(offset, icns.length);
  });

  it("rejects duplicate ICO rendition sizes", () => {
    assert.throws(
      () =>
        encodePngIco([
          { size: 32, contents: pngHeader(32, 32) },
          { size: 32, contents: pngHeader(32, 32) },
        ]),
      /provided more than once/,
    );
  });
});
