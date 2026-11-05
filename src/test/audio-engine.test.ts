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
