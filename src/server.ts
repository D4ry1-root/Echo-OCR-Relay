import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import { createWorker, Worker } from "tesseract.js";
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";

// pdf-parse : on importe le fichier interne pour éviter un bug connu de sa version 1
const pdfParse = require("pdf-parse/lib/pdf-parse.js");

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, { maxHttpBufferSize: 20 * 1024 * 1024 });
const PORT = 3000;
const LANGUES = ["fra", "eng", "fra+eng"];
const EXT_TEXTE = [".txt", ".md", ".csv", ".json", ".log"];

/* ---------- Stockage sur le disque du PC (dossier "data") ---------- */
type Entree = {
  id: string;
  date: number;
  type: "photo" | "fichier" | "message";
  texte: string;
  confiance?: number;
  fichier?: string; // nom du fichier conservé
  nom?: string;     // nom d'origine (pour les fichiers importés)
};

const DOSSIER = path.join(process.cwd(), "data");
const FICHIERS = path.join(DOSSIER, "fichiers");
const FICHIER_HISTORIQUE = path.join(DOSSIER, "historique.json");
fs.mkdirSync(FICHIERS, { recursive: true });

let historique: Entree[] = [];
try {
  historique = JSON.parse(fs.readFileSync(FICHIER_HISTORIQUE, "utf8"));
} catch {
  historique = [];
}
const sauver = () => fs.writeFileSync(FICHIER_HISTORIQUE, JSON.stringify(historique));

function ajouter(entree: Entree) {
  historique.unshift(entree);
  sauver();
  io.emit("entree", entree);
}
function stocker(donnees: Buffer, extension: string): string {
  const nom = randomUUID() + extension;
  fs.writeFileSync(path.join(FICHIERS, nom), donnees);
  return nom;
}
function effacerFichier(nom?: string) {
  if (nom) fs.rm(path.join(FICHIERS, path.basename(nom)), { force: true }, () => {});
}
const dataUrlVersBuffer = (url: string) => Buffer.from(url.split(",")[1] ?? "", "base64");

/* ---------- OCR : un lecteur réutilisé + une file d'attente ---------- */
const lecteurs = new Map<string, Promise<Worker>>();
function obtenirLecteur(langue: string): Promise<Worker> {
  let lecteur = lecteurs.get(langue);
  if (!lecteur) {
    lecteur = createWorker(langue, 1, 
      { 
        cachePath: path.join(DOSSIER, "tesseract") 
      })
      .then(async (w) => {
        await w.setParameters({ user_defined_dpi: "300", preserve_interword_spaces: "1" });
        return w;
      })
      .catch((e) => {
        lecteurs.delete(langue);
        throw e;
      });
    lecteurs.set(langue, lecteur);
  }
  return lecteur;
}

let file: Promise<unknown> = Promise.resolve();
function enfiler<T>(tache: () => Promise<T>): Promise<T> {
  const p = file.then(tache);
  file = p.catch(() => {});
  return p;
}

// Supprime les lignes qui ressemblent à du bruit (peu de lettres et de chiffres)
function nettoyer(brut: string): string {
  return brut
    .split("\n")
    .filter((ligne) => {
      const s = ligne.replace(/\s/g, "");
      if (!s) return true;
      const utiles = (s.match(/[\p{L}\p{N}]/gu) ?? []).length;
      return s.length >= 2 && utiles / s.length >= 0.5;
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Essaie l'image traitée, puis l'originale si la confiance est faible, et garde la meilleure
async function lire(images: string[], langue: string) {
  const lecteur = await obtenirLecteur(langue);
  let meilleur = { texte: "", confiance: -1 };
  for (const image of images) {
    const { data } = await lecteur.recognize(image);
    if (data.confidence > meilleur.confiance) {
      meilleur = { texte: data.text, confiance: data.confidence };
    }
    if (data.confidence >= 75) break;
  }
  return { texte: nettoyer(meilleur.texte), confiance: Math.round(meilleur.confiance) };
}

/* ---------- Serveur ---------- */
app.use(express.static("public"));
app.use("/fichiers", express.static(FICHIERS));

io.on("connection", (socket) => {
  console.log("Un appareil s'est connecté");
  socket.emit("historique", historique);

  socket.on("nouveau-texte", (texte: string) => {
    if (typeof texte !== "string" || !texte.trim()) return;
    ajouter({ id: randomUUID(), date: Date.now(), type: "message", texte });
  });

  socket.on("photo", async (d: { traitee: string; originale: string; langue: string }) => {
    if (!d?.traitee?.startsWith("data:image/") || !d?.originale?.startsWith("data:image/")) return;
    const langue = LANGUES.includes(d.langue) ? d.langue : "fra";
    const fichier = stocker(dataUrlVersBuffer(d.originale), ".jpg"); // la photo est gardée quoi qu'il arrive
    io.emit("ocr-statut", "Lecture en cours...");
    let texte = "";
    let confiance = 0;
    try {
      ({ texte, confiance } = await enfiler(() => lire([d.traitee, d.originale], langue)));
    } catch (erreur) {
      console.error("Erreur OCR :", erreur);
      socket.emit("info", "La lecture a échoué, mais la photo est gardée.");
    }
    ajouter({ id: randomUUID(), date: Date.now(), type: "photo", texte, confiance, fichier });
    io.emit("ocr-statut", "");
  });

  socket.on("fichier", async (d: { nom: string; type: string; data: Buffer }) => {
    if (!Buffer.isBuffer(d?.data)) return;
    const nom = String(d.nom ?? "fichier").slice(0, 120);
    const extension = path.extname(nom).toLowerCase().replace(/[^.a-z0-9]/g, "").slice(0, 8);
    io.emit("ocr-statut", "Lecture du fichier...");
    try {
      let texte = "";
      if (extension === ".pdf") {
        texte = nettoyer((await pdfParse(d.data)).text ?? "");
        if (!texte) socket.emit("info", "Ce PDF n'a pas de texte (document scanné). Prends ses pages en photo.");
      } else if (EXT_TEXTE.includes(extension)) {
        texte = d.data.toString("utf8");
      } else {
        socket.emit("info", "Format non pris en charge. Essaie PDF, TXT, MD, CSV ou une image.");
        return;
      }
      ajouter({
        id: randomUUID(), date: Date.now(), type: "fichier", texte, nom,
        fichier: stocker(d.data, extension),
      });
    } catch (erreur) {
      console.error("Erreur fichier :", erreur);
      socket.emit("info", "Lecture du fichier impossible.");
    } finally {
      io.emit("ocr-statut", "");
    }
  });

  socket.on("supprimer", (id: string) => {
    const e = historique.find((x) => x.id === id);
    if (!e) return;
    effacerFichier(e.fichier);
    historique = historique.filter((x) => x.id !== id);
    sauver();
    io.emit("supprime", id);
  });

  socket.on("vider", () => {
    historique.forEach((e) => effacerFichier(e.fichier));
    historique = [];
    sauver();
    io.emit("vide");
  });
});

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log("Echo tourne sur le port " + PORT);
});
