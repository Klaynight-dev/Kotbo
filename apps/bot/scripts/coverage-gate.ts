import { spawnSync } from 'node:child_process';

// TODO: augmenter progressivement ces seuils avec l'ajout de tests.
const minLines = Number(process.env.KOTBO_COVERAGE_LINES ?? '30');
const minFuncs = Number(process.env.KOTBO_COVERAGE_FUNCS ?? '32');

// --isolate : mock.module est global au process et n'est jamais annule, donc
// un mock partiel pose par un fichier casse les fichiers executes ensuite.
// --timeout : les tests qui decodent ou composent une image tiennent largement
// dans les 5 s par defaut seuls, mais pas quand toute la suite tourne en
// parallele, encore moins sous instrumentation de couverture.
// Doit rester aligne avec le script test:unit.
const run = spawnSync('bun', ['test', '--isolate', '--timeout', '30000', '--coverage', 'src/tests'], {
  cwd: process.cwd(),
  encoding: 'utf8',
  stdio: 'pipe',
});

const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;
process.stdout.write(output);

if (run.status !== 0) {
  process.exit(run.status ?? 1);
}

const match = output.match(/All files\s+\|\s+([0-9.]+)\s+\|\s+([0-9.]+)\s+\|/);
if (!match) {
  console.error('Impossible de lire la table de couverture Bun (ligne All files introuvable).');
  process.exit(1);
}

const funcs = Number(match[1]);
const lines = Number(match[2]);

if (Number.isNaN(funcs) || Number.isNaN(lines)) {
  console.error('Valeurs de couverture invalides.');
  process.exit(1);
}

if (funcs < minFuncs || lines < minLines) {
  console.error(
    `Seuil de couverture non atteint: fonctions=${funcs.toFixed(2)}% (min ${minFuncs}%), lignes=${lines.toFixed(2)}% (min ${minLines}%).`,
  );
  process.exit(1);
}

console.log(
  `Seuil de couverture valide: fonctions=${funcs.toFixed(2)}% (min ${minFuncs}%), lignes=${lines.toFixed(2)}% (min ${minLines}%).`,
);
