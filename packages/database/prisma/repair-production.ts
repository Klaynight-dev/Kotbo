import path from 'node:path';
import { readdirSync } from 'node:fs';
import { config as loadEnv } from 'dotenv';
import { Client } from 'pg';

loadEnv({ path: path.resolve(import.meta.dir, '../../.env') });
loadEnv({ path: path.resolve(import.meta.dir, '../../../.env') });

const repairs = [
  "20260404193000_add_code_police_rules",
  "20260406090000_add_interest_profiles_and_feedback",
  "20260523000000_add_banned_words_table",
  "20260531000000_add_nickname_mod_granular_toggles",
  "20260706000000_add_custom_form_hierarchy",
  "20260706010000_add_ban_appeal_notify_dm",
  "20260706020000_add_tutoring_hierarchy_grade",
  "20260708000000_add_welcome_thread_system",
  "20260709000000_add_welcome_menu_page_actions",
  "20260709010000_add_verification_device_tracking",
  "20260720000000_add_welcome_exclusive_role_groups",
  "20260721160000_add_raid_protection_tables",
  "20260804120000_add_voice_captcha",
  "20260806120000_add_captcha_voice_locale",
  "20260806130000_add_captcha_verified_role",
];

async function run(command: string[]) {
  const process = Bun.spawn(command, {
    cwd: import.meta.dir + "/..",
    stdout: "inherit",
    stderr: "inherit",
  });

  return process.exited;
}

async function resolveApplied(migration: string) {
  const process = Bun.spawn(
    ["bun", "run", "prisma", "migrate", "resolve", "--applied", migration],
    {
      cwd: import.meta.dir + "/..",
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  const output = `${stdout}\n${stderr}`;

  if (exitCode === 0 || output.includes("P3008")) return;

  if (output.trim()) console.error(output.trim());
  throw new Error(`La reconciliation Prisma de ${migration} a echoue.`);
}

// 1. Check database URL and fetch already applied migrations to skip them
const connectionString = process.env.DATABASE_URL;
let appliedMigrations = new Set<string>();
let failedMigrations: string[] = [];
let isFreshDatabase = false;

if (connectionString) {
  try {
    const client = new Client({ connectionString });
    await client.connect();

    // Check if the _prisma_migrations table exists in database
    const tableCheck = await client.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = '_prisma_migrations'
      );
    `);

    if (tableCheck.rows[0].exists) {
      const res = await client.query(
        "SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL"
      );
      appliedMigrations = new Set(res.rows.map((row: any) => row.migration_name));
      isFreshDatabase = appliedMigrations.size === 0;

      // Une migration ni terminee ni annulee est une migration qui a echoue :
      // Prisma refuse alors d'en appliquer la moindre suivante (P3009), et le
      // deploiement reste bloque tant que quelqu'un ne passe pas la main
      // manuellement. Le delai de deux minutes ecarte une migration encore en
      // cours d'execution dans un deploiement concurrent.
      const failed = await client.query(`
        SELECT migration_name FROM _prisma_migrations
        WHERE finished_at IS NULL
          AND rolled_back_at IS NULL
          AND started_at < now() - interval '2 minutes'
        ORDER BY started_at
      `);
      failedMigrations = failed.rows.map((row: any) => row.migration_name);
    } else {
      isFreshDatabase = true;
    }
    await client.end();
  } catch (err: any) {
    console.warn(
      `[MigrationRepair] Impossible de vérifier les migrations existantes via pg: ${err.message}. Exécution complète par défaut.`
    );
  }
} else {
  console.warn("[MigrationRepair] DATABASE_URL non définie dans l'environnement. Exécution complète par défaut.");
}

// Sur une base neuve, les migrations normales doivent créer le schéma dans
// l'ordre. Les scripts de réparation ciblent uniquement des installations
// historiques et supposent notamment que la table `guilds` existe déjà.
if (isFreshDatabase) {
  console.log("[MigrationRepair] Base neuve détectée. Création du schéma courant et initialisation du baseline.");
  const pushCode = await run(["bun", "run", "prisma", "db", "push"]);
  if (pushCode !== 0) {
    throw new Error("L'initialisation du schéma d'une base neuve a échoué.");
  }

  const migrationsDir = path.resolve(import.meta.dir, "migrations");
  const migrations = readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  for (const migration of migrations) {
    await resolveApplied(migration);
  }
  console.log(`[MigrationRepair] Baseline initialisé avec ${migrations.length} migrations.`);
  process.exit(0);
}

// 2. Debloquer les migrations en echec.
//
// Postgres annule la transaction d'une migration qui echoue : la base ne
// contient donc rien de ce qu'elle voulait faire, et `--rolled-back` ne fait
// que le dire a Prisma pour qu'il la rejoue au prochain deploiement. Si la
// cause de l'echec n'a pas ete corrigee entre-temps, elle echouera de nouveau
// et le deploiement s'arretera - rien n'est masque.
if (failedMigrations.length > 0) {
  console.warn(
    `[MigrationRepair] ${failedMigrations.length} migration(s) en echec : ${failedMigrations.join(", ")}.`
  );
  for (const migration of failedMigrations) {
    console.warn(`[MigrationRepair] ${migration} marquee annulee, elle sera rejouee.`);
    const code = await run([
      "bun", "run", "prisma", "migrate", "resolve", "--rolled-back", migration,
    ]);
    if (code !== 0) {
      throw new Error(
        `Impossible de debloquer ${migration}. Verifiez son SQL avant de relancer le deploiement.`
      );
    }
  }
}

// 3. Filter repairs that haven't been applied yet
const repairsToRun = repairs.filter((migration) => !appliedMigrations.has(migration));

if (repairsToRun.length === 0) {
  console.log("[MigrationRepair] Toutes les réparations de production sont déjà appliquées. Passage rapide.");
  process.exit(0);
}

console.log(`[MigrationRepair] ${repairsToRun.length} réparation(s) à appliquer.`);

for (const migration of repairsToRun) {
  console.log(`[MigrationRepair] Reconciliation de ${migration}...`);

  const executeCode = await run([
    "bun",
    "run",
    "prisma",
    "db",
    "execute",
    "--file",
    `prisma/repairs/${migration}.sql`,
  ]);

  if (executeCode !== 0) {
    throw new Error(`La reparation SQL de ${migration} a echoue.`);
  }

  // Already-applied migrations return P3008; only that failure is safe to
  // suppress because the desired production state is exactly the same.
  await resolveApplied(migration);
}

console.log("[MigrationRepair] Historique de production reconcilie.");
