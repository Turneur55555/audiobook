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
const data = [ch("1", "Le Seuil — Tome 1", "fr", 1), ch("2", "Le Seuil — Tome 1", "fr", 2), ch("3", "Le Seuil — Tome 2", "en", 61), ch("5", "Autre", "fr", 1)];

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

const typeIn = (input: HTMLInputElement, v: string) => act(() => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, v);
  input.dispatchEvent(new Event("input", { bubbles: true }));
});

describe("Atelier : choix du tome", () => {
  it("demande d'abord le tome, puis dépose dedans et permet d'en changer", () => {
    const d = render(<Atelier chapters={data} onSaved={() => {}} />);
    expect(d.textContent).toContain("Dans quel tome déposer ?");
    expect(d.textContent).toContain("Le Seuil");
    expect(d.textContent).not.toContain("Importer des fichiers");
    click(d, "Tome 2");
    expect(d.textContent).toContain("Importer des fichiers");
    expect(d.textContent).toContain("1 épisode(s) déjà dedans");
    click(d, "Changer");
    expect(d.textContent).toContain("Dans quel tome déposer ?");
  });
  it("crée un nouveau tome d'un livre existant", () => {
    const d = render(<Atelier chapters={data} onSaved={() => {}} />);
    click(d, "Nouveau tome de « Le Seuil »");
    const [title, tome] = [...d.querySelectorAll("input")] as HTMLInputElement[];
    expect(title!.value).toBe("Le Seuil");
    typeIn(tome!, "Tome 3");
    click(d, "Créer et déposer dedans");
    expect(d.textContent).toContain("Tome 3");
    expect(d.textContent).toContain("0 épisode(s) déjà dedans");
    expect(JSON.parse(localStorage.getItem("atelier-livre")!)).toEqual({ series: "Le Seuil — Tome 3", lang: "fr" });
  });
  it("refuse un tome sans nom", () => {
    const d = render(<Atelier chapters={data} onSaved={() => {}} />);
    typeIn(d.querySelector("input")!, "Nouveau");
    click(d, "Créer et déposer dedans");
    expect(d.textContent).toContain("Indique le tome");
  });
});

describe("Bibliothèque : livre → tomes → épisodes", () => {
  const props = { currentId: null, isOwner: false, onPlay: () => {}, onToggleDone: () => {}, onEdit: async () => {}, onDelete: async () => {} };
  it("navigue sur trois niveaux et revient", () => {
    const d = render(<Library chapters={data} {...props} />);
    expect(d.textContent).toContain("Mes livres");
    expect(d.textContent).toContain("2 tome(s) · 3 épisode(s)");
    click(d, "Le Seuil");
    expect(d.textContent).toContain("Tome 1");
    expect(d.textContent).toContain("Tome 2");
    expect(d.textContent).not.toContain("T1");
    click(d, "Tome 2");
    expect(d.textContent).toContain("T3");
    expect(d.textContent).not.toContain("T1");
    click(d, "← Le Seuil");
    click(d, "← Mes livres");
    expect(d.textContent).toContain("Mes livres");
  });
  it("montre le titre même s'il n'y a qu'un seul livre", () => {
    const d = render(<Library chapters={data.slice(0, 2)} {...props} />);
    expect(d.textContent).toContain("Mes livres");
    expect(d.textContent).not.toContain("T1");
  });
});

describe("Renommer / fusionner un tome", () => {
  const base = { currentId: null, isOwner: true, onPlay: () => {}, onToggleDone: () => {}, onEdit: async () => {}, onDelete: async () => {} };
  const cs = [ch("1", "Tome 1", "fr", 1), ch("2", "Tome 1", "fr", 2), ch("3", "Le Seuil — Tome 1", "fr", 2)];
  const open = (d: HTMLElement, book: string, tome: string) => { click(d, book); click(d, tome); act(() => (d.querySelector('[aria-label="Renommer le tome"]') as HTMLButtonElement).click()); };

  it("range l'ancien « Tome 1 » sous un titre de livre", async () => {
    const onRenameBook = vi.fn(async () => {});
    const d = render(<Library chapters={cs.slice(0, 2)} {...base} onRenameBook={onRenameBook} />);
    open(d, "Tome 1", "Tome unique");
    const [title, tome] = [...d.querySelectorAll(".fixed input")] as HTMLInputElement[];
    expect(title!.value).toBe("Tome 1");
    typeIn(title!, "Le Seuil d'Astréon");
    typeIn(tome!, "Tome 1");
    expect(d.textContent).toContain("2 épisode(s) seront déplacés");
    await act(async () => { [...d.querySelectorAll("button")].find((b) => b.textContent === "Renommer")!.click(); });
    expect(onRenameBook).toHaveBeenCalledWith("tome 1|fr", "Le Seuil d'Astréon — Tome 1", "fr");
  });

  it("bloque la fusion si des numéros se chevauchent", () => {
    const d = render(<Library chapters={cs} {...base} onRenameBook={async () => {}} />);
    open(d, "Tome 1", "Tome unique");
    const [title, tome] = [...d.querySelectorAll(".fixed input")] as HTMLInputElement[];
    typeIn(title!, "Le Seuil");
    typeIn(tome!, "Tome 1");
    expect(d.textContent).toContain("les épisodes 2 existent déjà");
    expect([...d.querySelectorAll("button")].find((b) => b.textContent === "Fusionner")!.disabled).toBe(true);
  });

  it("n'affiche pas le bouton aux auditeurs", () => {
    const d = render(<Library chapters={cs.slice(0, 2)} {...base} isOwner={false} onRenameBook={async () => {}} />);
    click(d, "Tome 1"); click(d, "Tome unique");
    expect(d.querySelector('[aria-label="Renommer le tome"]')).toBeNull();
  });
});
