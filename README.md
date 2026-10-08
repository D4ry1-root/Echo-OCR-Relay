# Echo

Photographie un texte avec ton téléphone, retrouve-le instantanément sur ton ordinateur.

## Fonctionnalités
- Lecture de texte dans une photo (OCR avec Tesseract.js)
- Envoi en temps réel du téléphone vers le PC (Socket.IO)
- Import depuis la galerie, de PDF et de fichiers texte
- Historique avec photos téléchargeables

## Lancer le projet
Prérequis : Node.js (version LTS)

    npm install
    npm run dev

Ouvre ensuite http://localhost:3000. Pour le téléphone, utilise l'adresse IP
de ton PC sur le même Wi-Fi.

## Technologies
TypeScript, Node.js, Express, Socket.IO, Tesseract.js

## Avertissement
Echo n'a pas d'authentification : tout appareil du même réseau peut l'ouvrir.
À utiliser sur un réseau de confiance.