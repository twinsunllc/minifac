import { describe, expect, it } from "vitest";
import { ASCII_GLYPHS, UNICODE_GLYPHS, pickGlyphSet } from "./glyphs.js";

describe("pickGlyphSet", () => {
  it("returns unicode when LANG advertises UTF-8", () => {
    expect(pickGlyphSet({ LANG: "en_US.UTF-8" })).toBe("unicode");
  });
  it("returns unicode when LC_ALL advertises utf8", () => {
    expect(pickGlyphSet({ LC_ALL: "C.utf8" })).toBe("unicode");
  });
  it("returns unicode when LC_CTYPE advertises UTF-8", () => {
    expect(pickGlyphSet({ LC_CTYPE: "UTF-8" })).toBe("unicode");
  });
  it("returns ascii for C / POSIX locales", () => {
    expect(pickGlyphSet({ LANG: "C", LC_ALL: "C", LC_CTYPE: "C" })).toBe("ascii");
    expect(pickGlyphSet({ LANG: "POSIX" })).toBe("ascii");
  });
  it("returns ascii when env is empty", () => {
    expect(pickGlyphSet({})).toBe("ascii");
  });
  it("unicode and ascii glyph sets are distinct", () => {
    expect(UNICODE_GLYPHS.pending).not.toBe(ASCII_GLYPHS.pending);
    expect(UNICODE_GLYPHS.spinnerFrames[0]).not.toBe(ASCII_GLYPHS.spinnerFrames[0]);
  });
});
