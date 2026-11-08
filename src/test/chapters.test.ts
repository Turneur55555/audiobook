import { describe, expect, it } from "vitest";
import { episodeFrom, findSameEpisode, groupChapters, parseEpisode, slugify, sortChapters, splitEpisodeHeading, splitSentences, stripHeading, titleFromText, uniqueName, type Chapter } from "@/lib/chapters";
const makeChapter = (p: Partial<Chapter> & { title: string }): Chapter => ({ id: Math.random().toString(36), episode: null, series: "", lang: "fr", text: "", position: 0, createdAt: 0, updatedAt: 0, ...p });

describe("parseEpisode", () => {
  it("reads explicit episode keywords", () => {
    expect(parseEpisode("Episode 12 - Le retour.txt")).toBe(12);
    expect(parseEpisode("chapitre_03.md")).toBe(3);
  });
  it("ignores the tome number", () => {
    expect(parseEpisode("Tome 2 - 05 La forêt.txt")).toBe(5);
    expect(parseEpisode("Tome 2 Ep 7")).toBe(7);
  });
  it("returns null without a number", () => {
    expect(parseEpisode("Prologue.txt")).toBeNull();
  });
});

describe("sorting and grouping", () => {
  it("sorts by episode number, unnumbered last", () => {
    const cs = [
      makeChapter({ title: "b", episode: 10 }),
      makeChapter({ title: "a", episode: null }),
      makeChapter({ title: "c", episode: 2 }),
    ];
    expect(sortChapters(cs).map((c) => c.episode)).toEqual([2, 10, null]);
  });
  it("groups by tome and language", () => {
    const g = groupChapters([
      makeChapter({ title: "1", series: "Tome 1", lang: "fr" }),
      makeChapter({ title: "2", series: "Tome 1", lang: "en" }),
      makeChapter({ title: "3", series: "Tome 1", lang: "fr" }),
    ]);
    expect(g).toHaveLength(2);
  });
});

describe("splitSentences", () => {
  it("splits on punctuation", () => {
    expect(splitSentences("Bonjour. Ça va ? Oui !")).toEqual(["Bonjour.", "Ça va ?", "Oui !"]);
  });
});

describe("titles and paths", () => {
  it("takes the title from the first line and episode from it", () => {
    const t = titleFromText("\n\n# Épisode 4 — La forêt\nIl était…");
    expect(t).toBe("Épisode 4 — La forêt");
    expect(episodeFrom(t, "x.txt")).toBe(4);
    expect(episodeFrom("Le début", "Tome 1 - ep 9.txt")).toBe(9);
  });
  it("slugifies and avoids collisions", () => {
    expect(slugify("Été à Noël 2")).toBe("ete-a-noel-2");
    expect(uniqueName("a", ".mp3", new Set(["a.mp3", "a-2.mp3"]))).toBe("a-3.mp3");
  });
});

describe("re-import of an existing episode", () => {
  it("splits the episode heading into number and title", () => {
    expect(splitEpisodeHeading("Épisode 12 — Le titre")).toEqual({ episode: 12, title: "Le titre" });
    expect(splitEpisodeHeading("Épisode 1. Dernier de 480.")).toEqual({ episode: 1, title: "Dernier de 480" });
    expect(splitEpisodeHeading("Ce n'est pas moi")).toBeNull();
  });
  it("strips the markdown heading from the body", () => {
    expect(stripHeading("# Épisode 1 — X\n\nTexte.\n")).toBe("Texte.");
  });
  it("finds the same episode regardless of series case", () => {
    const cs = [
      makeChapter({ title: "a", series: "Tome 1", lang: "fr", episode: 3 }),
      makeChapter({ title: "b", series: "Tome 1", lang: "en", episode: 3 }),
    ];
    expect(findSameEpisode(cs, " tome 1 ", "fr", 3)?.title).toBe("a");
    expect(findSameEpisode(cs, "Tome 1", "fr", 4)).toBeUndefined();
    expect(findSameEpisode(cs, "Tome 1", "fr", null)).toBeUndefined();
  });
});

import { bookKey as _bookKey, groupChapters as _groupChapters } from "@/lib/chapters";
describe("livres", () => {
  it("la clé d'un livre correspond à celle des groupes", () => {
    const c = { id: "1", title: "a", episode: 1, series: " Tome 2 ", lang: "en" as const, text: "", position: 0, createdAt: 0, updatedAt: 0 };
    expect(_groupChapters([c])[0]!.key).toBe(_bookKey("tome 2", "en"));
  });
});

import { planBookRename } from "@/lib/chapters";
describe("planBookRename", () => {
  const cs = [
    makeChapter({ title: "a", series: "Tome 1", episode: 1 }),
    makeChapter({ title: "b", series: "Tome 1", episode: 2 }),
    makeChapter({ title: "c", series: "Tome 1 v2", episode: 2 }),
    makeChapter({ title: "d", series: "Tome 1 v2", episode: 3 }),
  ];
  it("renomme simplement vers un nom libre", () => {
    const r = planBookRename(cs, "tome 1|fr", "  Livre   Un ", "fr");
    expect(r).toMatchObject({ merge: false, series: "Livre Un", conflicts: [], same: false });
    expect(r.ids).toHaveLength(2);
  });
  it("fusionne avec un livre existant et signale les numéros en double", () => {
    const r = planBookRename(cs, "tome 1 v2|fr", "tome 1", "fr");
    expect(r).toMatchObject({ merge: true, series: "Tome 1", conflicts: [2] });
  });
  it("changer de langue vers un livre vide n'est pas une fusion", () => {
    expect(planBookRename(cs, "tome 1|fr", "Tome 1", "en")).toMatchObject({ merge: false, conflicts: [] });
  });
  it("détecte qu'il n'y a rien à faire", () => {
    expect(planBookRename(cs, "tome 1|fr", "Tome 1", "fr").same).toBe(true);
    expect(planBookRename(cs, "tome 1|fr", "TOME 1", "fr").same).toBe(false);
  });
});
