import { requireThat } from "../../shared/errors";

const invalid = "Choose a valid JPEG, PNG or WebP picture.";
const dimensions = (width: number, height: number) => {
  requireThat(
    width > 0 &&
      height > 0 &&
      width <= 8192 &&
      height <= 8192 &&
      width * height <= 20_000_000,
    400,
    "Choose a picture no larger than 8192 pixels per side and 20 megapixels.",
  );
};

/** Bounded format/container checks; this does not perform content moderation. */
export function validatePicture(bytes: Uint8Array, mime: string) {
  requireThat(
    bytes.length > 0 && bytes.length <= 5 * 1048576,
    400,
    "Choose a picture up to 5 MB.",
  );
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = (offset: number, length: number) =>
    String.fromCharCode(...bytes.subarray(offset, offset + length));
  const starts = (signature: number[]) =>
    signature.every((value, index) => bytes[index] === value);

  if (mime === "image/png") {
    requireThat(
      bytes.length >= 45 && starts([137, 80, 78, 71, 13, 10, 26, 10]),
      400,
      invalid,
    );
    requireThat(
      view.getUint32(8) === 13 && text(12, 4) === "IHDR",
      400,
      invalid,
    );
    dimensions(view.getUint32(16), view.getUint32(20));
    let offset = 8,
      data = false;
    while (offset + 12 <= bytes.length) {
      const length = view.getUint32(offset),
        kind = text(offset + 4, 4);
      requireThat(
        length <= bytes.length - offset - 12 && /^[A-Za-z]{4}$/.test(kind),
        400,
        invalid,
      );
      requireThat(
        kind !== "acTL",
        400,
        "Choose a still JPEG, PNG or WebP picture.",
      );
      if (kind === "IDAT" && length > 0) data = true;
      offset += length + 12;
      if (kind === "IEND") {
        requireThat(
          length === 0 && data && offset === bytes.length,
          400,
          invalid,
        );
        return;
      }
    }
    requireThat(false, 400, invalid);
  }

  if (mime === "image/jpeg") {
    requireThat(
      bytes.length >= 16 &&
        starts([255, 216, 255]) &&
        bytes.at(-2) === 255 &&
        bytes.at(-1) === 217,
      400,
      invalid,
    );
    let offset = 2,
      size = false;
    while (offset + 4 <= bytes.length) {
      requireThat(bytes[offset++] === 255, 400, invalid);
      while (bytes[offset] === 255) offset++;
      const marker = bytes[offset++];
      requireThat(offset + 2 <= bytes.length, 400, invalid);
      if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
      const length = view.getUint16(offset);
      requireThat(length >= 2 && length <= bytes.length - offset, 400, invalid);
      if (
        [
          192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207,
        ].includes(marker)
      ) {
        requireThat(length >= 8, 400, invalid);
        dimensions(view.getUint16(offset + 5), view.getUint16(offset + 3));
        size = true;
      }
      if (marker === 218) {
        requireThat(size && offset + length < bytes.length - 2, 400, invalid);
        return;
      }
      offset += length;
    }
    requireThat(false, 400, invalid);
  }

  requireThat(
    mime === "image/webp" &&
      bytes.length >= 20 &&
      text(0, 4) === "RIFF" &&
      text(8, 4) === "WEBP",
    400,
    invalid,
  );
  requireThat(view.getUint32(4, true) + 8 === bytes.length, 400, invalid);
  let offset = 12,
    image = false;
  let extended: [number, number] | undefined;
  while (offset + 8 <= bytes.length) {
    const kind = text(offset, 4),
      length = view.getUint32(offset + 4, true),
      at = offset + 8;
    requireThat(length <= bytes.length - at, 400, invalid);
    requireThat(
      kind !== "ANIM" && kind !== "ANMF",
      400,
      "Choose a still JPEG, PNG or WebP picture.",
    );
    if (kind === "VP8X") {
      requireThat(length === 10 && (bytes[at] & 2) === 0, 400, invalid);
      const u24 = (index: number) =>
        bytes[index] + bytes[index + 1] * 256 + bytes[index + 2] * 65536;
      extended = [u24(at + 4) + 1, u24(at + 7) + 1];
      dimensions(...extended);
    }
    if (kind === "VP8 " || kind === "VP8L") {
      requireThat(!image, 400, invalid);
      let width: number, height: number;
      if (kind === "VP8 ") {
        requireThat(
          length >= 10 &&
            (bytes[at] & 1) === 0 &&
            bytes[at + 3] === 157 &&
            bytes[at + 4] === 1 &&
            bytes[at + 5] === 42,
          400,
          invalid,
        );
        width = view.getUint16(at + 6, true) & 16383;
        height = view.getUint16(at + 8, true) & 16383;
      } else {
        requireThat(length >= 5 && bytes[at] === 47, 400, invalid);
        const bits = view.getUint32(at + 1, true);
        requireThat(bits >>> 29 === 0, 400, invalid);
        width = (bits & 16383) + 1;
        height = ((bits >>> 14) & 16383) + 1;
      }
      dimensions(width, height);
      if (extended)
        requireThat(
          extended[0] === width && extended[1] === height,
          400,
          invalid,
        );
      image = true;
    }
    offset = at + length + (length % 2);
  }
  requireThat(image && offset === bytes.length, 400, invalid);
}
