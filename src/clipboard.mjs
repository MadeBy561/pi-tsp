/**
 * Clipboard image/text reads without extra dependencies.
 *
 * Tern has no image-clipboard primitive, so the surface asks the host
 * clipboard directly: wl-paste/xclip on Linux, the pasteboard on macOS, and
 * PowerShell on Windows. Everything is argv-based (no shell interpolation)
 * and bounded so a stuck clipboard can never block the composer.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

function resultBuffer(result) {
  if (!result || result.error || result.status !== 0) return null;
  return Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout || "");
}

function run(bin, args, timeout = 1600) {
  return resultBuffer(spawnSync(bin, args, {
    encoding: "buffer",
    timeout,
    maxBuffer: MAX_IMAGE_BYTES + 1024 * 1024,
  }));
}

function runText(bin, args, timeout = 1600) {
  const result = spawnSync(bin, args, {
    encoding: "utf8",
    timeout,
    maxBuffer: 1024 * 1024,
  });
  if (!result || result.error || result.status !== 0) return "";
  return String(result.stdout || "");
}

export function mimeForImage(buffer) {
  if (!buffer || buffer.length < 12) return "";
  if (buffer[0] === 0x89 && buffer.toString("ascii", 1, 4) === "PNG") return "image/png";
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer.toString("ascii", 0, 3) === "GIF") return "image/gif";
  if (buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return "";
}

export function isImagePath(value) {
  if (!value) return false;
  let path = String(value).trim();
  if ((path.startsWith('"') && path.endsWith('"')) || (path.startsWith("'") && path.endsWith("'"))) {
    path = path.slice(1, -1);
  }
  if (path.startsWith("file://")) {
    try { path = decodeURIComponent(path.slice("file://".length)); } catch { return false; }
  }
  if (!path || !IMAGE_EXTENSIONS.has(extname(path).toLowerCase())) return false;
  try { return existsSync(path); } catch { return false; }
}

export function readImageFile(path) {
  const full = String(path || "").trim().replace(/^file:\/\//, "");
  if (!full || !IMAGE_EXTENSIONS.has(extname(full).toLowerCase())) return null;
  try {
    const stat = readFileSync(full);
    if (!stat.length || stat.length > MAX_IMAGE_BYTES) return null;
    const mimeType = mimeForImage(stat);
    if (!mimeType) return null;
    return {
      type: "image",
      data: stat.toString("base64"),
      mimeType,
      name: full.split(/[\\/]/).at(-1) || `image${extname(full)}`,
    };
  } catch {
    return null;
  }
}

function imageFromBuffer(buffer) {
  const mimeType = mimeForImage(buffer);
  if (!mimeType || !buffer.length || buffer.length > MAX_IMAGE_BYTES) return null;
  return {
    type: "image",
    data: buffer.toString("base64"),
    mimeType,
    name: `clipboard.${mimeType.split("/")[1].replace("jpeg", "jpg")}`,
  };
}

function readMacImage() {
  const stem = join(tmpdir(), `pi-tsp-clipboard-${process.pid}-${Date.now()}`);
  const pngPath = `${stem}.png`;
  const tiffPath = `${stem}.tiff`;
  const escapedPng = pngPath.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const escapedTiff = tiffPath.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const script = [
    "try",
    "  set pngData to the clipboard as «class PNGf»",
    `  set f to open for access POSIX file "${escapedPng}" with write permission`,
    "  set eof f to 0",
    "  write pngData to f",
    "  close access f",
    '  return "PNG"',
    "on error",
    "  try",
    "    set tiffData to the clipboard as «class TIFF»",
    `    set f to open for access POSIX file "${escapedTiff}" with write permission`,
    "    set eof f to 0",
    "    write tiffData to f",
    "    close access f",
    '    return "TIFF"',
    "  on error",
    '    return "NO"',
    "  end try",
    "end try",
  ].join("\n");
  const answer = runText("osascript", ["-e", script]);
  try {
    if (answer.includes("PNG")) return imageFromBuffer(readFileSync(pngPath));
    if (answer.includes("TIFF")) {
      runText("sips", ["-s", "format", "png", tiffPath, "--out", pngPath], 3000);
      return imageFromBuffer(readFileSync(pngPath));
    }
    return null;
  } catch {
    return null;
  } finally {
    for (const path of [pngPath, tiffPath]) {
      try { unlinkSync(path); } catch { /* temp file already gone */ }
    }
  }
}

