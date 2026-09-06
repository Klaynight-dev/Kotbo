-- Enchantements d'armes et d'armures, et passage de la progression d'equipement
-- de l'emplacement vers l'objet possede.
--
-- Avant : le niveau de forge vivait sur le profil, par emplacement
--         (weaponUpgrade / armorUpgrade / accessoryUpgrade). Deseequiper une arme
--         remettait sa progression a zero.
-- Apres : une instance par couple (profil, objet) porte le niveau de forge ET les
--         enchantements. La progression suit l'objet, pas le slot.
--
-- La migration reporte les niveaux de forge existants sur l'objet reellement porte,
-- pour qu'aucun joueur ne perde ce qu'il a paye.

CREATE TABLE IF NOT EXISTS "rpg_item_instances" (
    "id"           TEXT NOT NULL,
    "rpgProfileId" TEXT NOT NULL,
    "itemId"       TEXT NOT NULL,
    "upgrade"      INTEGER NOT NULL DEFAULT 0,
    "enchants"     JSONB NOT NULL DEFAULT '[]',
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rpg_item_instances_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "rpg_item_instances_rpgProfileId_itemId_key"
    ON "rpg_item_instances" ("rpgProfileId", "itemId");

DO $$
BEGIN
    ALTER TABLE "rpg_item_instances"
        ADD CONSTRAINT "rpg_item_instances_rpgProfileId_fkey"
        FOREIGN KEY ("rpgProfileId") REFERENCES "rpg_profiles" ("id")
        ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    ALTER TABLE "rpg_item_instances"
        ADD CONSTRAINT "rpg_item_instances_itemId_fkey"
        FOREIGN KEY ("itemId") REFERENCES "rpg_items" ("id")
        ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Parchemins d'enchantement : un objet de type SCROLL designe une entree du catalogue.
ALTER TABLE "rpg_items"
ADD COLUMN IF NOT EXISTS "enchantId"   TEXT,
ADD COLUMN IF NOT EXISTS "enchantTier" INTEGER NOT NULL DEFAULT 1;

-- Report des niveaux de forge existants sur l'objet porte dans chaque emplacement.
-- Les trois emplacements sont traites en une passe ; `ON CONFLICT` garde le meilleur
-- niveau si le meme objet occupait deux emplacements (donnee incoherente possible).
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'rpg_profiles' AND column_name = 'weaponUpgrade'
    ) THEN
        INSERT INTO "rpg_item_instances" ("id", "rpgProfileId", "itemId", "upgrade", "enchants", "createdAt", "updatedAt")
        SELECT gen_random_uuid()::text, p."id", slot."itemId", slot."upgrade", '[]'::jsonb, NOW(), NOW()
        FROM "rpg_profiles" p
        CROSS JOIN LATERAL (
            VALUES
                (p."weaponId",    p."weaponUpgrade"),
                (p."armorId",     p."armorUpgrade"),
                (p."accessoryId", p."accessoryUpgrade")
        ) AS slot("itemId", "upgrade")
        WHERE slot."itemId" IS NOT NULL
          AND EXISTS (SELECT 1 FROM "rpg_items" i WHERE i."id" = slot."itemId")
        ON CONFLICT ("rpgProfileId", "itemId") DO UPDATE
            SET "upgrade" = GREATEST("rpg_item_instances"."upgrade", EXCLUDED."upgrade");

        ALTER TABLE "rpg_profiles"
        DROP COLUMN IF EXISTS "weaponUpgrade",
        DROP COLUMN IF EXISTS "armorUpgrade",
        DROP COLUMN IF EXISTS "accessoryUpgrade";
    END IF;
END $$;
