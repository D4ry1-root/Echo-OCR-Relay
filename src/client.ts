declare const io: typeof import("socket.io-client").io;
const socket = io();

let prenom = localStorage.getItem("echo-prenom") ?? "";
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

type Entree = {
  id: string;
  date: number;
  type: "photo" | "fichier" | "message";
  texte: string;
  confiance?: number;
  fichier?: string;
  nom?: string;
};

let historique: Entree[] = [];
let langue = localStorage.getItem("echo-langue") ?? "fra";

/* ---------- Navigation ---------- */
function aller(vue: string) {
  document.querySelectorAll<HTMLElement>(".vue").forEach((v) => {
    v.classList.toggle("actif", v.id === "vue-" + vue);
  });
  $("retour").hidden = vue === "accueil";
}
document.querySelectorAll<HTMLElement>("[data-vue]").forEach((el) => {
  el.addEventListener("click", () => aller(el.dataset.vue ?? "accueil"));
});
$("retour").addEventListener("click", () => aller("accueil"));

const heure = new Date().getHours();
function saluer() 
{
  const mot = heure >= 18 || heure < 5 ? "Bonsoir" : "Bonjour";
  $("salut").textContent = prenom ? `${mot} ${prenom}` : mot;
}
saluer();

/* ---------- Notification et copie ---------- */
function toast(message: string) {
  const t = $("toast");
  t.textContent = message;
  t.classList.add("visible");
  setTimeout(() => t.classList.remove("visible"), 2200);
}
async function copier(texte: string) {
  try {
    await navigator.clipboard.writeText(texte);
    toast("Copié ✓");
  } catch {
    toast("Copie bloquée : ouvre Echo via localhost");
  }
}

/* ---------- Cartes (historique + dernier résultat) ---------- */
function bouton(texte: string, action: () => void, classe = "btn"): HTMLButtonElement {
  const b = document.createElement("button");
  b.className = classe;
  b.textContent = texte;
  b.addEventListener("click", action);
  return b;
}

function carte(e: Entree): HTMLElement {
  const bloc = document.createElement("article");
  bloc.className = "carte";

  if (e.type === "photo" && e.fichier) {
    const img = document.createElement("img");
    img.src = "/fichiers/" + e.fichier;
    img.alt = "Photo scannée";
    img.loading = "lazy";
    bloc.append(img);
  }
  if (e.type === "fichier" && e.nom) {
    const nom = document.createElement("p");
    nom.className = "nom";
    nom.textContent = e.nom;
    bloc.append(nom);
  }

  const texte = document.createElement("p");
  texte.className = "texte";
  texte.textContent = e.texte || "Aucun texte détecté.";
  bloc.append(texte);

  if (e.type === "photo" && e.texte && (e.confiance ?? 100) < 60) {
    const alerte = document.createElement("p");
    alerte.className = "alerte";
    alerte.textContent = `Lecture peu fiable (${e.confiance} %). Rapproche-toi et évite les reflets.`;
    bloc.append(alerte);
  }

  const bas = document.createElement("div");
  bas.className = "bas";
  const date = document.createElement("time");
  date.textContent = new Date(e.date).toLocaleString("fr-FR", {
    day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit",
  });
  const actions = document.createElement("div");
  actions.className = "acts";

  if (e.texte) actions.append(bouton("Copier", () => copier(e.texte)));
  if (e.fichier) {
    const lien = document.createElement("a");
    lien.className = "btn";
    lien.href = "/fichiers/" + e.fichier;
    lien.download = e.nom ?? `echo-${new Date(e.date).toISOString().slice(0, 10)}.jpg`;
    lien.textContent = "Télécharger";
    actions.append(lien);
  }
  actions.append(bouton("Supprimer", () => socket.emit("supprimer", e.id), "btn danger"));

  bas.append(date, actions);
  bloc.append(bas);
  return bloc;
}

function afficher() {
  const ul = $("liste");
  ul.replaceChildren();
  $("vide").hidden = historique.length > 0;
  for (const e of historique) {
    const li = document.createElement("li");
    li.append(carte(e));
    ul.append(li);
  }
}

/* ---------- Événements du serveur ---------- */
socket.on("historique", (liste: Entree[]) => {
  historique = liste;
  afficher();
});
socket.on("entree", (e: Entree) => {
  historique.unshift(e);
  afficher();
  const dernier = $("dernier");
  dernier.replaceChildren(carte(e));
  dernier.hidden = false;
  toast(e.texte ? "Nouveau texte reçu" : "Reçu, mais aucun texte détecté");
});
socket.on("supprime", (id: string) => {
  historique = historique.filter((e) => e.id !== id);
  afficher();
  $("dernier").hidden = true;
});
socket.on("vide", () => {
  historique = [];
  afficher();
  $("dernier").hidden = true;
});
socket.on("info", (message: string) => toast(message));
socket.on("ocr-statut", (message: string) => {
  $("statut").textContent = message;
  $("ondes").classList.toggle("actif", message !== "");
});

