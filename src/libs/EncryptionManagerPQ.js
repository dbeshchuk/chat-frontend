import { connect, rawStorage } from '@lo-fi/local-vault';
import '@lo-fi/local-vault/adapter/idb';
import { removeLocalAccount } from '@lo-fi/local-data-lock';
import * as secp from '@noble/secp256k1';
import { ml_dsa87 } from '@noble/post-quantum/ml-dsa.js';
import { ml_kem1024 } from '@noble/post-quantum/ml-kem.js';
import { sha3_512 } from '@noble/hashes/sha3';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { randomBytes } from '@noble/post-quantum/utils.js';
import { localDB } from '../utils/db/localDBv2';
import { signDigest, base64ToArray, arrayToBase64 } from './enigma';

const VAULT_KEY_OPTIONS = {
  authenticatorSelection: {
    authenticatorAttachment: "cross-platform",
    userVerification: "preferred",
    residentKey: "preferred",
    requireResidentKey: false
  },

  timeout: 60000,
}

/**
 * Class for managing encryption and data storage.
 * Implements the Singleton pattern to ensure a single instance.
 * Added support for events via EventTarget.
 * Supports two separate vaults: one for PQ signing keys and one for chat data.
 */
export class EncryptionManagerPQ extends EventTarget {
  static instance = null;

  #rawStore = rawStorage('idb');
  #currentVault = null;

  #localUserCards = []
  #currentUserHash = null;
  #signSkey = null;

  constructor() {
    super();

    console.log('Encryption manager created')

    if (EncryptionManagerPQ.instance) {
      return EncryptionManagerPQ.instance;
    }

    EncryptionManagerPQ.instance = this;

    this.#loadLocalUserCards()
  }

  static getInstance() {
    if (!EncryptionManagerPQ.instance) {
      EncryptionManagerPQ.instance = new EncryptionManagerPQ();
    }

    return EncryptionManagerPQ.instance;
  }

  get isAuth() {
    return !!this.#currentUserHash && !!this.#signSkey;
  }

  get currentUserHash() {
    return this.#currentUserHash;
  }

  async initialize() {
    try {
      const vaultID = await this.#rawStore.get('main-vault-id');

      if (vaultID) await this.#connectToUserVault(vaultID);

      this.#loadLocalUserCards()
    } catch (error) {
      await this.handleError(error, 'Error during storage initialization');
    }
  }

  // Vaults Management

  async createUserVault({ name, notes, avatar }) {
    const userVault = await connect({
      storageType: 'idb',
      addNewVault: true,
      keyOptions: { ...VAULT_KEY_OPTIONS, username: name, displayName: name }
    });

    const seed = randomBytes(32);

    const { publicKey: signPubKey, secretKey: signSkey } = ml_dsa87.keygen(seed);

    const { publicKey: cryptPubKey } = ml_kem1024.keygen();

    const contactPrivKey = secp.utils.randomPrivateKey();
    const contactPubKey = secp.getPublicKey(contactPrivKey, true);

    const prefixed = new Uint8Array([1, ...signPubKey]);
    const userHash = bytesToHex(sha3_512(prefixed));

    const cryptPubKeyB64 = arrayToBase64(cryptPubKey);

    const contactPrivKeyB64 = arrayToBase64(new Uint8Array(contactPrivKey));
    const cryptCert = await signDigest(cryptPubKeyB64, contactPrivKeyB64);

    const contactPubKeyB64 = arrayToBase64(new Uint8Array(contactPubKey));
    const contactCert = await signDigest(contactPubKeyB64, contactPrivKeyB64);
    const sign_b64 = await signDigest(contactPubKeyB64, contactPrivKeyB64);

    await userVault.set(`sign_skey`, signSkey);

    const identity = {
      user_hash: userHash,
      vaultId: userVault.id,
      name,
      sign_pkey: bytesToHex(signPubKey),
      crypt_pkey: cryptPubKeyB64,
      crypt_cert: cryptCert,
      contact_pkey: contactPubKeyB64,
      contact_cert: contactCert,
      sign_b64: sign_b64,

      userStorage: {
        avatar,
        notes
      }
    };

    this.#localUserCards.push(identity);

    await this.#saveLocalUserCards();

    await localDB.upsertUserLocal({
      user_hash: userHash,
      sign_pkey: identity.sign_pkey,
      crypt_pkey: identity.crypt_pkey,
      crypt_cert: identity.crypt_cert,
      contact_pkey: identity.contact_pkey,
      contact_cert: identity.contact_cert,
      name,
      deleted_flag: false,
      owner_timestamp: Date.now(),
      sign_b64
    });

    await this.login(userHash);

    return identity;
  }

