SITE R6 MULTI-ÉQUIPES - INSTALLATION RAPIDE

1) Ouvrir Firebase Console et créer un projet.
2) Activer Authentication > Sign-in method > Email/Password.
3) Activer Cloud Firestore.
4) Remplacer les règles Firestore par le contenu de FIRESTORE_RULES.txt puis cliquer sur Publier.
5) Ouvrir firebase-config.js et coller la configuration Web Firebase.
6) Envoyer le dossier du site sur Netlify Drop.

FONCTIONNEMENT
- Lorsqu'une personne crée son compte, elle choisit :
  A) Créer ma propre équipe : elle devient admin de cette équipe.
  B) Rejoindre une équipe : elle choisit une équipe existante et une demande est envoyée.
- L'admin de l'équipe voit les demandes dans l'onglet Admin et peut accepter joueur, accepter lecture seule ou refuser.
- Chaque équipe a ses propres matchs, disponibilités, planning, stats et historique.
- Les autres équipes ne voient pas les données de ton équipe.

IMPORTANT
- Ne pas utiliser l'agent IA Netlify : utiliser uniquement Netlify Drop pour éviter les crédits.
- Après remplacement des fichiers, faire Ctrl+F5 sur le site.
