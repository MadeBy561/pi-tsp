import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isImagePath, mimeForImage, readImageFile } from "../src/clipboard.mjs";

// A valid 1x1 PNG, enough for the clipboard signature and file reader.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

test("clipboard images are recognized by signature", () => {
  assert.equal(mimeForImage(PNG), "image/png");
  assert.equal(mimeForImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0])), "image/jpeg");
  assert.equal(mimeForImage(Buffer.from("GIF89a\0\0\0\0\0\0")), "image/gif");
  assert.equal(mimeForImage(Buffer.from("not an image")), "");
});

test("image paths become RPC image blocks", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-tsp-clipboard-test-"));
  try {
    const file = join(dir, "pasted.png");
    writeFileSync(file, PNG);
    assert.equal(isImagePath(file), true);
    const image = readImageFile(file);
    assert.equal(image.type, "image");
    assert.equal(image.mimeType, "image/png");
    assert.equal(Buffer.from(image.data, "base64").equals(PNG), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
