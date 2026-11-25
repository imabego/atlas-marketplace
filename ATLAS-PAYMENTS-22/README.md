# ATLAS — A World Without Limits

Version de démonstration locale avec catalogue, comptes, espace vendeur, panier, commandes et ATLAS PAYMENTS en mode sandbox.

## Démarrer sur Windows

1. Extraire le ZIP.
2. Ouvrir le dossier `ATLAS-PAYMENTS`.
3. Dans l'explorateur, cliquer sur la barre d'adresse, taper `cmd`, puis Entrée.
4. Exécuter `npm start`.
5. Ouvrir http://localhost:3000

Node.js récent est nécessaire. Aucune dépendance npm externe n'est requise.

## ATLAS PAYMENTS

Les moyens affichés (Orange Money, Airtel Money, M-Pesa et carte) sont uniquement des choix de démonstration. La confirmation est simulée localement. Aucun paiement, transfert ou débit réel n'est effectué.

La route de simulation est automatiquement bloquée lorsque `NODE_ENV=production`. Ne jamais activer la simulation en production et ne jamais présenter une transaction simulée comme un vrai paiement.

## Important avant toute mise en ligne réelle

Ce projet est un prototype pédagogique, pas une plateforme prête à encaisser de l'argent. Avant une mise en production : utiliser une base de données persistante et adaptée, des sessions persistantes et sécurisées, protections CSRF/rate limiting, validation renforcée, journalisation, sauvegardes, et intégrer un prestataire de paiement officiellement compatible. Les paiements réels doivent être confirmés côté serveur à partir d'un webhook signé ou d'une vérification serveur-à-serveur du prestataire. Ne jamais faire confiance à un statut envoyé par le navigateur.

Pour les contrats marchands, la vérification d'identité et les comptes de paiement, l'aide d'un parent ou tuteur est nécessaire.
