// Point d'entrée pour l'hébergement cPanel (Phusion Passenger) : son chargeur utilise require(),
// qui ne sait pas charger directement un module ES comme src/server.js.
import('./src/server.js').catch((err) => {
  console.error('Démarrage de l’API impossible :', err);
  process.exit(1);
});
