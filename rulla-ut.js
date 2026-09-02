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
 */
import { spawnSync } from 'node:child_process';

const r = spawnSync('npx', ['--yes', 'firebase-tools', 'deploy', ...process.argv.slice(2)], {
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, FUNCTIONS_DISCOVERY_TIMEOUT: process.env.FUNCTIONS_DISCOVERY_TIMEOUT || '120' }
});
process.exit(r.status === null ? 1 : r.status);