$("tout-copier").addEventListener("click", () => {
  const textes = historique.map((e) => e.texte).filter(Boolean);
  if (textes.length) copier(textes.join("\n\n"));
});
$("vider").addEventListener("click", () => {
  if (confirm("Supprimer tout l'historique, photos comprises ?")) socket.emit("vider");
});

/* ---------- Écrire un message ---------- */
const champ = $<HTMLTextAreaElement>("champ");
$("bouton").addEventListener("click", () => {
  if (!champ.value.trim()) return;
  socket.emit("nouveau-texte", champ.value);
  champ.value = "";
});

/* ---------- Réglages ---------- */
const choixLangue = $<HTMLSelectElement>("langue");
choixLangue.value = langue;
choixLangue.addEventListener("change", () => {
  langue = choixLangue.value;
  localStorage.setItem("echo-langue", langue);
  toast("Langue enregistrée");
});

const champPrenom = $<HTMLInputElement>("prenom");
champPrenom.value = prenom;
champPrenom.addEventListener("input", () => {
  prenom = champPrenom.value.trim().slice(0, 30);
  localStorage.setItem("echo-prenom", prenom);
  saluer();
});

/* ---------- Préparation de l'image pour l'OCR ---------- */
function redimensionner(img: HTMLImageElement, cible: number, agrandirMax: number) {
  const cote = Math.max(img.naturalWidth, img.naturalHeight);
  const echelle = Math.min(agrandirMax, cible / cote);
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(img.naturalWidth * echelle);
  canvas.height = Math.round(img.naturalHeight * echelle);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas indisponible");
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return { canvas, ctx };
}

// Noir et blanc "adaptatif" : chaque pixel est comparé à la moyenne de son voisinage.
// Ça supprime les ombres et les éclairages inégaux. Texte clair sur fond sombre : on inverse.
function binariser(ctx: CanvasRenderingContext2D, w: number, h: number) {
  const image = ctx.getImageData(0, 0, w, h);
  const px = image.data;
  const gris = new Uint8ClampedArray(w * h);
  let total = 0;
  for (let i = 0, j = 0; i < px.length; i += 4, j++) {
    gris[j] = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
    total += gris[j];
  }
  if (total / (w * h) < 110) for (let j = 0; j < gris.length; j++) gris[j] = 255 - gris[j];

  const W = w + 1;
  const integrale = new Uint32Array(W * (h + 1));
  for (let y = 0; y < h; y++) {
    let ligne = 0;
    for (let x = 0; x < w; x++) {
      ligne += gris[y * w + x];
      integrale[(y + 1) * W + x + 1] = integrale[y * W + x + 1] + ligne;
    }
  }

  const r = Math.max(15, Math.round(Math.min(w, h) / 20));
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
      const somme = integrale[y1 * W + x1] - integrale[y0 * W + x1] - integrale[y1 * W + x0] + integrale[y0 * W + x0];
      const moyenne = somme / ((x1 - x0) * (y1 - y0));
      const v = gris[y * w + x] < moyenne * 0.85 ? 0 : 255;
      const k = (y * w + x) * 4;
      px[k] = px[k + 1] = px[k + 2] = v;
      px[k + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
}

function chargerImage(fichier: File): Promise<HTMLImageElement> {
  return new Promise((ok, ko) => {
    const img = new Image();
    img.onload = () => ok(img);
    img.onerror = () => ko(new Error("image illisible"));
    img.src = URL.createObjectURL(fichier);
  });
}

async function envoyerImage(fichier: File) {
  toast("Préparation de l'image…");
  const img = await chargerImage(fichier);
  const originale = redimensionner(img, 1800, 1).canvas.toDataURL("image/jpeg", 0.85);
  const { canvas, ctx } = redimensionner(img, 2400, 2);
  binariser(ctx, canvas.width, canvas.height);
  socket.emit("photo", { traitee: canvas.toDataURL("image/png"), originale, langue });
  URL.revokeObjectURL(img.src);
}

/* ---------- Photo, galerie, fichier ---------- */
function brancher(input: HTMLInputElement) {
  input.addEventListener("change", async () => {
    const f = input.files?.[0];
    if (!f) return;
    try {
      if (f.type.startsWith("image/")) {
        await envoyerImage(f);
      } else if (f.size > 15 * 1024 * 1024) {
        toast("Fichier trop lourd (15 Mo maximum)");
      } else {
        socket.emit("fichier", { nom: f.name, type: f.type, data: await f.arrayBuffer() });
      }
    } catch {
      toast("Fichier illisible");
    }
    input.value = ""; // permet de reprendre le même fichier
  });
}
brancher($<HTMLInputElement>("photo"));
brancher($<HTMLInputElement>("galerie"));
brancher($<HTMLInputElement>("fichier"));

/* ---------- Connexion ---------- */
const point = $("connexion");
const etat = $("etat-texte");
socket.on("connect", () => {
  point.classList.add("en-ligne");
  etat.textContent = "En ligne";
});
socket.on("disconnect", () => {
  point.classList.remove("en-ligne");
  etat.textContent = "Hors ligne";
});

export {};
