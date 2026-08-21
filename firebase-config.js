/**
 * Firebase-inställningar för dashboarden.
 *
 * De här nycklarna är publika av design — de pekar bara ut projektet och ger
 * ingen behörighet i sig. Säkerheten ligger i firestore.rules, som tillåter
 * läsning av kontot men inga skrivningar utifrån; bara molnfunktionen skriver.
 *
 * Töms projectId struntar sidan i Firebase och kör som förut: lokalt konto,
 * eller Cloudflare-workern om dess adress är inlagd under ⚙ Inställningar.
 */
window.RIPTIDE_FIREBASE = {
  apiKey: 'AIzaSyAkZHL7yl7JWdknEynEVAXxU9KSDrodq7M',
  authDomain: 'riptide-investing-tool.firebaseapp.com',
  projectId: 'riptide-investing-tool',
  appId: '1:508707147515:web:4d1db1cb1e0b6a9bf3aa5e',

  // Hela adressen till API-funktionen, så att den fungerar oavsett var sidan
  // ligger — Firebase Hosting, GitHub Pages eller localhost.
  apiBas: 'https://europe-north1-riptide-investing-tool.cloudfunctions.net/api'
};
