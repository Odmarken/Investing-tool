/**
 * Riptide — utrullning till Firebase.
 *
 *   npm run fb:deploy                 allt: funktioner, regler och sidan
 *   npm run fb:functions              bara funktionerna
 *   node rulla-ut.js --only hosting   vad som helst annat firebase-tools tar
 *
 * Finns bara för två skavanker som kostade en misslyckad utrullning var:
 *
 * 1. Paketet heter firebase-tools, inte firebase. `npx firebase deploy` svarar
 *    "could not determine executable to run" om CLI:t inte är globalt
 *    installerat, vilket det sällan är.
 *
 * 2. Utrullningen startar en lokal server för att läsa av vilka funktioner som
 *    finns, och ger den tio sekunder. På en långsam maskin — eller när
 *    brandväggen tvekar om den lokala porten — hinner den inte, och deployen
 *    faller på "Cannot determine backend specification". Gränsen sätts av
 *    FUNCTIONS_DISCOVERY_TIMEOUT, och den kan inte skrivas som ett prefix i
 *    package.json: npm run kör via cmd.exe på Windows, och cmd förstår inte
 *    POSIX-syntaxen VAR=värde kommando. Därför den här filen.
 *
 * Sidan ligger också på GitHub Pages, som bara uppdateras vid push. En sida
 * från Pages som är äldre än molnfunktionen kan inte läsa det molnet skriver,
 * så efter en lyckad utrullning påminner skriptet om kod som inte är pushad.
 */
import { spawnSync, execSync } from 'node:child_process';

const r = spawnSync('npx', ['--yes', 'firebase-tools', 'deploy', ...process.argv.slice(2)], {
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, FUNCTIONS_DISCOVERY_TIMEOUT: process.env.FUNCTIONS_DISCOVERY_TIMEOUT || '120' }
});
if(r.status === 0){
  try{
    const git = cmd => execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if(git('git status --porcelain') || git('git rev-list --count @{u}..HEAD') !== '0')
      console.log('\nObs: GitHub Pages visar fortfarande den förra sidan. Committa och pusha (git push), annars kan sidan där inte läsa det molnet skriver.');
  }catch{ /* Ingen git eller ingen uppströmsgren: inget att påminna om. */ }
}
process.exit(r.status === null ? 1 : r.status);
