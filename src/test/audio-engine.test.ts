import { describe, expect, it, vi } from "vitest";
import * as engine from "@/lib/audio-engine";

// jsdom has no media pipeline: metadata never loads, which is exactly the iOS case
// (no preload before a user gesture) that used to wipe the saved position.
describe("audio engine position", () => {
  it("keeps the requested start until metadata is loaded", () => {
    const onLeave = vi.fn();
    engine.setHooks({ getNext: () => null, onLeave, shouldStopAtEnd: () => false, onChapterEnded: () => {} });
    engine.loadChapter("a", "https://example.com/a.mp3", 125);
    expect(engine.position()).toBe(125);

    engine.loadChapter("b", "https://example.com/b.mp3", 40);
    expect(onLeave).toHaveBeenCalledWith("a", 125);
    expect(engine.position()).toBe(40);

    engine.stop();
    expect(onLeave).toHaveBeenLastCalledWith("b", 40);
  });
});

// iPhone before the first play: no metadata, duration NaN, currentTime 0.
describe("seeking before the audio is loaded (iPhone)", () => {
  it("moves the start position instead of jumping to 0", () => {
    engine.setHooks({ getNext: () => null, onLeave: () => {}, shouldStopAtEnd: () => false, onChapterEnded: () => {} });
    engine.loadChapter("c", "https://example.com/c.mp3", 125);
    expect(engine.seek(engine.position() + 15, 600)).toBe(140);
    expect(engine.position()).toBe(140);
    expect(engine.seek(engine.position() - 15, 600)).toBe(125);
    expect(engine.seek(180, 600)).toBe(180); // « aller à 3:00 »
    expect(engine.position()).toBe(180);
  });
  it("stays inside the episode", () => {
    engine.loadChapter("d", "https://example.com/d.mp3", 10);
    expect(engine.seek(-30, 600)).toBe(0);
    expect(engine.seek(9999, 600)).toBe(599.5);
    expect(engine.seek(NaN, 600)).toBe(0);
    engine.stop();
  });
});