function readMacFilePaths() {
  if (process.platform !== "darwin") return [];
  const script = [
    "on run",
    '  set output to ""',
    "  try",
    "    if (clipboard info for «class furl») is {} then return output",
    "    set theClip to the clipboard as «class furl»",
    "    if class of theClip is list then",
    "      repeat with anItem in theClip",
    "        try",
    "          set output to output & POSIX path of anItem & linefeed",
    "        end try",
    "      end repeat",
    "    else",
    "      try",
    "        set output to POSIX path of theClip & linefeed",
    "      end try",
    "    end if",
    "  end try",
    "  return output",
    "end run",
  ].join("\n");
  return runText("osascript", ["-e", script])
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function readWindowsImage() {
  const script = [
    "Add-Type -AssemblyName System.Windows.Forms",
    "Add-Type -AssemblyName System.Drawing",
    "$img=[System.Windows.Forms.Clipboard]::GetImage()",
    "if ($null -eq $img) { exit 2 }",
    "$ms=New-Object System.IO.MemoryStream",
    "$img.Save($ms,[System.Drawing.Imaging.ImageFormat]::Png)",
    "[Console]::Out.Write([Convert]::ToBase64String($ms.ToArray()))",
  ].join("; ");
  const output = runText("powershell.exe", ["-NoProfile", "-NonInteractive", "-STA", "-Command", script], 3000).trim();
  if (!output) return null;
  try { return imageFromBuffer(Buffer.from(output, "base64")); } catch { return null; }
}

export function readClipboardImage() {
  try {
    if (process.platform === "darwin") return readMacImage();
    if (process.platform === "win32") return readWindowsImage();
    if (process.platform !== "linux") return null;

    const wayland = Boolean(process.env.WAYLAND_DISPLAY || process.env.XDG_SESSION_TYPE === "wayland");
    if (wayland) {
      const types = runText("wl-paste", ["--list-types"]);
      for (const mime of ["image/png", "image/jpeg", "image/webp", "image/gif"]) {
        if (types.split(/\s+/).includes(mime)) {
          const image = imageFromBuffer(run("wl-paste", ["--type", mime]));
          if (image) return image;
        }
      }
    }
    for (const args of [
      ["-selection", "clipboard", "-t", "image/png", "-o"],
      ["-selection", "clipboard", "-o"],
    ]) {
      const image = imageFromBuffer(run("xclip", args));
      if (image) return image;
    }
    const image = imageFromBuffer(run("xsel", ["--clipboard", "--output"]));
    if (image) return image;
  } catch {
    /* clipboard tools are optional */
  }
  return null;
}

export function readClipboardFilePaths() {
  return readMacFilePaths();
}

export function readClipboardText() {
  try {
    if (process.platform === "darwin") return runText("pbpaste").replace(/\r?\n$/, "");
    if (process.platform === "win32") return runText("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Get-Clipboard -Raw"]).replace(/\r?\n$/, "");
    const wayland = Boolean(process.env.WAYLAND_DISPLAY || process.env.XDG_SESSION_TYPE === "wayland");
    if (wayland) {
      const text = runText("wl-paste", ["--type", "text", "--no-newline"]);
      if (text) return text;
    }
    const xclip = runText("xclip", ["-selection", "clipboard", "-o"]);
    if (xclip) return xclip.replace(/\r?\n$/, "");
    return runText("xsel", ["--clipboard", "--output"]).replace(/\r?\n$/, "");
  } catch {
    return "";
  }
}