  async #connectToUserVault(vaultId) {
    if (this.#currentVault && this.#currentVault.id === vaultId) {
      return this.#currentVault;
    }

    this.#currentVault = await connect({
      vaultID: vaultId,
      storageType: 'idb',
      keyOptions: VAULT_KEY_OPTIONS
    });

    return this.#currentVault;
  }

  // Authentification

  async login(userHash) {
    await this.#loadLocalUserCards();

    const identity = this.#localUserCards.find(i => i.user_hash === userHash);

    if (!identity) throw new Error(`User ${userHash} not found in local identities`);

    this.#currentVault = await connect({
      vaultID: identity.vaultId,
      storageType: 'idb',
      keyOptions: VAULT_KEY_OPTIONS
    });

    this.#signSkey = await this.#currentVault.get('sign_skey');

    if (this.#signSkey && typeof this.#signSkey === 'object' && !ArrayBuffer.isView(this.#signSkey)) {
      const values = Object.values(this.#signSkey).map(v => Number(v));
      this.#signSkey = new Uint8Array(values);
    }

    if (!(this.#signSkey instanceof Uint8Array)) {
      this.#signSkey = null;
      throw new Error('Failed to load secret key from vault');
    }

    this.#currentUserHash = userHash;

    console.log(`Logged in: ${identity.name} (${userHash})`);

    this.#dispatchAuthChange();

    return identity;
  }

  async logout() {
    if (this.#signSkey) {
      this.#signSkey.fill(0);
      this.#signSkey = null;
    }
    this.#currentUserHash = null;
    this.#currentVault = null;

    console.log('Logged out — secret key wiped');
    this.#dispatchAuthChange();
  }

  #dispatchAuthChange() {
    this.dispatchEvent(new CustomEvent('authChange', {
      detail: {
        isAuthenticated: this.isAuthenticated,
        userHash: this.#currentUserHash
      }
    }));
  }

  // Local Cards Methods

  async #loadLocalUserCards() {
    try {
      const data = await this.#rawStore.get('pq-vaults-registry');

      this.#localUserCards = Array.isArray(data) ? data : [];
    } catch (err) {
      console.error('Failed to load local user cards:', err);

      this.#localUserCards = [];
    }
  }

  async #saveLocalUserCards() {
    try {
      await this.#rawStore.set('pq-vaults-registry', this.#localUserCards);
    } catch (err) {
      console.error('Failed to save local user cards:', err);
    }
  }

  async getLocalUserCards() {
    await this.#loadLocalUserCards();

    return [...this.#localUserCards];
  }

  // Sign Challenge

  async signChallenge(challenge) {
    if (!this.#signSkey) {
      throw new Error('Not authenticated or secret key not loaded');
    }

    let msg = typeof challenge === 'string'
      ? Uint8Array.from(atob(challenge), c => c.charCodeAt(0))
      : challenge;

    return ml_dsa87.sign(msg, this.#signSkey);
  }

  // Update User Storage

  async updateUserStorage({ name, notes, avatar }) {
    if (!this.#currentUserHash) {
      throw new Error('No user is currently logged in');
    }

    const idx = this.#localUserCards.findIndex(u => u.user_hash === this.#currentUserHash);
    if (idx === -1) {
      throw new Error('User not found in local cards');
    }

    const current = this.#localUserCards[idx];

    this.#localUserCards[idx] = {
      ...current,
      name: name !== undefined ? name : current.name,
      userStorage: {
        ...current.userStorage,
        notes: notes !== undefined ? notes : current.userStorage?.notes,
        avatar: avatar !== undefined ? avatar : current.userStorage?.avatar
      }
    };

    await this.#saveLocalUserCards();

    return this.#localUserCards[idx];
  }
}