import { PGliteWorker } from "@electric-sql/pglite/worker";
import { electricSync } from "@electric-sql/pglite-sync";
import { live } from "@electric-sql/pglite/live";
import schemaSQL from "./schemaV3.sql?raw";
import { api } from "../../api/client";
import { useOnlineStatus } from "../../composables/useOnlineStatus";

class LocalDBv2 {
  #getSignSkey = null;

  constructor() {
    this.isOnline = navigator.onLine;
    this.isLocalStash = false;
    this.db = null;
    this.syncEngine = null;
  }

  setAuthProvider(getSignSkey) {
    this.#getSignSkey = getSignSkey;
  }

  get instance() {
    return this.db;
  }

  async init() {
    console.log("→ Starting DB initialization");

    try {
      this.db = new PGliteWorker(
        new Worker(new URL("./pglite-worker.js?worker", import.meta.url), { type: "module" }),
        {
          extensions: {
            live,
            electric: electricSync({
              metadataSchema: "my_sync_metadata",
            }),
          },
        }
      );

      await this.db.exec(schemaSQL);

      // Skip migrations - columns should now exist from previous runs
      // Schema already has new columns in CREATE TABLE

      await this.initSyncEngine();

      const pending = await this.getPendingChanges();

      this.isLocalStash = pending.length > 0;

      this.syncEngine.stream.subscribe(() => {
        console.debug("user_cards_synced shape updated");

        if (this.isLocalStash) {
          setTimeout(() => {
            if (this.#getSignSkey) {
              this.sendPendingChanges(this.#getSignSkey());
            }
          }, 1200);
        }
      });

      console.log("→ DB initialized");
    } catch (err) {
      console.error("DB init failed:", err);
    }

    return this.db;
  }

  async initSyncEngine() {
    // Skip if already syncing
    if (this.syncEngine) return;

    try {
      const { setOffline } = useOnlineStatus();
      this.syncEngine = await this.db.electric.syncShapeToTable({
        shape: {
          url: new URL(`/api/user_card`, window.location.origin).toString(),
          params: {
            table: "user_cards",
          },
        },
        table: "user_cards_synced",
        primaryKey: ["user_hash"],
        shapeKey: "user_cards_public",
        onError: (error) => {
          console.error("Shape sync error:", error);
          setOffline();
        },
      });
    } catch (e) {
      if (e.message.includes('Already syncing')) {
        console.log('Shape sync already running');
      } else {
        throw e;
      }
    }
  }

  async getUsers() {
    if (!this.db) return [];
    const { rows } = await this.db.query(`SELECT * FROM user_cards ORDER BY name`);
    return rows;
  }

  async getUser(userHash) {
    if (!this.db) return null;
    const { rows } = await this.db.query(
      `SELECT * FROM user_cards WHERE user_hash = $1`,
      [userHash]
    );
    return rows[0] || null;
  }

  async getPendingChanges() {
    if (!this.db) return [];
    const { rows } = await this.db.query(`SELECT * FROM user_cards_local`);
    return rows;
  }

  async upsertUserLocal(userData) {
    const {
      user_hash,
      sign_pkey,
      crypt_pkey,
      crypt_cert,
      contact_pkey,
      contact_cert,
      name,
    } = userData;

    await this.db.query(
      `
      INSERT INTO user_cards_local (
        user_hash, sign_pkey, crypt_pkey, crypt_cert,
        contact_pkey, contact_cert, name, operation
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, 'insert')
      ON CONFLICT (user_hash) DO UPDATE SET
        sign_pkey     = EXCLUDED.sign_pkey,
        crypt_pkey    = EXCLUDED.crypt_pkey,
        crypt_cert   = EXCLUDED.crypt_cert,
        contact_pkey = EXCLUDED.contact_pkey,
        contact_cert = EXCLUDED.contact_cert,
        name       = EXCLUDED.name,
        operation  = 'update',
        changed_at = NOW()
      `,
      [user_hash, sign_pkey, crypt_pkey, crypt_cert, contact_pkey, contact_cert, name || ""]
    );

    this.isLocalStash = true;
  }

  async markUserAsDeletedLocal(userHash) {
    await this.db.query(
      `
      INSERT INTO user_cards_local (user_hash, operation)
      VALUES ($1, 'delete')
      ON CONFLICT (user_hash) DO UPDATE SET
        operation   = 'delete',
        changed_at  = NOW()
      `,
      [userHash]
    );

    this.isLocalStash = true;
  }

  async sendPendingChanges(signSkey) {
    if (!navigator.onLine || !this.isLocalStash) return;

    if (!signSkey) {
      console.warn('sign_skey required for sending pending changes');
      return;
    }

    const changes = await this.getPendingChanges();
    if (changes.length === 0) {
      this.isLocalStash = false;
      return;
    }

    const mutations = changes.map((row) => {
      if (row.operation === "insert") {
        const { mutation } = api.createUserCard(row.name, {
          user_hash: row.user_hash,
          sign_pkey: this.#base64ToArray(row.sign_pkey),
          contact_pkey: this.#base64ToArray(row.contact_pkey),
          contact_cert: this.#base64ToArray(row.contact_cert),
          crypt_pkey: this.#base64ToArray(row.crypt_pkey),
          crypt_cert: this.#base64ToArray(row.crypt_cert),
          sign_skey: signSkey,
        });
        return mutation;
      }

      if (row.operation === "update") {
        const ownerTimestamp = Math.floor(Date.now() / 1000);
        const { mutation } = api.createUserCard(row.name, {
          user_hash: row.user_hash,
          sign_pkey: this.#base64ToArray(row.sign_pkey),
          contact_pkey: this.#base64ToArray(row.contact_pkey),
          contact_cert: this.#base64ToArray(row.contact_cert),
          crypt_pkey: this.#base64ToArray(row.crypt_pkey),
          crypt_cert: this.#base64ToArray(row.crypt_cert),
          sign_skey: signSkey,
        });
        mutation.type = "update";
        return mutation;
      }

      return null;
    }).filter(Boolean);

    try {
      const resp = await api.ingestWithAuth(mutations, signSkey);
      const responseText = await resp.text();
      console.log('>>> Mutations sent:', JSON.stringify(mutations, null, 2));
      console.log('>>> Ingest response status:', resp.status);
      console.log('>>> Ingest response body:', responseText);
      if (!resp.ok) {
        console.warn('Ingest failed:', resp.status, responseText);
        return;
      }

      console.log(`→ Sent ${changes.length} local user changes`);
    } catch (err) {
      console.warn("→ Sync of local users failed, will retry later", err);
    }
  }

  #base64ToArray(base64) {
    if (!base64) return null;
    const binary = atob(base64);
    return Uint8Array.from(binary, c => c.charCodeAt(0));
  }

  async debugLocalState() {
    const users = await this.getUsers();

    const pending = await this.getPendingChanges();

    console.table({ syncedAndLocalView: users, pendingChanges: pending });
  }
}

export const localDB = new LocalDBv2();