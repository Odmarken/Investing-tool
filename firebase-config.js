/**
 * Riptide — var serverdelen finns.
 *
 * Här ligger inga nycklar. Sidan hämtar Firebase-konfigurationen i körningen:
 *
 *   1. Ligger sidan på Firebase Hosting serveras den automatiskt på
 *      /__/firebase/init.json — då kopplas Firestore in och kontot uppdateras
 *      i realtid.
 *   2. Ligger sidan någon annanstans (GitHub Pages, localhost) läses kontot i
 *      stället från apiBas + '/konto' vid varje uppdatering. Samma siffror,
 *      bara utan push.
 *
 * apiBas är en publik adress, inte en hemlighet.
 */
window.RIPTIDE_FIREBASE = {
  apiBas: 'https://europe-north1-riptide-investing-tool.cloudfunctions.net/api'
};
