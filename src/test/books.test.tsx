import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Atelier } from "@/components/audiobook/Atelier";
import { Library } from "@/components/audiobook/Library";
import type { Chapter } from "@/lib/chapters";

vi.mock("@/lib/supabase", () => ({ frError: String, insertChapter: vi.fn(), removeAudioQuietly: vi.fn(), uniqueAudioPath: vi.fn(), updateChapterContent: vi.fn(), uploadAudio: vi.fn() }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ch = (id: string, series: string, lang: "fr" | "en", episode: number): Chapter =>
  ({ id, title: `T${id}`, episode, series, lang, text: "Bonjour.", position: 0, createdAt: 0, updatedAt: 0 });
const data = [ch("1", "Tome 1", "fr", 1), ch("2", "Tome 1", "fr", 2), ch("3", "Book 2", "en", 61)];

function render(el: React.ReactElement) {
  const div = document.createElement("div");
  document.body.appendChild(div);
  const root = createRoot(div);
  act(() => root.render(el));
  return div;
}
const click = (div: HTMLElement, text: string) => {
  const b = [...div.querySelectorAll("button")].find((x) => x.textContent?.includes(text));
  if (!b) throw new Error(`bouton introuvable : ${text}`);
  act(() => b.click());
};
afterEach(() => { document.body.innerHTML = ""; localStorage.clear(); });

describe("Atelier : choix du livre", () => {
  it("demande d'abord le livre, puis dépose dedans et permet d'en changer", () => {
    const d = render(<Atelier chapters={data} onSaved={() => {}} />);
    expect(d.textContent).toContain("Dans quel livre déposer ?");
    expect(d.textContent).not.toContain("Importer des fichiers");
    click(d, "Book 2");
    expect(d.textContent).toContain("Importer des fichiers");
    expect(d.textContent).toContain("1 épisode(s) déjà dedans");
    click(d, "Changer");
    expect(d.textContent).toContain("Dans quel livre déposer ?");
  });
  it("crée un nouveau livre", () => {
    const d = render(<Atelier chapters={data} onSaved={() => {}} />);
    const input = d.querySelector("input")!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "Tome 3");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    click(d, "Créer et déposer dedans");
    expect(d.textContent).toContain("Tome 3");
    expect(d.textContent).toContain("0 épisode(s) déjà dedans");
  });
});

describe("Bibliothèque : étagère", () => {
  const props = { currentId: null, isOwner: false, onPlay: () => {}, onToggleDone: () => {}, onEdit: async () => {}, onDelete: async () => {} };
  it("montre les livres puis les épisodes du livre choisi", () => {
    const d = render(<Library chapters={data} {...props} />);
    expect(d.textContent).toContain("Mes livres");
    expect(d.textContent).not.toContain("T3");
    click(d, "Book 2");
    expect(d.textContent).toContain("T3");
    expect(d.textContent).not.toContain("T1");
    click(d, "Tous les livres");
    expect(d.textContent).toContain("Mes livres");
  });
  it("ouvre directement s'il n'y a qu'un livre", () => {
    const d = render(<Library chapters={data.slice(0, 2)} {...props} />);
    expect(d.textContent).not.toContain("Mes livres");
    expect(d.textContent).toContain("T1");
  });
});
